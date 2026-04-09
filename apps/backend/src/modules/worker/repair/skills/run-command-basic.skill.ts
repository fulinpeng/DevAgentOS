import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

function looksLikeDependencyMissing(errorText: string): boolean {
  const t = errorText.toLowerCase();
  return (
    t.includes('cannot find module') ||
    t.includes('module not found') ||
    t.includes('command not found') ||
    t.includes('not recognized as an internal or external command') ||
    t.includes('err_pnpm_recursive_exec_first_fail')
  );
}

function buildFixStepsForRunCommand(_ctx: RepairContext): WorkerLlmStep[] {
  return [{ action: 'runCommand', args: { command: 'pnpm install' } }];
}

@Injectable()
export class RunCommandBasicRepairSkill implements RepairSkill {
  readonly id = 'run-command-basic';

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'runCommand') {
      return { score: 0, reason: 'not runCommand failure' };
    }
    const err = (context.failure.error ?? '').trim();
    if (!err) {
      return { score: 0.2, reason: 'runCommand failed without message' };
    }
    if (looksLikeDependencyMissing(err)) {
      return { score: 0.95, reason: 'likely missing dependency/script/runtime' };
    }
    return { score: 0.4, reason: 'generic runCommand failure' };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: m.score,
      category: m.score >= 0.9 ? 'missing_dependency' : 'build_error',
      reason: m.reason,
      fixSteps: buildFixStepsForRunCommand(context),
    };
  }
}

