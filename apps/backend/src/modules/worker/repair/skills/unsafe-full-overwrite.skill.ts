import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

function isUnsafeFullOverwriteFailure(context: RepairContext): boolean {
  return (
    context.failure.tool === 'writeFile' &&
    String(context.failure.error ?? '').includes('unsafe_full_overwrite')
  );
}

@Injectable()
export class UnsafeFullOverwriteRepairSkill implements RepairSkill {
  readonly id = 'unsafe-full-overwrite';

  match(context: RepairContext): { score: number; reason: string } {
    if (!isUnsafeFullOverwriteFailure(context)) {
      return { score: 0, reason: 'not unsafe full overwrite failure' };
    }
    const path = String(context.failure.step.args.path ?? '').trim();
    if (!path) {
      return { score: 0, reason: 'missing target path' };
    }
    return {
      score: 0.98,
      reason: `existing file requires read before overwrite: ${path}`,
    };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const path = String(context.failure.step.args.path ?? '').trim();
    const content = String(context.failure.step.args.content ?? '');
    const fixSteps: WorkerLlmStep[] = [
      { action: 'readFile', args: { path } },
      {
        action: 'writeFile',
        args: {
          path,
          content,
          overwriteExisting: true,
        },
      },
    ];
    return {
      skillId: this.id,
      score: m.score,
      category: 'config_error',
      reason: m.reason,
      fixSteps,
    };
  }
}
