import type { FixPlan, RepairContext } from './repair.types';

export interface RepairSkill {
  readonly id: string;
  match(context: RepairContext): { score: number; reason: string };
  plan(context: RepairContext): Promise<FixPlan | null>;
}

