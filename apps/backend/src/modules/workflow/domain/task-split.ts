/**
 * 纯领域逻辑：无 Nest / Prisma / Redis / HTTP。
 * LLM 仅通过「已获取的原始字符串」进入本模块，由 aiSplitTask / parseWorkflow 解析校验。
 */

import {
  MAX_LLM_SUBTASKS,
  MAX_LLM_SUBTASK_NAME_LENGTH,
  MAX_WORKFLOW_TASKS,
  MIN_WORKFLOW_TASKS,
  WORKFLOW_PLANNER_PROMPT_VERSION,
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
 * 将 LLM 原始输出解析为子任务；不合法则返回 null。
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
 * 仅从 LLM 原始文本解析子任务；解析失败则返回空数组（不再使用规则拆分）。
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

  if (llmResponseText == null || llmResponseText.trim() === '') {
    return [];
  }

  const fromAi = aiSplitTask(llmResponseText, task.name, {
    ...options,
    featureTokens,
  });
  return fromAi ?? [];
}

// --- Workflow Planner（结构化 DAG）---

export type TaskNodeType =
  | 'setup'
  | 'feature'
  | 'config'
  | 'test'
  | 'refactor';

const TASK_NODE_TYPES = new Set<TaskNodeType>([
  'setup',
  'feature',
  'config',
  'test',
  'refactor',
]);

export type WorkflowTaskNode = {
  id: string;
  name: string;
  description: string;
  type: TaskNodeType;
  dependsOn: string[];
};

export type Workflow = {
  goal: string;
  description: string;
  projectType: string;
  tasks: WorkflowTaskNode[];
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isTaskNodeType(v: unknown): v is TaskNodeType {
  return typeof v === 'string' && TASK_NODE_TYPES.has(v as TaskNodeType);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * 解析 LLM 返回的 Workflow JSON；不合法返回 null。
 */
export function parseWorkflow(raw: string): Workflow | null {
  const text = stripMarkdownFence(raw);
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (!isNonEmptyString(o.goal)) {
    return null;
  }
  if (!isNonEmptyString(o.description)) {
    return null;
  }
  if (typeof o.projectType !== 'string') {
    return null;
  }
  const tasksUnknown = o.tasks;
  if (!Array.isArray(tasksUnknown)) {
    return null;
  }
  if (
    tasksUnknown.length < MIN_WORKFLOW_TASKS ||
    tasksUnknown.length > MAX_WORKFLOW_TASKS
  ) {
    return null;
  }

  const tasks: WorkflowTaskNode[] = [];
  let hasDependencyEdge = false;

  for (const item of tasksUnknown) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const t = item as Record<string, unknown>;
    if (!isNonEmptyString(t.id)) {
      return null;
    }
    if (!isNonEmptyString(t.name)) {
      return null;
    }
    if (!isNonEmptyString(t.description)) {
      return null;
    }
    if (!isTaskNodeType(t.type)) {
      return null;
    }
    if (!isStringArray(t.dependsOn)) {
      return null;
    }
    if (t.dependsOn.length > 0) {
      hasDependencyEdge = true;
    }
    tasks.push({
      id: t.id.trim(),
      name: t.name.trim(),
      description: t.description.trim(),
      type: t.type,
      dependsOn: t.dependsOn.map((d) => d.trim()).filter(Boolean),
    });
  }

  if (!hasDependencyEdge) {
    return null;
  }

  const idSet = new Set(tasks.map((x) => x.id));
  if (idSet.size !== tasks.length) {
    return null;
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!idSet.has(d)) {
        return null;
      }
    }
  }

  const sorted = topologicalSortWorkflowTasks(tasks);
  if (!sorted) {
    return null;
  }

  return {
    goal: (o.goal as string).trim(),
    description: (o.description as string).trim(),
    projectType: (o.projectType as string).trim() || 'unknown',
    tasks: sorted,
  };
}

/**
 * dependsOn 表示「依赖的前置任务 id」；返回拓扑序（前置在前）。
 */
export function topologicalSortWorkflowTasks(
  tasks: WorkflowTaskNode[],
): WorkflowTaskNode[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, t.dependsOn.length);
    for (const d of t.dependsOn) {
      if (!dependents.has(d)) {
        dependents.set(d, []);
      }
      dependents.get(d)!.push(t.id);
    }
  }

  const orderIndex = new Map(tasks.map((t, i) => [t.id, i]));
  const queue = tasks
    .filter((t) => (indegree.get(t.id) ?? 0) === 0)
    .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
    .map((t) => t.id);

  const out: WorkflowTaskNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) {
      return null;
    }
    out.push(node);
    for (const nextId of dependents.get(id) ?? []) {
      const nextDeg = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextDeg);
      if (nextDeg === 0) {
        queue.push(nextId);
      }
    }
    queue.sort(
      (a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0),
    );
  }

  if (out.length !== tasks.length) {
    return null;
  }
  return out;
}

function inferRoleFromWorkflow(
  projectType: string,
  taskType: TaskNodeType,
): string {
  const p = projectType.toLowerCase();
  if (p.includes('backend') || p.includes('node') || taskType === 'config') {
    return 'backend';
  }
  if (p.includes('data') || p.includes('db') || p.includes('sql')) {
    return 'data';
  }
  return 'frontend';
}

/** Worker 仅读取 task.name：合并短标题与详细说明，便于执行侧获得完整上下文。 */
export function combineTaskDisplayNameForWorker(
  shortName: string,
  description: string,
): string {
  const s = shortName.trim();
  const d = description.trim();
  if (!d) {
    return s;
  }
  if (!s) {
    return d;
  }
  return `${s}\n\n${d}`;
}

export function workflowToSubTaskSpecs(
  workflow: Workflow,
  parentName: string,
  options: { llmModel: string; promptVersion?: string },
): SubTaskSpec[] {
  const promptVersion =
    options.promptVersion ?? WORKFLOW_PLANNER_PROMPT_VERSION;
  return workflow.tasks.map((node, i) => ({
    name: combineTaskDisplayNameForWorker(node.name, node.description),
    role: inferRoleFromWorkflow(workflow.projectType, node.type),
    order: i,
    parameters: {
      source: 'llm',
      parentName,
      llmIndex: i,
      model: options.llmModel,
      promptVersion,
      workflowTaskId: node.id,
      shortName: node.name,
      taskDescription: node.description,
      workflowGoal: workflow.goal,
      workflowDescription: workflow.description,
      projectType: workflow.projectType,
      type: node.type,
      dependsOn: node.dependsOn,
    },
  }));
}

/** LLM 不可用或解析失败时的极简两任务回退（仍写入库，供人工后续调整）。 */
export function buildFallbackSubTaskSpecs(
  parentName: string,
  goal: string,
  description: string,
  projectType: string,
  llmModel: string,
): SubTaskSpec[] {
  const pt = projectType.trim() || 'unknown';
  return [
    {
      name: combineTaskDisplayNameForWorker(
        'Baseline setup',
        `Set up project baseline for goal: ${goal}. Details: ${description}`,
      ),
      role: inferRoleFromWorkflow(pt, 'setup'),
      order: 0,
      parameters: {
        source: 'llm',
        parentName,
        llmIndex: 0,
        model: llmModel,
        promptVersion: WORKFLOW_PLANNER_PROMPT_VERSION,
        fallbackPlan: true,
        workflowTaskId: 'fallback_1',
        shortName: 'Baseline setup',
        taskDescription: `Set up project baseline for goal: ${goal}. Details: ${description}`,
        workflowGoal: goal,
        workflowDescription: description,
        projectType: pt,
        type: 'setup',
        dependsOn: [] as string[],
      },
    },
    {
      name: combineTaskDisplayNameForWorker(
        'Implement requirements',
        `Implement the requirements: ${description}`,
      ),
      role: inferRoleFromWorkflow(pt, 'feature'),
      order: 1,
      parameters: {
        source: 'llm',
        parentName,
        llmIndex: 1,
        model: llmModel,
        promptVersion: WORKFLOW_PLANNER_PROMPT_VERSION,
        fallbackPlan: true,
        workflowTaskId: 'fallback_2',
        shortName: 'Implement requirements',
        taskDescription: `Implement the requirements: ${description}`,
        workflowGoal: goal,
        workflowDescription: description,
        projectType: pt,
        type: 'feature',
        dependsOn: ['fallback_1'],
      },
    },
  ];
}

export { WORKFLOW_SPLIT_PROMPT_VERSION } from './task-split.constants';
