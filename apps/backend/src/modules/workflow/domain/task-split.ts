/**
 * 纯领域逻辑：无 Nest / Prisma / Redis / HTTP。
 * LLM 仅通过「已获取的原始字符串」进入本模块，由 aiSplitTask 解析校验。
 */

import {
  MAX_LLM_SUBTASKS,
  MAX_LLM_SUBTASK_NAME_LENGTH,
  WORKFLOW_SPLIT_PROMPT_VERSION,
} from './task-split.constants';

export type WorkflowSplitInput = {
  name: string;
  parameters?: Record<string, unknown>;
};

export type SubTaskSpec = {
  name: string;
  role: string;
  order: number;
  parameters: Record<string, unknown>;
};

export type SplitTaskOptions = {
  /** 用于轻量语义锚定：子任务 name 须包含至少一个 feature 子串（大小写不敏感） */
  featureTokens?: string[];
  llmModel?: string;
  promptVersion?: string;
};

const FRONTEND_ROLE = 'frontend';

const ALLOWED_ROLES = new Set(['frontend', 'backend', 'data']);

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string')
  );
}

function stripMarkdownFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    return m[1].trim();
  }
  return text.trim();
}

type LlmItem = { name?: unknown; role?: unknown };

function nameAnchoredToFeatures(
  name: string,
  features: string[],
): boolean {
  if (features.length === 0) {
    return true;
  }
  const lower = name.toLowerCase();
  return features.some(
    (f) => f.trim().length > 0 && lower.includes(f.trim().toLowerCase()),
  );
}

/**
 * 将 LLM 原始输出解析为子任务；不合法则返回 null（触发规则 fallback）。
 */
export function aiSplitTask(
  llmResponseText: string,
  parentName: string,
  options?: SplitTaskOptions,
): SubTaskSpec[] | null {
  let raw = stripMarkdownFence(llmResponseText);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  if (parsed.length > MAX_LLM_SUBTASKS) {
    return null;
  }

  const featureTokens = options?.featureTokens ?? [];
  const model = options?.llmModel;
  const promptVersion = options?.promptVersion ?? WORKFLOW_SPLIT_PROMPT_VERSION;

  const specs: SubTaskSpec[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as LlmItem;
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      typeof item.role !== 'string'
    ) {
      return null;
    }
    const name = item.name.trim();
    const role = item.role.trim().toLowerCase();
    if (
      !name ||
      name.length > MAX_LLM_SUBTASK_NAME_LENGTH ||
      !ALLOWED_ROLES.has(role)
    ) {
      return null;
    }
    if (!nameAnchoredToFeatures(name, featureTokens)) {
      return null;
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (
      keys.length !== 2 ||
      !keys.includes('name') ||
      !keys.includes('role')
    ) {
      return null;
    }
    specs.push({
      name,
      role,
      order: i,
      parameters: {
        source: 'llm',
        parentName,
        llmIndex: i,
        ...(model ? { model } : {}),
        promptVersion,
      },
    });
  }

  return specs;
}

/** 规则引擎拆分（原逻辑）。 */
export function splitTaskRuleBased(task: WorkflowSplitInput): SubTaskSpec[] {
  const features = task.parameters?.features;
  if (!isNonEmptyStringArray(features)) {
    return [];
  }
  return features.map((feature, index) => ({
    name: `build ${feature}`,
    role: FRONTEND_ROLE,
    order: index,
    parameters: { feature, parentName: task.name, source: 'rule' },
  }));
}

/**
 * 优先使用 LLM 结构化结果；失败或无 features 时走规则或无子任务。
 */
export function splitTask(
  task: WorkflowSplitInput,
  llmResponseText?: string | null,
  options?: SplitTaskOptions,
): SubTaskSpec[] {
  const features = task.parameters?.features;
  if (!isNonEmptyStringArray(features)) {
    return [];
  }

  const featureTokens = features.map((f) => f.trim()).filter(Boolean);

  if (llmResponseText != null && llmResponseText.trim() !== '') {
    const fromAi = aiSplitTask(llmResponseText, task.name, {
      ...options,
      featureTokens,
    });
    if (fromAi !== null && fromAi.length > 0) {
      return fromAi;
    }
  }

  return splitTaskRuleBased(task);
}

export { WORKFLOW_SPLIT_PROMPT_VERSION } from './task-split.constants';
