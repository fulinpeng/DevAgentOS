import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

function parseMissingPathFromEnoent(errorText: string): string | null {
  const m = errorText.match(/open\s+'([^']+)'/i);
  if (!m?.[1]) {
    return null;
  }
  const raw = m[1].replace(/\\/g, '/');
  const idx = raw.toLowerCase().lastIndexOf('/src/');
  if (idx >= 0) {
    return raw.slice(idx + 1);
  }
  return raw.split('/').filter(Boolean).slice(-2).join('/');
}

@Injectable()
export class ReadFileEnoentRepairSkill implements RepairSkill {
  readonly id = 'readfile-enoent';

  async plan(context: RepairContext): Promise<FixPlan | null> {
    if (context.failure.tool !== 'readFile') {
      return null;
    }
    const err = String(context.failure.error ?? '');
    if (!/ENOENT/i.test(err)) {
      return null;
    }
    const stepPath = String(context.failure.step.args.path ?? '').trim();
    if (!stepPath) {
      return null;
    }
    const parsed = parseMissingPathFromEnoent(err);
    const path = stepPath || parsed;
    if (!path) {
      return null;
    }
    const fixSteps: WorkerLlmStep[] = [
      {
        action: 'writeFile',
        args: {
          path,
          content: '',
          overwriteExisting: true,
        },
      },
      {
        action: 'readFile',
        args: { path },
      },
    ];
    return {
      skillId: this.id,
      score: 1,
      category: 'path_error',
      reason: `missing file for readFile: ${path}`,
      fixSteps,
    };
  }
}
