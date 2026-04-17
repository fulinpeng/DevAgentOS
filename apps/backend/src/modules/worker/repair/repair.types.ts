import type { WorkerLlmStep } from '../application/worker.executor.service';

export type RepairCategory =
  | 'missing_dependency'
  | 'missing_script'
  | 'path_error'
  | 'config_error'
  | 'compile_error'
  | 'command_error'
  | 'build_error'
  | 'test_assertion'
  | 'unknown';

export type RepairFailure = {
  stepIndex: number;
  step: WorkerLlmStep;
  tool: string;
  error?: string;
  data?: Record<string, unknown>;
};

/** 来自任务 parameters + 元数据，供修复 LLM 理解「在做什么项目」 */
export type RepairTaskNarrative = {
  taskName: string;
  taskRole: string | null;
  taskDescription: string;
  workflowGoal: string;
  workflowDescription: string;
};

/** 工作流根任务下的计划子任务 + 从根到当前任务的路径（轻量任务树） */
export type RepairWorkflowOutline = {
  rootTaskId: string;
  rootTaskName: string;
  pathFromRoot: Array<{
    id: string;
    name: string;
    role: string | null;
    status: string;
  }>;
  planSteps: Array<{
    id: string;
    name: string;
    role: string | null;
    status: string;
  }>;
};

/** LLM 分类结果：选定修复技能与建议关注路径 */
export type RepairTriage = {
  skillId: string;
  focusPaths: string[];
  rationale: string;
};

export type RepairContext = {
  taskId: string;
  projectRoot: string;
  workflowTechStack: string[];
  taskTechStack: string[];
  attempt: number;
  maxAttempts: number;
  remainingSteps: WorkerLlmStep[];
  failure: RepairFailure;
  history: Array<{
    attempt: number;
    skillId: string;
    category: RepairCategory;
    success: boolean;
    reason: string;
  }>;
  narrative: RepairTaskNarrative;
  /** 数据库不可用时可能为空 */
  workflowOutline?: RepairWorkflowOutline;
  /** 本轮已执行步骤（含此前修复步），便于理解上下文 */
  executedStepsPreview: Array<{
    index: number;
    action: string;
    success: boolean;
    error?: string;
  }>;
  /** 由 RepairEngine 注入：分类 LLM 输出，供各技能 plan 参考 */
  triage?: RepairTriage;
};

export type FixPlan = {
  skillId: string;
  score: number;
  category: RepairCategory;
  reason: string;
  fixSteps: WorkerLlmStep[];
};

export const REPAIR_RESULT_VERSION = 1;

export type RepairSnapshot = {
  version: number;
  state: 'idle' | 'active' | 'exhausted' | 'succeeded';
  attempt: number;
  maxAttempts: number;
  lastFailure?: RepairFailure;
  remainingSteps?: WorkerLlmStep[];
  history: RepairContext['history'];
  selectedSkill?: Omit<FixPlan, 'fixSteps'>;
};

export function buildRepairSnapshot(input: {
  state: RepairSnapshot['state'];
  attempt: number;
  maxAttempts: number;
  history: RepairContext['history'];
  lastFailure?: RepairFailure;
  remainingSteps?: WorkerLlmStep[];
  selectedSkill?: Omit<FixPlan, 'fixSteps'>;
}): RepairSnapshot {
  return {
    version: REPAIR_RESULT_VERSION,
    state: input.state,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    ...(input.lastFailure ? { lastFailure: input.lastFailure } : {}),
    ...(input.remainingSteps ? { remainingSteps: input.remainingSteps } : {}),
    history: input.history,
    ...(input.selectedSkill ? { selectedSkill: input.selectedSkill } : {}),
  };
}

