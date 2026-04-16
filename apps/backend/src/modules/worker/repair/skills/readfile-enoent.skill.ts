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

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'readFile') {
      return { score: 0, reason: 'not readFile failure' };
    }
    const err = String(context.failure.error ?? '');
    if (!/ENOENT/i.test(err)) {
      return { score: 0, reason: 'not ENOENT' };
    }
    const stepPath = String(context.failure.step.args.path ?? '').trim();
    if (!stepPath) {
      return { score: 0, reason: 'missing readFile path' };
    }
    return { score: 0.97, reason: `missing file for readFile: ${stepPath}` };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const stepPath = String(context.failure.step.args.path ?? '').trim();
    const parsed = parseMissingPathFromEnoent(String(context.failure.error ?? ''));
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
      score: m.score,
      category: 'path_error',
      reason: m.reason,
      fixSteps,
    };
  }
}
