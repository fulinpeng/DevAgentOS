import type { FixPlan, RepairContext } from './repair.types';

/** 技能由 RepairTriageService（LLM）选定；plan 内可做与失败形态一致的硬校验 */
export interface RepairSkill {
  readonly id: string;
  plan(context: RepairContext): Promise<FixPlan | null>;
}

