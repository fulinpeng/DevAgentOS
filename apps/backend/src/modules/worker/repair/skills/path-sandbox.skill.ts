import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

function sanitizeToProjectRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim();
  const parts = normalized.split('/').filter(Boolean);
  const kept: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '..') {
      continue;
    }
    kept.push(p);
  }
  return kept.join('/');
}

function maybeRewritePathStep(step: WorkerLlmStep): WorkerLlmStep | null {
  const pathArg = step.args.path;
  if (typeof pathArg !== 'string' || !pathArg.trim()) {
    return null;
  }
  const rewrittenPath = sanitizeToProjectRelativePath(pathArg);
  if (!rewrittenPath || rewrittenPath === pathArg) {
    return null;
  }
  return {
    action: step.action,
    args: { ...step.args, path: rewrittenPath },
  };
}

@Injectable()
export class PathSandboxRepairSkill implements RepairSkill {
  readonly id = 'path-sandbox';

  match(context: RepairContext): { score: number; reason: string } {
    const err = (context.failure.error ?? '').toLowerCase();
    if (err.includes('path escapes sandbox')) {
      return { score: 0.98, reason: 'path escapes sandbox' };
    }
    return { score: 0, reason: 'not path sandbox issue' };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const rewritten = maybeRewritePathStep(context.failure.step);
    if (!rewritten) {
      return null;
    }
    return {
      skillId: this.id,
      score: m.score,
      category: 'path_error',
      reason: 'sanitize relative path to stay inside projectRoot',
      fixSteps: [rewritten],
    };
  }
}

