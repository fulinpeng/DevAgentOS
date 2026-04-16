import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clipLlmRawForRedis } from '../../../infrastructure/llm-log-meta';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  IWorkerExecutor,
  WorkerExecuteInput,
  WorkerExecuteOutput,
} from '../../role/infrastructure/worker.executor';
import { WorkflowLlmService } from '../../workflow/infrastructure/llm.service';
import {
  getWorkspaceRoot,
  resolveProjectRootFromTaskChain,
  resolveWorkerBaseDir,
} from '../infrastructure/resolve-output-dir';
import { FileContextService } from '../infrastructure/file-context.service';
import {
  buildWorkerUserContent,
  WORKER_TOOL_SYSTEM_PROMPT,
} from '../infrastructure/worker-llm.prompt';
import { RepairEngine } from '../repair/repair.engine';
import { getRunCommandFailureText } from '../repair/run-command-failure-text';
import {
  buildRepairSnapshot,
  type RepairContext,
  type RepairFailure,
  type RepairWorkflowOutline,
} from '../repair/repair.types';
import { ToolExecutor, type ToolExecuteResult } from '../tool/tool-executor';
import { normalizeAction } from '../tool/action-normalize';

function getDashScopeApiKey(config: ConfigService): string {
  return (
    config.get<string>('DASHSCOPE_API_KEY') ??
    config.get<string>('QWEN_API_KEY') ??
    ''
  ).trim();
}

export type WorkerLlmStep = {
  action: string;
  args: Record<string, unknown>;
};

type StepResultItem = {
  index: number;
  action: string;
  success: boolean;
  error?: string;
};

type StepExecutionOutcome =
  | { ok: true; stepResults: StepResultItem[] }
  | {
      ok: false;
      stepResults: StepResultItem[];
      failure: RepairFailure;
      timeout: boolean;
      remainingSteps: WorkerLlmStep[];
    };

/**
 * 解析 LLM 输出：优先 `steps[]`，否则兼容单条 `{ action, args }`。
 */
function parseWorkerLlmOutput(text: string): WorkerLlmStep[] | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return null;
    }
    const r = o as Record<string, unknown>;

    if (Array.isArray(r.steps) && r.steps.length > 0) {
      const out: WorkerLlmStep[] = [];
      for (const item of r.steps) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }
        const s = item as Record<string, unknown>;
        if (s.action === undefined || s.action === null) {
          return null;
        }
        const action = String(s.action).trim();
        if (!action) {
          return null;
        }
        const args =
          s.args && typeof s.args === 'object' && !Array.isArray(s.args)
            ? (s.args as Record<string, unknown>)
            : {};
        out.push({ action, args });
      }
      return out;
    }

    if (r.action !== undefined && r.action !== null) {
      const action = String(r.action).trim();
      if (!action) {
        return null;
      }
      const args =
        r.args && typeof r.args === 'object' && !Array.isArray(r.args)
          ? (r.args as Record<string, unknown>)
          : {};
      return [{ action, args }];
    }

    return null;
  } catch {
    return null;
  }
}

function stepsContainOnlyNoop(steps: WorkerLlmStep[]): boolean {
  return steps.every((s) => normalizeAction(s.action) === 'noop');
}

function parseWorkerResumeSteps(
  parameters: Record<string, unknown> | null,
): WorkerLlmStep[] | null {
  if (!parameters || typeof parameters !== 'object') {
    return null;
  }
  const raw = parameters.workerResumeSteps;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const out: WorkerLlmStep[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const s = item as Record<string, unknown>;
    if (s.action === undefined || s.action === null) {
      return null;
    }
    const action = String(s.action).trim();
    if (!action) {
      return null;
    }
    const args =
      s.args && typeof s.args === 'object' && !Array.isArray(s.args)
        ? (s.args as Record<string, unknown>)
        : {};
    out.push({ action, args });
  }
  return out.length > 0 ? out : null;
}

function isRunCommandTimeout(toolResult: ToolExecuteResult): boolean {
  const data = toolResult.data as { code?: string } | undefined;
  return (
    data?.code === 'run_command_timeout' ||
    toolResult.error === 'run_command_timeout'
  );
}

function extractTaskContext(task: WorkerExecuteInput): {
  taskDescription: string;
  goal: string;
} {
  const p = task.parameters;
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const r = p as Record<string, unknown>;
    const td =
      typeof r.taskDescription === 'string' ? r.taskDescription.trim() : '';
    const wg =
      typeof r.workflowGoal === 'string' ? r.workflowGoal.trim() : '';
    const g = typeof r.goal === 'string' ? r.goal.trim() : '';
    return {
      taskDescription: td || task.name,
      goal: wg || g || task.name,
    };
  }
  return { taskDescription: task.name, goal: task.name };
}

function extractRepairNarrative(
  task: WorkerExecuteInput,
): RepairContext['narrative'] {
  const p = task.parameters;
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const r = p as Record<string, unknown>;
    const td =
      typeof r.taskDescription === 'string' ? r.taskDescription.trim() : '';
    const wg =
      typeof r.workflowGoal === 'string' ? r.workflowGoal.trim() : '';
    const wd =
      typeof r.workflowDescription === 'string'
        ? r.workflowDescription.trim()
        : '';
    const g = typeof r.goal === 'string' ? r.goal.trim() : '';
    const goal = wg || g || task.name;
    return {
      taskName: task.name,
      taskRole: task.role,
      taskDescription: td || task.name,
      workflowGoal: goal,
      workflowDescription:
        wd || '（parameters 中无 workflowDescription，请结合 workflowGoal 与 taskDescription 推断）',
    };
  }
  return {
    taskName: task.name,
    taskRole: task.role,
    taskDescription: task.name,
    workflowGoal: task.name,
    workflowDescription:
      '（parameters 中无 workflowDescription，请结合 workflowGoal 与 taskDescription 推断）',
  };
}

function extractTechStacks(task: WorkerExecuteInput): {
  workflowTechStack: string[];
  taskTechStack: string[];
} {
  const p = task.parameters;
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const r = p as Record<string, unknown>;
    const wf = r.workflowTechStack;
    const tk = r.taskTechStack;
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? (v as string[])
        : [];
    return {
      workflowTechStack: asStrings(wf),
      taskTechStack: asStrings(tk),
    };
  }
  return { workflowTechStack: [], taskTechStack: [] };
}

/** 与 task parameters 中 techStack 对齐：此类任务应在步骤末尾通过 build 验证 */
function stacksSuggestFrontendBuild(
  workflowTechStack: string[],
  taskTechStack: string[],
): boolean {
  const blob = [...workflowTechStack, ...taskTechStack].join(' ').toLowerCase();
  return (
    blob.includes('vite') ||
    blob.includes('react') ||
    blob.includes('frontend') ||
    blob.includes('vue') ||
    blob.includes('svelte') ||
    blob.includes('preact')
  );
}

/** 任务参数未写 techStack 时，从项目 package.json 推断是否前端构建型（以便仍注入 build 校验） */
function packageJsonSuggestsFrontendBuild(baseDir: string): boolean {
  try {
    const fp = path.join(baseDir, 'package.json');
    if (!existsSync(fp)) {
      return false;
    }
    const raw = readFileSync(fp, 'utf8');
    const j = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dep = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
    const blob = Object.keys(dep).join(' ').toLowerCase();
    return (
      blob.includes('vite') ||
      blob.includes('react') ||
      blob.includes('vue') ||
      blob.includes('svelte') ||
      blob.includes('preact')
    );
  } catch {
    return false;
  }
}

function shouldInjectTerminalBuildVerify(
  workflowTechStack: string[],
  taskTechStack: string[],
  baseDir: string,
): boolean {
  return (
    stacksSuggestFrontendBuild(workflowTechStack, taskTechStack) ||
    packageJsonSuggestsFrontendBuild(baseDir)
  );
}

/** 本批最后一步是否已是会结束的 build（与自动注入的校验对齐） */
function lastStepIsTerminalBuildVerify(
  step: WorkerLlmStep | undefined,
): boolean {
  if (!step || normalizeAction(step.action) !== 'runCommand') {
    return false;
  }
  const cmd = String(step.args.command ?? '').trim().toLowerCase();
  if (!cmd) return false;
  return (
    cmd === 'pnpm run build' ||
    cmd.startsWith('pnpm run build ') ||
    cmd === 'npm run build' ||
    cmd.startsWith('npm run build ') ||
    cmd === 'yarn build' ||
    cmd.startsWith('yarn run build') ||
    /\bvite\s+build\b/.test(cmd) ||
    /\bpnpm\s+exec\s+vite\s+build\b/.test(cmd)
  );
}

const REPAIR_MAX_WRITE_FILES = 4;
const REPAIR_PROTECTED_PATHS = [
  'src/main.tsx',
  'src/app.tsx',
  'src/router/index.tsx',
  'src/router/routes.tsx',
  'package.json',
  'vite.config.ts',
] as const;

function normalizeRelPathForPolicy(pathLike: unknown): string {
  return String(pathLike ?? '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

function fingerprintRepairPlan(
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): string {
  const failureSig = `${failure.tool}|${String(failure.error ?? '').slice(0, 300)}`;
  const stepsSig = fixSteps.map((s) => `${normalizeAction(s.action)}:${JSON.stringify(s.args)}`);
  return `${failureSig}>>${stepsSig.join('||')}`;
}

function mentionsAnyPath(text: string, paths: readonly string[]): boolean {
  const t = text.toLowerCase().replace(/\\/g, '/');
  return paths.some((p) => t.includes(p.toLowerCase()));
}

function sanitizeRepairStepsByPolicy(
  failure: RepairFailure,
  steps: WorkerLlmStep[],
): { ok: true; steps: WorkerLlmStep[] } | { ok: false; reason: string } {
  const unique = new Set<string>();
  const deduped: WorkerLlmStep[] = [];
  for (const s of steps) {
    const key = `${normalizeAction(s.action)}:${JSON.stringify(s.args)}`;
    if (unique.has(key)) {
      continue;
    }
    unique.add(key);
    deduped.push(s);
  }
  if (deduped.length === 0) {
    return { ok: false, reason: 'repair plan empty after dedup' };
  }

  const writePaths = deduped
    .filter((s) => normalizeAction(s.action) === 'writeFile')
    .map((s) => normalizeRelPathForPolicy(s.args.path))
    .filter(Boolean);
  const writeSet = new Set(writePaths);
  if (writeSet.size > REPAIR_MAX_WRITE_FILES) {
    return {
      ok: false,
      reason: `repair writes too many files (${writeSet.size} > ${REPAIR_MAX_WRITE_FILES})`,
    };
  }

  if (writeSet.size > 0) {
    const failureText = getRunCommandFailureText(failure);
    const touchesProtected = Array.from(writeSet).filter((p) =>
      REPAIR_PROTECTED_PATHS.some((root) => p === root || p.endsWith(`/${root}`)),
    );
    if (
      touchesProtected.length > 0 &&
      !mentionsAnyPath(failureText, touchesProtected)
    ) {
      return {
        ok: false,
        reason: `repair touches protected files without direct error evidence: ${touchesProtected.join(', ')}`,
      };
    }
  }

  return { ok: true, steps: deduped };
}

function readRepairAttempts(config: ConfigService): number {
  const n = Number(config.get<string>('REPAIR_MAX_ATTEMPTS', '3'));
  if (!Number.isFinite(n) || n < 1) {
    return 3;
  }
  return Math.min(Math.floor(n), 8);
}

@Injectable()
export class WorkerExecutorService implements IWorkerExecutor {
  private readonly logger = new Logger(WorkerExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: WorkflowLlmService,
    private readonly toolExecutor: ToolExecutor,
    private readonly taskRedis: TaskRedis,
    private readonly fileContext: FileContextService,
    private readonly repairEngine: RepairEngine,
  ) {}

  async execute(task: WorkerExecuteInput): Promise<WorkerExecuteOutput> {
    const projectRootRaw = await resolveProjectRootFromTaskChain(
      this.prisma,
      task.parameters,
      task.parentId,
    );
    if (!projectRootRaw) {
      return {
        success: false,
        result: {
          error:
            '未配置 projectRoot：请在根任务的 parameters.projectRoot 中设置项目根目录（相对仓库根或本机绝对路径；子任务会继承父任务）。旧字段 outputDir 仍兼容。',
        },
      };
    }

    const workspaceRoot = getWorkspaceRoot(this.config);
    const { baseDir, projectRoot } = resolveWorkerBaseDir(
      workspaceRoot,
      projectRootRaw,
    );

    if (!existsSync(baseDir)) {
      try {
        await mkdir(baseDir, { recursive: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          result: { error: `worker_sandbox_mkdir_failed: ${msg}` },
        };
      }
    }

    const resumeSteps = parseWorkerResumeSteps(task.parameters);
    if (resumeSteps && resumeSteps.length > 0) {
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_resume',
        time: new Date().toISOString(),
        meta: {
          stepCount: resumeSteps.length,
          project_root: projectRoot,
        },
      });
      return this.runWorkerSteps(
        task,
        resumeSteps,
        baseDir,
        projectRoot,
      );
    }

    const apiKey = getDashScopeApiKey(this.config);

    if (!apiKey) {
      this.logger.log(
        `Worker LLM 未调用（无 API Key），taskId=${task.id}，使用 noop`,
      );
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_skipped',
        time: new Date().toISOString(),
        meta: { reason: 'no_dashscope_or_qwen_api_key' },
      });
      const toolResult = await this.toolExecutor.execute('noop', {}, baseDir);
      return {
        success: toolResult.success,
        result: {
          action: toolResult.tool,
          ...(toolResult.data ?? {}),
          ...(toolResult.error ? { error: toolResult.error } : {}),
        },
      };
    }

    const deepFileTree = this.fileContext.getFileTree(baseDir);
    const importantFiles = this.fileContext.getImportantFiles(baseDir);
    const includedFiles = Object.keys(importantFiles);

    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'file_context_generated',
      time: new Date().toISOString(),
      meta: {
        files_count: deepFileTree.length,
        included_files: includedFiles,
        project_root: projectRoot,
      },
    });

    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'worker_context_injected',
      time: new Date().toISOString(),
      meta: {
        project_root: projectRoot,
        fileTree: deepFileTree,
        files_count: deepFileTree.length,
        included_files: includedFiles,
      },
    });

    this.logger.log(
      `Worker LLM 将调用：taskId=${task.id} treeFiles=${deepFileTree.length} important=${includedFiles.length}`,
    );

    const { taskDescription, goal } = extractTaskContext(task);
    const { workflowTechStack, taskTechStack } = extractTechStacks(task);

    const user = buildWorkerUserContent({
      taskId: task.id,
      taskName: task.name,
      taskDescription,
      goal,
      role: task.role,
      workflowTechStack,
      taskTechStack,
      projectRoot,
      fileTreeDeep: deepFileTree,
      importantFiles,
    });
    let raw: string;
    try {
      raw = await this.llm.callLLM(WORKER_TOOL_SYSTEM_PROMPT, user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Worker LLM failed: ${msg}`);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_error',
        time: new Date().toISOString(),
        meta: { message: msg.slice(0, 300) },
      });
      return {
        success: false,
        result: { error: `worker_llm_failed: ${msg}` },
      };
    }

    const steps = parseWorkerLlmOutput(raw);
    if (!steps || steps.length === 0) {
      const clipped = clipLlmRawForRedis(this.config, raw);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_invalid_json',
        time: new Date().toISOString(),
        meta: {
          raw: clipped.text,
          rawChars: clipped.totalChars,
          rawTruncated: clipped.truncated,
        },
      });
      return {
        success: false,
        result: {
          error: 'worker_llm_invalid_json',
          raw: clipped.text,
          rawChars: clipped.totalChars,
          rawTruncated: clipped.truncated,
        },
      };
    }

    if (stepsContainOnlyNoop(steps)) {
      const clipped = clipLlmRawForRedis(this.config, raw);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_rejected_noop',
        time: new Date().toISOString(),
        meta: {
          raw: clipped.text,
          fileTree: deepFileTree,
          hint: '禁止 noop；请使用 steps 产出 runCommand/writeFile/createDirectory 等',
        },
      });
      return {
        success: false,
        result: {
          error: 'worker_llm_rejected_noop',
          message:
            '模型返回了 noop；当前策略要求必须产出可执行步骤（如 runCommand、writeFile）。',
          raw: clipped.text,
        },
      };
    }

    const clippedOk = clipLlmRawForRedis(this.config, raw);
    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'worker_llm_ok',
      time: new Date().toISOString(),
      meta: {
        stepCount: steps.length,
        raw: clippedOk.text,
        rawChars: clippedOk.totalChars,
        rawTruncated: clippedOk.truncated,
        fileTree: deepFileTree,
        files_count: deepFileTree.length,
        included_files: includedFiles,
      },
    });
    this.logger.log(
      `Worker LLM 已接入：steps=${steps.length} taskId=${task.id}`,
    );

    return this.runWorkerSteps(task, steps, baseDir, projectRoot);
  }

  /** 自当前任务沿 parent 链上至根，并取根下子任务作为「计划步骤」一览 */
  private async fetchWorkflowOutlineForRepair(
    taskId: string,
  ): Promise<RepairWorkflowOutline | undefined> {
    const chainSelect = {
      id: true,
      name: true,
      role: true,
      status: true,
      parentId: true,
    } satisfies Prisma.TaskSelect;
    type ChainRow = Prisma.TaskGetPayload<{ select: typeof chainSelect }>;

    try {
      const chain: Array<{
        id: string;
        name: string;
        role: string | null;
        status: string;
        parentId: string | null;
      }> = [];
      let currentId: string | null = taskId;
      const guard = new Set<string>();
      for (;;) {
        if (!currentId || guard.has(currentId)) break;
        guard.add(currentId);
        const idHere: string = currentId;
        const row: ChainRow | null = await this.prisma.task.findUnique({
          where: { id: idHere },
          select: chainSelect,
        });
        if (!row) break;
        chain.push({
          id: row.id,
          name: row.name,
          role: row.role,
          status: String(row.status),
          parentId: row.parentId,
        });
        currentId = row.parentId;
      }
      chain.reverse();
      const root = chain[0];
      if (!root) return undefined;
      const pathFromRoot = chain.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        status: row.status,
      }));
      const children = await this.prisma.task.findMany({
        where: { parentId: root.id },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, role: true, status: true },
      });
      return {
        rootTaskId: root.id,
        rootTaskName: root.name,
        pathFromRoot,
        planSteps: children.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          status: String(c.status),
        })),
      };
    } catch (e) {
      this.logger.warn(
        `fetchWorkflowOutlineForRepair: ${e instanceof Error ? e.message : e}`,
      );
      return undefined;
    }
  }

  private async executeStepsInternal(
    taskId: string,
    steps: WorkerLlmStep[],
    baseDir: string,
    projectRoot: string,
    indexOffset = 0,
  ): Promise<StepExecutionOutcome> {
    const stepResults: StepResultItem[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const index = indexOffset + i;
      await this.taskRedis.appendExecutionLog(taskId, {
        step: 'step_start',
        time: new Date().toISOString(),
        meta: { index, action: step.action, args: step.args, project_root: projectRoot },
      });
      const toolResult = await this.toolExecutor.execute(step.action, step.args, baseDir);
      if (toolResult.success) {
        await this.taskRedis.appendExecutionLog(taskId, {
          step: 'step_success',
          time: new Date().toISOString(),
          meta: { index, tool: toolResult.tool, data: toolResult.data },
        });
        stepResults.push({ index, action: toolResult.tool, success: true });
        if (toolResult.tool === 'writeFile') {
          await this.taskRedis.appendExecutionLog(taskId, {
            step: 'file_written',
            time: new Date().toISOString(),
            meta: toolResult.data,
          });
        }
        continue;
      }
      await this.taskRedis.appendExecutionLog(taskId, {
        step: 'step_fail',
        time: new Date().toISOString(),
        meta: { index, tool: toolResult.tool, error: toolResult.error },
      });
      stepResults.push({
        index,
        action: toolResult.tool,
        success: false,
        error: toolResult.error,
      });
      const timeout = isRunCommandTimeout(toolResult);
      if (timeout) {
        await this.taskRedis.appendExecutionLog(taskId, {
          step: 'step_timeout',
          time: new Date().toISOString(),
          meta: { index, tool: toolResult.tool, project_root: projectRoot },
        });
      }
      return {
        ok: false,
        stepResults,
        timeout,
        remainingSteps: steps.slice(i),
        failure: {
          stepIndex: index,
          step,
          tool: toolResult.tool,
          error: toolResult.error,
          data: (toolResult.data ?? {}) as Record<string, unknown>,
        },
      };
    }
    return { ok: true, stepResults };
  }

  private async runWorkerSteps(
    task: WorkerExecuteInput,
    steps: WorkerLlmStep[],
    baseDir: string,
    projectRoot: string,
  ): Promise<WorkerExecuteOutput> {
    const { workflowTechStack, taskTechStack } = extractTechStacks(task);
    const narrative = extractRepairNarrative(task);
    const maxAttempts = readRepairAttempts(this.config);
    let allResults: StepResultItem[] = [];
    let currentSteps = [...steps];
    let attempt = 0;
    const history: RepairContext['history'] = [];
    const seenRepairPlanFingerprints = new Set<string>();

    while (true) {
      const run = await this.executeStepsInternal(
        task.id,
        currentSteps,
        baseDir,
        projectRoot,
        allResults.length,
      );
      allResults = [...allResults, ...run.stepResults];

      let effectiveRun: StepExecutionOutcome = run;

      if (
        run.ok &&
        shouldInjectTerminalBuildVerify(
          workflowTechStack,
          taskTechStack,
          baseDir,
        ) &&
        currentSteps.length > 0 &&
        !lastStepIsTerminalBuildVerify(
          currentSteps[currentSteps.length - 1],
        )
      ) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'post_verify_build_injected',
          time: new Date().toISOString(),
          meta: {
            reason:
              'techStack suggests frontend; last step was not terminal build — enforcing pnpm run build',
          },
        });
        const verifyStep: WorkerLlmStep = {
          action: 'runCommand',
          args: { command: 'pnpm run build' },
        };
        const vRun = await this.executeStepsInternal(
          task.id,
          [verifyStep],
          baseDir,
          projectRoot,
          allResults.length,
        );
        allResults = [...allResults, ...vRun.stepResults];
        if (!vRun.ok) {
          effectiveRun = vRun;
        }
      }

      if (effectiveRun.ok) {
        const last = allResults[allResults.length - 1];
        return {
          success: true,
          result: {
            mode: 'steps',
            stepsExecuted: allResults.length,
            steps: allResults,
            lastAction: last?.action,
            action: last?.action,
            repair: buildRepairSnapshot({
              state: history.length > 0 ? 'succeeded' : 'idle',
              attempt,
              maxAttempts,
              history,
            }),
          },
        };
      }

      if (effectiveRun.timeout) {
        return {
          success: false,
          result: {
            workerPaused: true,
            pauseReason: 'run_command_timeout',
            failedAtIndex: effectiveRun.failure.stepIndex,
            remainingSteps: effectiveRun.remainingSteps,
            mode: 'steps',
            steps: allResults,
            error: effectiveRun.failure.error,
            lastTool: effectiveRun.failure.tool,
            projectRoot,
            repair: buildRepairSnapshot({
              state: 'active',
              attempt,
              maxAttempts,
              lastFailure: effectiveRun.failure,
              remainingSteps: effectiveRun.remainingSteps,
              history,
            }),
          },
        };
      }

      if (attempt >= maxAttempts) {
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: effectiveRun.failure.stepIndex,
            steps: allResults,
            error: effectiveRun.failure.error,
            lastTool: effectiveRun.failure.tool,
            repair: buildRepairSnapshot({
              state: 'exhausted',
              attempt,
              maxAttempts,
              lastFailure: effectiveRun.failure,
              remainingSteps: effectiveRun.remainingSteps,
              history,
            }),
          },
        };
      }

      attempt += 1;
      const workflowOutline = await this.fetchWorkflowOutlineForRepair(task.id);
      const context: RepairContext = {
        taskId: task.id,
        projectRoot,
        workflowTechStack,
        taskTechStack,
        attempt,
        maxAttempts,
        remainingSteps: effectiveRun.remainingSteps,
        failure: effectiveRun.failure,
        history,
        narrative,
        ...(workflowOutline ? { workflowOutline } : {}),
        executedStepsPreview: allResults.map((r) => ({
          index: r.index,
          action: r.action,
          success: r.success,
          ...(r.error ? { error: r.error } : {}),
        })),
      };
      const plan = await this.repairEngine.planFixSteps(context);
      if (!plan || plan.fixSteps.length === 0) {
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: effectiveRun.failure.stepIndex,
            steps: allResults,
            error: effectiveRun.failure.error,
            lastTool: effectiveRun.failure.tool,
            repair: buildRepairSnapshot({
              state: 'exhausted',
              attempt,
              maxAttempts,
              lastFailure: effectiveRun.failure,
              remainingSteps: effectiveRun.remainingSteps,
              history,
            }),
          },
        };
      }
      const sanitized = sanitizeRepairStepsByPolicy(
        effectiveRun.failure,
        plan.fixSteps,
      );
      if (!sanitized.ok) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'repair_plan_rejected',
          time: new Date().toISOString(),
          meta: {
            attempt,
            reason: sanitized.reason,
            skillId: plan.skillId,
            category: plan.category,
          },
        });
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: effectiveRun.failure.stepIndex,
            steps: allResults,
            error: `repair_plan_rejected: ${sanitized.reason}`,
            lastTool: effectiveRun.failure.tool,
            repair: buildRepairSnapshot({
              state: 'exhausted',
              attempt,
              maxAttempts,
              lastFailure: effectiveRun.failure,
              remainingSteps: effectiveRun.remainingSteps,
              history,
              selectedSkill: {
                skillId: plan.skillId,
                score: plan.score,
                category: plan.category,
                reason: plan.reason,
              },
            }),
          },
        };
      }
      plan.fixSteps = sanitized.steps;
      const repairPlanFp = fingerprintRepairPlan(
        effectiveRun.failure,
        plan.fixSteps,
      );
      if (seenRepairPlanFingerprints.has(repairPlanFp)) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'repair_plan_dedup_hit',
          time: new Date().toISOString(),
          meta: {
            attempt,
            skillId: plan.skillId,
            category: plan.category,
          },
        });
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: effectiveRun.failure.stepIndex,
            steps: allResults,
            error: 'repair_plan_dedup_hit',
            lastTool: effectiveRun.failure.tool,
            repair: buildRepairSnapshot({
              state: 'exhausted',
              attempt,
              maxAttempts,
              lastFailure: effectiveRun.failure,
              remainingSteps: effectiveRun.remainingSteps,
              history,
              selectedSkill: {
                skillId: plan.skillId,
                score: plan.score,
                category: plan.category,
                reason: 'duplicate repair plan detected',
              },
            }),
          },
        };
      }
      seenRepairPlanFingerprints.add(repairPlanFp);

      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'repair_plan_selected',
        time: new Date().toISOString(),
        meta: {
          attempt,
          maxAttempts,
          skillId: plan.skillId,
          category: plan.category,
          score: plan.score,
          reason: plan.reason,
          fixStepsCount: plan.fixSteps.length,
        },
      });

      const fixRun = await this.executeStepsInternal(
        task.id,
        plan.fixSteps,
        baseDir,
        projectRoot,
        allResults.length,
      );
      allResults = [...allResults, ...fixRun.stepResults];
      history.push({
        attempt,
        skillId: plan.skillId,
        category: plan.category,
        success: fixRun.ok,
        reason: plan.reason,
      });

      if (!fixRun.ok) {
        currentSteps = fixRun.remainingSteps;
        continue;
      }
      // 修复成功后继续跑失败点及其后续步骤
      currentSteps = effectiveRun.remainingSteps;
    }
  }
}
