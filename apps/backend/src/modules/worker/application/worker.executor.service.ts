import { existsSync, readFileSync, statSync } from 'node:fs';
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
import {
  getRunCommandFailureText,
  looksLikeCompileOrTypeError,
} from '../repair/run-command-failure-text';
import {
  buildRepairSnapshot,
  type RepairContext,
  type RepairFailure,
  type RepairWorkflowOutline,
} from '../repair/repair.types';
import { ToolExecutor, type ToolExecuteResult } from '../tool/tool-executor';
import { normalizeAction } from '../tool/action-normalize';
import { resolveUnderBase } from '../tool/path-sandbox';

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

/** fetch / LLM 网络错误写入 Redis：展开 Error.cause 链与 errno code，便于区分 DNS、reset、超时等 */
function llmErrorMetaForRedis(e: unknown): Record<string, unknown> {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  const meta: Record<string, unknown> = { message };
  const chain: string[] = [];
  const codes: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur instanceof Error && depth < 8) {
    const n = cur as NodeJS.ErrnoException & { syscall?: string };
    if (n.code) {
      codes.push(String(n.code));
    }
    const bits = [
      n.name || 'Error',
      n.message ? n.message.slice(0, 400) : '',
      n.code ? `code=${n.code}` : '',
      typeof n.errno === 'number' ? `errno=${n.errno}` : '',
      n.syscall ? `syscall=${n.syscall}` : '',
    ].filter(Boolean);
    if (bits.length) {
      chain.push(bits.join(' | '));
    }
    cur = n.cause;
    depth++;
  }
  if (cur != null && !(cur instanceof Error)) {
    chain.push(`non-Error cause: ${String(cur).slice(0, 400)}`);
  }
  const uniq = [...new Set(codes)];
  if (chain.length > 0) {
    meta.causeChain = chain;
  }
  if (uniq.length > 0) {
    meta.errnoCodes = uniq;
  }
  /** 合并进 message，避免前端只展示 message 时看不到 causeChain */
  const tail = chain.length > 1 ? chain.slice(1).join(' <- ') : '';
  const codeStr = uniq.length > 0 ? uniq.join(',') : '';
  if (tail || codeStr) {
    meta.message = [message, codeStr && `codes=${codeStr}`, tail && `causes=${tail}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 1200);
  }
  return meta;
}

/**
 * 解析 LLM 输出：优先 `steps[]`，否则兼容单条 `{ action, args }`。
 * Worker 请求侧已启用 `response_format: json_object`，单次补全应为唯一顶层对象，避免两段 JSON 拼接。
 */
function extractFirstTopLevelJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseWorkerLlmOutput(text: string): WorkerLlmStep[] | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const parseOne = (s: string): WorkerLlmStep[] | null => {
    const o = JSON.parse(s) as unknown;
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
  };
  try {
    const first = parseOne(raw);
    if (first) {
      return first;
    }
  } catch {
    // ignore and fallback
  }
  try {
    const firstObject = extractFirstTopLevelJsonObject(raw);
    if (!firstObject) {
      return null;
    }
    return parseOne(firstObject);
  } catch {
    return null;
  }
}

export function parseWorkerLlmOutputForTest(text: string): WorkerLlmStep[] | null {
  return parseWorkerLlmOutput(text);
}

function stepsContainOnlyNoop(steps: WorkerLlmStep[]): boolean {
  return steps.every((s) => normalizeAction(s.action) === 'noop');
}

function textMentionsBehaviorVerificationRequirement(text: string): boolean {
  const t = text.toLowerCase();
  return [
    'bug',
    'fix',
    '修复',
    '逻辑',
    '行为',
    '功能',
    '函数',
    '状态',
    '接口',
    'api',
    'event',
    'handler',
    'effect',
    '副作用',
    '数据流',
    '条件分支',
    'localstorage',
    'sessionstorage',
    '持久化',
    '刷新后',
    '刷新不丢',
    '页面刷新',
    'reload',
    'persist',
    'persistence',
  ].some((kw) => t.includes(kw));
}

function requiresBehaviorVerification(task: WorkerExecuteInput): boolean {
  const p = task.parameters;
  const blobs: string[] = [task.name];
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const r = p as Record<string, unknown>;
    if (typeof r.taskDescription === 'string') blobs.push(r.taskDescription);
    if (typeof r.goal === 'string') blobs.push(r.goal);
    if (typeof r.workflowGoal === 'string') blobs.push(r.workflowGoal);
    if (typeof r.workflowDescription === 'string') {
      blobs.push(r.workflowDescription);
    }
  }
  return textMentionsBehaviorVerificationRequirement(blobs.join('\n'));
}

function hasBehaviorVerificationCommand(steps: WorkerLlmStep[]): boolean {
  return steps.some((s) => {
    if (normalizeAction(s.action) !== 'runCommand') {
      return false;
    }
    const cmd = String(s.args.command ?? '').toLowerCase();
    if (!cmd) {
      return false;
    }
    return (
      cmd.includes(' run test') ||
      cmd.includes(' run test:') ||
      cmd.includes(' run verify') ||
      cmd.includes(' run verify:') ||
      cmd.includes(' run check') ||
      cmd.includes(' run check:') ||
      cmd.includes(' e2e') ||
      cmd.includes('vitest') ||
      cmd.includes('jest') ||
      cmd.includes('playwright') ||
      cmd.includes('cypress')
    );
  });
}

type MissingVerificationScript = {
  stepIndex: number;
  command: string;
  script: string;
};

function parseRunScriptName(command: string): string | null {
  const c = command.trim();
  let m = c.match(/^(?:pnpm|npm)\s+run\s+([^\s]+)\s*$/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  m = c.match(/^yarn\s+(?:run\s+)?([^\s]+)\s*$/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  return null;
}

function isBehaviorVerificationScriptName(script: string): boolean {
  const s = script.toLowerCase();
  return (
    s === 'test' ||
    s.startsWith('test:') ||
    s === 'verify' ||
    s.startsWith('verify:') ||
    s === 'check' ||
    s.startsWith('check:') ||
    s === 'e2e' ||
    s.startsWith('e2e:')
  );
}

export function findMissingPackageScriptForVerification(
  steps: WorkerLlmStep[],
  packageScripts: string[],
): MissingVerificationScript | null {
  const known = new Set(packageScripts.map((s) => s.toLowerCase()));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (normalizeAction(step.action) !== 'runCommand') {
      continue;
    }
    const command = String(step.args.command ?? '').trim();
    if (!command) {
      continue;
    }
    const script = parseRunScriptName(command);
    if (!script || !isBehaviorVerificationScriptName(script)) {
      continue;
    }
    if (!known.has(script.toLowerCase())) {
      return { stepIndex: i, command, script };
    }
  }
  return null;
}

export function shouldSkipReplayingFailedStepAfterRepairForTest(
  failure: RepairFailure,
  remainingStep?: WorkerLlmStep,
  appliedFixSteps: WorkerLlmStep[] = [],
): boolean {
  return shouldSkipReplayingFailedStepAfterRepair(
    failure,
    remainingStep,
    appliedFixSteps,
  );
}

export function fingerprintRepairWriteIntentsForTest(
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): string | null {
  return fingerprintRepairWriteIntents(failure, fixSteps);
}

function getSuggestedVerificationCommands(): string[] {
  return [
    'pnpm run test',
    'pnpm run verify',
    'pnpm run check',
    'pnpm run e2e',
    'pnpm exec vitest run',
    'pnpm exec playwright test',
  ];
}

function readPackageJsonScripts(baseDir: string): string[] {
  try {
    const pkgPath = path.join(baseDir, 'package.json');
    if (!existsSync(pkgPath)) {
      return [];
    }
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      return [];
    }
    return Object.keys(scripts).filter(Boolean).sort();
  } catch {
    return [];
  }
}

function buildAcceptanceVerifyRetryPrompt(
  originalUserPrompt: string,
  rejectedRaw: string,
  scripts: string[],
  missingScript?: MissingVerificationScript | null,
): string {
  const scriptBlock =
    scripts.length > 0
      ? `当前 package.json 已有 scripts：${scripts.join(', ')}`
      : '当前 package.json 未发现可复用的验证脚本（test/verify/check/e2e）。';
  return [
    originalUserPrompt,
    '',
    '# 上一版计划被系统拒绝',
    missingScript
      ? `原因：你产出的 steps 虽然包含验证命令，但引用了 package.json 中不存在的脚本：${missingScript.command}（缺少 scripts.${missingScript.script}）。`
      : '原因：你产出的 steps 修改了行为逻辑，但没有包含与改动直接对应、且可自动结束的验证命令。',
    '要求：请重新输出完整 steps。',
    '- 仍需完成代码修改。',
    '- 必须加入至少一条自动结束的验证命令。',
    '- 先检查 package.json 里已有 scripts，优先复用 test / verify / check / e2e；不要臆造不存在的脚本。',
    '- 若项目当前没有测试脚本，你必须先新增最小测试/验证脚本（以及必要依赖/配置），再在 steps 中实际执行它。',
    '- 可接受示例：pnpm run test / pnpm run verify / pnpm run check / pnpm exec vitest run / pnpm exec playwright test。',
    '- 若你打算执行 pnpm run test / verify / check / e2e，必须同步修改 package.json scripts，或改用 pnpm exec vitest run 等不依赖 scripts 的命令。',
    '- 不要只输出 build；build 可保留，但不能作为唯一验收。',
    '',
    '# package.json 脚本信息',
    scriptBlock,
    '',
    '# 被拒绝的原始输出（供参考，避免重复犯错）',
    rejectedRaw,
  ].join('\n');
}

type AcceptanceRecoveryInput = {
  task: WorkerExecuteInput;
  baseDir: string;
  projectRoot: string;
  workflowTechStack: string[];
  taskTechStack: string[];
  narrative: RepairContext['narrative'];
  rawPlan: string;
  packageScripts: string[];
  retried: boolean;
};

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

const PARENT_CONTEXT_HINT_REGEX =
  /(父级|父任务|上级任务|parent task|parent|携带|获取|感知)/i;

export function shouldInjectParentTaskContextForTest(
  taskDescription: string,
): boolean {
  return PARENT_CONTEXT_HINT_REGEX.test(taskDescription);
}

function extractTaskDescriptionFromTaskRow(input: {
  name: string;
  parameters: unknown;
}): string {
  const p = input.parameters;
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const r = p as Record<string, unknown>;
    const td =
      typeof r.taskDescription === 'string' ? r.taskDescription.trim() : '';
    if (td) {
      return td;
    }
  }
  return input.name;
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
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.ts',
] as const;

function normalizeRelPathForPolicy(pathLike: unknown): string {
  return String(pathLike ?? '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * 对「目标文件已存在」的 writeFile：若未带 overwriteExisting，则自动插入 readFile（若尚未紧邻同路径读）
 * 并补上 overwriteExisting=true，避免多文件批处理时逐步触发 unsafe_full_overwrite、耗尽 repair 次数。
 */
export function coerceWriteFileStepsForExistingTargets(
  baseDir: string,
  steps: WorkerLlmStep[],
): WorkerLlmStep[] {
  const out: WorkerLlmStep[] = [];
  let lastEmitted: WorkerLlmStep | undefined;

  for (const step of steps) {
    const action = normalizeAction(step.action);
    if (action !== 'writeFile') {
      out.push(step);
      lastEmitted = step;
      continue;
    }
    const rawPath = String(step.args.path ?? '').trim().replace(/\\/g, '/');
    if (!rawPath) {
      out.push(step);
      lastEmitted = step;
      continue;
    }
    const overwrite =
      step.args.overwriteExisting === true || step.args.allowOverwrite === true;
    let full: string;
    try {
      full = resolveUnderBase(baseDir, rawPath);
    } catch {
      out.push(step);
      lastEmitted = step;
      continue;
    }
    if (overwrite) {
      out.push(step);
      lastEmitted = step;
      continue;
    }
    let existingFile = false;
    try {
      if (existsSync(full)) {
        existingFile = statSync(full).isFile();
      }
    } catch {
      existingFile = false;
    }
    if (!existingFile) {
      out.push(step);
      lastEmitted = step;
      continue;
    }
    const prevReadSame =
      lastEmitted &&
      normalizeAction(lastEmitted.action) === 'readFile' &&
      normalizeRelPathForPolicy(lastEmitted.args.path) ===
        normalizeRelPathForPolicy(rawPath);
    if (!prevReadSame) {
      out.push({ action: 'readFile', args: { path: rawPath } });
    }
    out.push({
      ...step,
      args: { ...step.args, path: rawPath, overwriteExisting: true },
    });
    lastEmitted = out[out.length - 1];
  }
  return out;
}

/** 合并连续的相同 runCommand，避免 LLM 重复输出两遍验证命令浪费步数与 repair 额度 */
export function dedupeConsecutiveIdenticalRunCommands(
  steps: WorkerLlmStep[],
): WorkerLlmStep[] {
  const out: WorkerLlmStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      normalizeAction(step.action) === 'runCommand' &&
      normalizeAction(prev.action) === 'runCommand' &&
      String(prev.args.command ?? '').trim() ===
        String(step.args.command ?? '').trim()
    ) {
      continue;
    }
    out.push(step);
  }
  return out;
}

function fingerprintRepairPlan(
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): string {
  const failureSig = `${failure.tool}|${String(failure.error ?? '').slice(0, 300)}`;
  const stepsSig = fixSteps.map((s) => `${normalizeAction(s.action)}:${JSON.stringify(s.args)}`);
  return `${failureSig}>>${stepsSig.join('||')}`;
}

function fingerprintRepairWriteIntents(
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): string | null {
  const writes = fixSteps
    .filter((s) => normalizeAction(s.action) === 'writeFile')
    .map((s) => ({
      path: normalizeRelPathForPolicy(s.args.path),
      content: String(s.args.content ?? ''),
    }))
    .filter((x) => x.path);
  if (writes.length === 0) {
    return null;
  }
  const failureSig = `${failure.tool}|${String(failure.error ?? '').slice(0, 300)}`;
  const writeSig = writes
    .sort((a, b) => a.path.localeCompare(b.path) || a.content.localeCompare(b.content))
    .map((x) => `${x.path}:${x.content}`)
    .join('||');
  return `${failureSig}>>${writeSig}`;
}

function mentionsAnyPath(text: string, paths: readonly string[]): boolean {
  const t = text.toLowerCase().replace(/\\/g, '/');
  return paths.some((p) => t.includes(p.toLowerCase()));
}

/** build / tsc / vite build 等「工程编译」类命令失败 */
function isProjectBuildOrTypecheckCommandFailure(
  failure: RepairFailure,
): boolean {
  if (failure.tool !== 'runCommand') {
    return false;
  }
  const cmd = String(failure.step.args.command ?? '').toLowerCase();
  return (
    /\bpnpm\s+run\s+build\b/.test(cmd) ||
    /\bnpm\s+run\s+build\b/.test(cmd) ||
    /\byarn\s+(run\s+)?build\b/.test(cmd) ||
    /\bvite\s+build\b/.test(cmd) ||
    /\bpnpm\s+exec\s+vite\s+build\b/.test(cmd) ||
    /\btsc\b/.test(cmd) ||
    /\bpnpm\s+exec\s+tsc\b/.test(cmd) ||
    /\bnpx\s+tsc\b/.test(cmd)
  );
}

function isValidationCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    /\bpnpm\s+run\s+test\b/.test(cmd) ||
    /\bnpm\s+run\s+test\b/.test(cmd) ||
    /\byarn\s+(run\s+)?test\b/.test(cmd) ||
    /\bpnpm\s+exec\s+vitest\b/.test(cmd) ||
    /\bnpx\s+vitest\b/.test(cmd) ||
    /\bpnpm\s+run\s+verify\b/.test(cmd) ||
    /\bpnpm\s+run\s+check\b/.test(cmd) ||
    /\bpnpm\s+run\s+e2e\b/.test(cmd)
  );
}

function isBusinessSourcePath(pathLike: unknown): boolean {
  const p = normalizeRelPathForPolicy(pathLike);
  if (!p.startsWith('src/')) {
    return false;
  }
  if (
    p.includes('/__tests__/') ||
    p.endsWith('.test.ts') ||
    p.endsWith('.test.tsx') ||
    p.endsWith('.spec.ts') ||
    p.endsWith('.spec.tsx') ||
    p === 'src/setuptests.ts'
  ) {
    return false;
  }
  return true;
}

function repairPlanTouchesBusinessFiles(fixSteps: WorkerLlmStep[]): boolean {
  return fixSteps.some(
    (s) =>
      normalizeAction(s.action) === 'writeFile' &&
      isBusinessSourcePath(s.args.path),
  );
}

export function repairPlanTouchesBusinessFilesForTest(
  fixSteps: WorkerLlmStep[],
): boolean {
  return repairPlanTouchesBusinessFiles(fixSteps);
}

function isValidationRelatedTestPath(pathLike: unknown): boolean {
  const p = normalizeRelPathForPolicy(pathLike);
  if (!p) {
    return false;
  }
  if (p.includes('/__tests__/')) {
    return true;
  }
  return (
    p.endsWith('.test.ts') ||
    p.endsWith('.test.tsx') ||
    p.endsWith('.spec.ts') ||
    p.endsWith('.spec.tsx') ||
    p === 'src/setuptests.ts'
  );
}

function repairPlanTouchesValidationFixFiles(fixSteps: WorkerLlmStep[]): boolean {
  return fixSteps.some(
    (s) =>
      normalizeAction(s.action) === 'writeFile' &&
      isValidationRelatedTestPath(s.args.path),
  );
}

function isValidationRuntimeEnvironmentFailure(failure: RepairFailure): boolean {
  if (failure.tool !== 'runCommand') {
    return false;
  }
  const text = getRunCommandFailureText(failure).toLowerCase().replace(/\\/g, '/');
  return (
    (text.includes('referenceerror') &&
      (text.includes('localstorage is not defined') ||
        text.includes('window is not defined') ||
        text.includes('document is not defined') ||
        text.includes('navigator is not defined'))) ||
    text.includes('test environment') ||
    text.includes('jsdom') ||
    text.includes('happy-dom')
  );
}

function isValidationEnvironmentConfigPath(pathLike: unknown): boolean {
  const p = normalizeRelPathForPolicy(pathLike);
  if (!p) {
    return false;
  }
  return (
    p === 'vite.config.ts' ||
    p === 'vitest.config.ts' ||
    p === 'vitest.workspace.ts' ||
    p === 'package.json' ||
    p === 'src/setuptests.ts' ||
    p.endsWith('/vitest.config.ts')
  );
}

function repairPlanTouchesValidationEnvironmentConfig(
  fixSteps: WorkerLlmStep[],
): boolean {
  return fixSteps.some(
    (s) =>
      normalizeAction(s.action) === 'writeFile' &&
      isValidationEnvironmentConfigPath(s.args.path),
  );
}

function repairPlanIsMeaningfulForValidationFailure(
  failedCommand: string,
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): boolean {
  if (!isValidationCommand(failedCommand)) {
    return repairPlanTouchesBusinessFiles(fixSteps);
  }
  const envMismatchFix =
    isValidationRuntimeEnvironmentFailure(failure) &&
    repairPlanTouchesValidationEnvironmentConfig(fixSteps);
  return (
    repairPlanTouchesBusinessFiles(fixSteps) ||
    repairPlanTouchesValidationFixFiles(fixSteps) ||
    envMismatchFix
  );
}

export function repairPlanIsMeaningfulForValidationFailureForTest(
  failedCommand: string,
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): boolean {
  return repairPlanIsMeaningfulForValidationFailure(
    failedCommand,
    failure,
    fixSteps,
  );
}

type RepairIntentTag =
  | 'validation_fix'
  | 'compile_config_fix'
  | 'unsafe_overwrite_recovery'
  | 'business_logic_fix'
  | 'generic';

type RepairRiskLevel = 'low' | 'medium' | 'high';

type RepairPolicyAssessment = {
  intent: RepairIntentTag;
  risk: RepairRiskLevel;
  evidencePaths: Set<string>;
  allowedProtected: Set<string>;
};

function detectRepairIntent(
  failure: RepairFailure,
  fixSteps: WorkerLlmStep[],
): RepairIntentTag {
  if (
    failure.tool === 'writeFile' &&
    String(failure.error ?? '').includes('unsafe_full_overwrite')
  ) {
    return 'unsafe_overwrite_recovery';
  }
  if (failure.tool === 'runCommand') {
    const failedCommand = String(failure.step.args.command ?? '').trim();
    if (isValidationCommand(failedCommand)) {
      return 'validation_fix';
    }
    if (
      isProjectBuildOrTypecheckCommandFailure(failure) &&
      looksLikeCompileOrTypeError(getRunCommandFailureText(failure))
    ) {
      return 'compile_config_fix';
    }
  }
  if (repairPlanTouchesBusinessFiles(fixSteps)) {
    return 'business_logic_fix';
  }
  return 'generic';
}

function collectEvidencePathsFromFailure(failure: RepairFailure): Set<string> {
  const failureText = getRunCommandFailureText(failure);
  const evidence = new Set<string>();
  for (const candidate of REPAIR_PROTECTED_PATHS) {
    if (mentionsAnyPath(failureText, [candidate])) {
      evidence.add(candidate);
    }
  }
  return evidence;
}

function failureSuggestsTestToolchainConfig(failure: RepairFailure): boolean {
  const t = getRunCommandFailureText(failure).toLowerCase().replace(/\\/g, '/');
  return [
    'vitest/config',
    'src/__tests__/',
    '.test.ts',
    '.test.tsx',
    '.spec.ts',
    '.spec.tsx',
    'setuptests.ts',
    '@testing-library',
    'jest-dom',
  ].some((needle) => t.includes(needle));
}

function evaluateRepairRisk(writeSet: Set<string>): RepairRiskLevel {
  if (writeSet.size === 0) {
    return 'low';
  }
  const touchesProtected = Array.from(writeSet).some((p) =>
    REPAIR_PROTECTED_PATHS.some((root) => p === root || p.endsWith(`/${root}`)),
  );
  if (touchesProtected || writeSet.size > 2) {
    return 'high';
  }
  return writeSet.size === 1 ? 'low' : 'medium';
}

function assessRepairPolicy(
  failure: RepairFailure,
  deduped: WorkerLlmStep[],
): RepairPolicyAssessment {
  const writeSet = new Set(
    deduped
      .filter((s) => normalizeAction(s.action) === 'writeFile')
      .map((s) => normalizeRelPathForPolicy(s.args.path))
      .filter(Boolean),
  );
  const intent = detectRepairIntent(failure, deduped);
  const risk = evaluateRepairRisk(writeSet);
  const evidencePaths = collectEvidencePathsFromFailure(failure);
  const allowedProtected = new Set<string>();

  // Intent stage: 基于修复意图给出可修改的“受保护文件”语义白名单
  if (intent === 'validation_fix') {
    for (const name of ['vite.config.ts', 'vitest.config.ts', 'package.json'] as const) {
      allowedProtected.add(name);
    }
  }
  if (intent === 'compile_config_fix') {
    for (const name of [
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.node.json',
      'package.json',
    ] as const) {
      allowedProtected.add(name);
    }
    if (failureSuggestsTestToolchainConfig(failure)) {
      allowedProtected.add('vite.config.ts');
    }
  }
  if (intent === 'unsafe_overwrite_recovery') {
    const failedPath = normalizeRelPathForPolicy(failure.step.args.path);
    if (failedPath) {
      allowedProtected.add(failedPath);
    }
  }

  // Evidence stage: 失败文本明确提到的路径可放行
  for (const pathFromError of evidencePaths) {
    allowedProtected.add(pathFromError);
  }

  return { intent, risk, evidencePaths, allowedProtected };
}

export function assessRepairPolicyForTest(
  failure: RepairFailure,
  steps: WorkerLlmStep[],
): { intent: RepairIntentTag; risk: RepairRiskLevel; evidencePaths: string[] } {
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
  const assessment = assessRepairPolicy(failure, deduped);
  return {
    intent: assessment.intent,
    risk: assessment.risk,
    evidencePaths: Array.from(assessment.evidencePaths.values()).sort(),
  };
}

function shouldSkipReplayingFailedStepAfterRepair(
  failure: RepairFailure,
  remainingStep: WorkerLlmStep | undefined,
  appliedFixSteps: WorkerLlmStep[],
): boolean {
  const unsafeOverwriteSkip =
    failure.tool === 'writeFile' &&
    String(failure.error ?? '').includes('unsafe_full_overwrite');
  if (unsafeOverwriteSkip) {
    if (!remainingStep || normalizeAction(remainingStep.action) !== 'writeFile') {
      return false;
    }
    const failedPath = normalizeRelPathForPolicy(failure.step.args.path);
    const nextPath = normalizeRelPathForPolicy(remainingStep.args.path);
    return Boolean(failedPath && nextPath && failedPath === nextPath);
  }
  if (failure.tool !== 'runCommand') {
    return false;
  }
  if (!remainingStep || normalizeAction(remainingStep.action) !== 'runCommand') {
    return false;
  }
  const failedCommand = String(failure.step.args.command ?? '').trim();
  const replayCommand = String(remainingStep.args.command ?? '').trim();
  if (!failedCommand || !replayCommand || failedCommand !== replayCommand) {
    return false;
  }
  return appliedFixSteps.some(
    (s) =>
      normalizeAction(s.action) === 'runCommand' &&
      String(s.args.command ?? '').trim() === failedCommand,
  );
}

export function sanitizeRepairStepsByPolicy(
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
  const repeatedWritePaths = Array.from(
    new Set(writePaths.filter((p, i) => writePaths.indexOf(p) !== i)),
  );
  if (repeatedWritePaths.length > 0) {
    return {
      ok: false,
      reason: `repair writes same file multiple times: ${repeatedWritePaths.join(', ')}`,
    };
  }
  const writeSet = new Set(writePaths);
  if (writeSet.size > REPAIR_MAX_WRITE_FILES) {
    return {
      ok: false,
      reason: `repair writes too many files (${writeSet.size} > ${REPAIR_MAX_WRITE_FILES})`,
    };
  }

  if (writeSet.size > 0) {
    const touchesProtected = Array.from(writeSet).filter((p) =>
      REPAIR_PROTECTED_PATHS.some((root) => p === root || p.endsWith(`/${root}`)),
    );
    const assessment = assessRepairPolicy(failure, deduped);
    const blockedProtected = touchesProtected.filter((p) => {
      if (assessment.allowedProtected.has(p)) {
        return false;
      }
      for (const allow of assessment.allowedProtected) {
        if (p.endsWith(`/${allow}`)) {
          return false;
        }
      }
      return true;
    });
    if (blockedProtected.length > 0) {
      return {
        ok: false,
        reason: `repair blocked by policy triplet: intent=${assessment.intent}; risk=${assessment.risk}; blocked=${blockedProtected.join(', ')}`,
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

  private async maybeLoadParentTaskContext(
    task: WorkerExecuteInput,
    taskDescription: string,
  ): Promise<
    | {
        parentTaskId: string;
        parentTaskName: string;
        parentTaskRole: string | null;
        parentTaskDescription: string;
      }
    | undefined
  > {
    if (!task.parentId) {
      return undefined;
    }
    if (!shouldInjectParentTaskContextForTest(taskDescription)) {
      return undefined;
    }
    try {
      const parent = await this.prisma.task.findUnique({
        where: { id: task.parentId },
        select: {
          id: true,
          name: true,
          role: true,
          parameters: true,
        },
      });
      if (!parent) {
        return undefined;
      }
      return {
        parentTaskId: parent.id,
        parentTaskName: parent.name,
        parentTaskRole: parent.role,
        parentTaskDescription: extractTaskDescriptionFromTaskRow({
          name: parent.name,
          parameters: parent.parameters,
        }),
      };
    } catch (e) {
      this.logger.warn(
        `load parent task context failed taskId=${task.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return undefined;
    }
  }

  private async recoverMissingAcceptanceVerification(
    input: AcceptanceRecoveryInput,
  ): Promise<WorkerExecuteOutput | null> {
    const workflowOutline = await this.fetchWorkflowOutlineForRepair(input.task.id);
    const context: RepairContext = {
      taskId: input.task.id,
      projectRoot: input.projectRoot,
      workflowTechStack: input.workflowTechStack,
      taskTechStack: input.taskTechStack,
      attempt: 1,
      maxAttempts: 1,
      remainingSteps: [],
      failure: {
        stepIndex: -1,
        step: { action: 'runCommand', args: { command: 'pnpm run build' } },
        tool: 'runCommand',
        error: 'worker_llm_missing_acceptance_verify',
        data: {
          rawPlan: input.rawPlan,
          packageScripts: input.packageScripts,
          retried: input.retried,
        },
      },
      history: [],
      narrative: input.narrative,
      ...(workflowOutline ? { workflowOutline } : {}),
      executedStepsPreview: [],
    };
    const plan = await this.repairEngine.planFixSteps(context);
    if (!plan || plan.fixSteps.length === 0) {
      return null;
    }
    await this.taskRedis.appendExecutionLog(input.task.id, {
      step: 'worker_llm_acceptance_repair_selected',
      time: new Date().toISOString(),
      meta: {
        skillId: plan.skillId,
        category: plan.category,
        score: plan.score,
        reason: plan.reason,
        fixStepsCount: plan.fixSteps.length,
      },
    });
    return this.runWorkerSteps(
      input.task,
      plan.fixSteps,
      input.baseDir,
      input.projectRoot,
    );
  }

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

    const { taskDescription, goal } = extractTaskContext(task);
    const parentTaskContext = await this.maybeLoadParentTaskContext(
      task,
      taskDescription,
    );
    const { workflowTechStack, taskTechStack } = extractTechStacks(task);
    const narrative = extractRepairNarrative(task);
    const deepFileTree = this.fileContext.getFileTree(baseDir);
    const importantFiles = this.fileContext.getImportantFiles(baseDir, {
      taskName: task.name,
      taskDescription,
      goal,
      fileTree: deepFileTree,
    });
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
      ...(parentTaskContext ? { parentTaskContext } : {}),
    });
    let raw: string;
    try {
      raw = await this.llm.callLLM(WORKER_TOOL_SYSTEM_PROMPT, user, {
        jsonObject: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Worker LLM failed: ${msg}`);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_error',
        time: new Date().toISOString(),
        meta: llmErrorMetaForRedis(e),
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

    const packageScripts = readPackageJsonScripts(baseDir);
    const missingVerificationScript = requiresBehaviorVerification(task)
      ? findMissingPackageScriptForVerification(steps, packageScripts)
      : null;
    if (
      requiresBehaviorVerification(task) &&
      (!hasBehaviorVerificationCommand(steps) || missingVerificationScript)
    ) {
      const retryUser = buildAcceptanceVerifyRetryPrompt(
        user,
        raw,
        packageScripts,
        missingVerificationScript,
      );
      let retryRaw: string | null = null;
      try {
        retryRaw = await this.llm.callLLM(WORKER_TOOL_SYSTEM_PROMPT, retryUser, {
          jsonObject: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'worker_llm_acceptance_retry_error',
          time: new Date().toISOString(),
          meta: llmErrorMetaForRedis(e),
        });
      }
      if (retryRaw) {
        const retrySteps = parseWorkerLlmOutput(retryRaw);
        if (
          retrySteps &&
          retrySteps.length > 0 &&
          !stepsContainOnlyNoop(retrySteps) &&
          hasBehaviorVerificationCommand(retrySteps) &&
          !findMissingPackageScriptForVerification(retrySteps, packageScripts)
        ) {
          const clippedRetryOk = clipLlmRawForRedis(this.config, retryRaw);
          await this.taskRedis.appendExecutionLog(task.id, {
            step: 'worker_llm_acceptance_retry_ok',
            time: new Date().toISOString(),
            meta: {
              stepCount: retrySteps.length,
              raw: clippedRetryOk.text,
              rawChars: clippedRetryOk.totalChars,
              rawTruncated: clippedRetryOk.truncated,
            },
          });
          return this.runWorkerSteps(task, retrySteps, baseDir, projectRoot);
        }
      }

      const finalRaw = retryRaw ?? raw;
      const recovered = await this.recoverMissingAcceptanceVerification({
        task,
        baseDir,
        projectRoot,
        workflowTechStack,
        taskTechStack,
        narrative,
        rawPlan: finalRaw,
        packageScripts,
        retried: retryRaw !== null,
      });
      if (recovered) {
        return recovered;
      }

      const clipped = clipLlmRawForRedis(this.config, finalRaw);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_missing_acceptance_verify',
        time: new Date().toISOString(),
        meta: {
          hint:
            missingVerificationScript
              ? `计划中的验证命令引用了不存在的 package.json script（${missingVerificationScript.script}）。请改为复用已有 scripts，补充 scripts.${missingVerificationScript.script}，或改用 pnpm exec vitest run。可参考：${getSuggestedVerificationCommands().join(' / ')}`
              : `任务涉及行为逻辑变更，必须在 steps 中加入与改动直接对应、可自动结束的验证命令；优先复用 package.json 现有 scripts，不要臆造脚本。可参考：${getSuggestedVerificationCommands().join(' / ')}`,
          raw: clipped.text,
          retried: retryRaw !== null,
          packageScripts,
        },
      });
      return {
        success: false,
        result: {
          error: 'worker_llm_missing_acceptance_verify',
          message:
            missingVerificationScript
              ? `检测到计划中的行为验证命令引用了不存在的脚本 ${missingVerificationScript.script}。请补充 package.json scripts，或改用 pnpm exec vitest run 等真实可执行命令后重试。`
              : '检测到行为逻辑变更，但计划仅含 build 或缺少行为验证。请补充与改动直接对应的 test/e2e/verify/check 步骤后重试。',
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
    const prepared = coerceWriteFileStepsForExistingTargets(
      baseDir,
      dedupeConsecutiveIdenticalRunCommands(steps),
    );
    const stepResults: StepResultItem[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const step = prepared[i];
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
        remainingSteps: prepared.slice(i),
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
    const seenRepairWriteIntentFingerprints = new Set<string>();

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
      const repairWriteIntentFp = fingerprintRepairWriteIntents(
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
      if (
        repairWriteIntentFp &&
        seenRepairWriteIntentFingerprints.has(repairWriteIntentFp)
      ) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'repair_write_intent_dedup_hit',
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
            error: 'repair_write_intent_dedup_hit',
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
                reason: 'duplicate repair write intent detected',
              },
            }),
          },
        };
      }
      if (repairWriteIntentFp) {
        seenRepairWriteIntentFingerprints.add(repairWriteIntentFp);
      }

      const failedCommand = String(effectiveRun.failure.step.args.command ?? '').trim();
      if (
        effectiveRun.failure.tool === 'runCommand' &&
        isValidationCommand(failedCommand) &&
        !repairPlanIsMeaningfulForValidationFailure(
          failedCommand,
          effectiveRun.failure,
          plan.fixSteps,
        )
      ) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'repair_plan_rejected_no_business_change',
          time: new Date().toISOString(),
          meta: {
            attempt,
            skillId: plan.skillId,
            category: plan.category,
            failedCommand,
            hint:
              '测试命令失败后，修复方案未通过 writeFile 修改 src/ 下业务源码、测试或测试相关配置；请根据报错堆栈补齐实质改动后再重跑测试。',
          },
        });
        history.push({
          attempt,
          skillId: plan.skillId,
          category: plan.category,
          success: false,
          reason:
            'validation command failed but repair plan does not touch business files',
        });
        // 跳过本次“无业务改动”的修复方案，继续下一轮自动修复，不直接失败。
        currentSteps = effectiveRun.remainingSteps;
        continue;
      }

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
      // 某些策略类失败（如 unsafe_full_overwrite）修复后不应再原样重放失败步。
      currentSteps = shouldSkipReplayingFailedStepAfterRepair(
        effectiveRun.failure,
        effectiveRun.remainingSteps[0],
        plan.fixSteps,
      )
        ? effectiveRun.remainingSteps.slice(1)
        : effectiveRun.remainingSteps;
    }
  }
}
