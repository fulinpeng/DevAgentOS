import type { WorkerLlmStep } from '../application/worker.executor.service';

export type RepairCategory =
  | 'missing_dependency'
  | 'missing_script'
  | 'path_error'
  | 'config_error'
  | 'command_error'
  | 'build_error'
  | 'unknown';

export type RepairFailure = {
  stepIndex: number;
  step: WorkerLlmStep;
  tool: string;
  error?: string;
  data?: Record<string, unknown>;
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
};

export type FixPlan = {
  skillId: string;
  score: number;
  category: RepairCategory;
  reason: string;
  fixSteps: WorkerLlmStep[];
};

