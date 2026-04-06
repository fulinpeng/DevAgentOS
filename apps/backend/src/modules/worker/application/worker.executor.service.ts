import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clipLlmRawForRedis } from '../../../infrastructure/llm-log-meta';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  IWorkerExecutor,
  WorkerExecuteInput,
  WorkerExecuteOutput,
} from '../../role/infrastructure/worker.executor';
import { WorkflowLlmService } from '../../workflow/infrastructure/llm.service';
import {
  deriveProjectRootRelative,
  getWorkspaceRoot,
  resolveOutputDirRelative,
  toAbsoluteSandbox,
} from '../infrastructure/resolve-output-dir';
import { FileContextService } from '../infrastructure/file-context.service';
import {
  buildWorkerUserContent,
  WORKER_TOOL_SYSTEM_PROMPT,
} from '../infrastructure/worker-llm.prompt';
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
  ) {}

  async execute(task: WorkerExecuteInput): Promise<WorkerExecuteOutput> {
    const rel = await resolveOutputDirRelative(
      this.prisma,
      task.parameters,
      task.parentId,
    );
    if (!rel) {
      return {
        success: false,
        result: {
          error:
            '未配置 outputDir：请在根任务的 parameters.outputDir 中设置相对仓库根的路径（子任务会继承父任务）。',
        },
      };
    }

    const workspaceRoot = getWorkspaceRoot(this.config);
    const projectRootRel = deriveProjectRootRelative(rel) || rel;
    const baseDir = toAbsoluteSandbox(workspaceRoot, projectRootRel);

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
          output_dir_relative: rel,
          project_root: projectRootRel,
          cwd_used: baseDir,
        },
      });
      return this.runWorkerSteps(
        task,
        resumeSteps,
        baseDir,
        rel,
        projectRootRel,
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
        output_dir_relative: rel,
        project_root: projectRootRel,
        cwd_used: baseDir,
      },
    });

    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'worker_context_injected',
      time: new Date().toISOString(),
      meta: {
        output_dir_relative: rel,
        project_root: projectRootRel,
        cwd_used: baseDir,
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
      outputDirRelative: rel,
      projectRootRelative: projectRootRel,
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

    return this.runWorkerSteps(task, steps, baseDir, rel, projectRootRel);
  }

  private async runWorkerSteps(
    task: WorkerExecuteInput,
    steps: WorkerLlmStep[],
    baseDir: string,
    rel: string,
    projectRootRel: string,
  ): Promise<WorkerExecuteOutput> {
    const stepResults: Array<{
      index: number;
      action: string;
      success: boolean;
      error?: string;
    }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const isoTime = new Date().toISOString();

      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'step_start',
        time: isoTime,
        meta: {
          index: i,
          action: step.action,
          args: step.args,
          project_root: projectRootRel,
          cwd_used: baseDir,
        },
      });

      const toolResult = await this.toolExecutor.execute(
        step.action,
        step.args,
        baseDir,
      );

      if (toolResult.success) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'step_success',
          time: new Date().toISOString(),
          meta: {
            index: i,
            tool: toolResult.tool,
            data: toolResult.data,
          },
        });
        stepResults.push({
          index: i,
          action: toolResult.tool,
          success: true,
        });
        if (toolResult.tool === 'writeFile') {
          await this.taskRedis.appendExecutionLog(task.id, {
            step: 'file_written',
            time: new Date().toISOString(),
            meta: toolResult.data,
          });
        }
      } else {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'step_fail',
          time: new Date().toISOString(),
          meta: {
            index: i,
            tool: toolResult.tool,
            error: toolResult.error,
          },
        });
        stepResults.push({
          index: i,
          action: toolResult.tool,
          success: false,
          error: toolResult.error,
        });
        if (isRunCommandTimeout(toolResult)) {
          await this.taskRedis.appendExecutionLog(task.id, {
            step: 'step_timeout',
            time: new Date().toISOString(),
            meta: {
              index: i,
              tool: toolResult.tool,
              output_dir_relative: rel,
              project_root: projectRootRel,
              cwd_used: baseDir,
            },
          });
          const remainingSteps = steps.slice(i).map((s) => ({
            action: s.action,
            args: s.args,
          }));
          return {
            success: false,
            result: {
              workerPaused: true,
              pauseReason: 'run_command_timeout',
              failedAtIndex: i,
              remainingSteps,
              mode: 'steps',
              steps: stepResults,
              error: toolResult.error,
              lastTool: toolResult.tool,
              outputDirRelative: rel,
            },
          };
        }
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: i,
            steps: stepResults,
            error: toolResult.error,
            lastTool: toolResult.tool,
          },
        };
      }
    }

    const last = stepResults[stepResults.length - 1];
    return {
      success: true,
      result: {
        mode: 'steps',
        stepsExecuted: steps.length,
        steps: stepResults,
        lastAction: last?.action,
        /** 与旧版单 action 结果对齐，便于调用方 / 测试断言 */
        action: last?.action,
      },
    };
  }
}
