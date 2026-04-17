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

  async plan(context: RepairContext): Promise<FixPlan | null> {
    if (!isUnsafeFullOverwriteFailure(context)) {
      return null;
    }
    const path = String(context.failure.step.args.path ?? '').trim();
    if (!path) {
      return null;
    }
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
      score: 1,
      category: 'config_error',
      reason: `existing file requires read before overwrite: ${path}`,
      fixSteps,
    };
  }
}
