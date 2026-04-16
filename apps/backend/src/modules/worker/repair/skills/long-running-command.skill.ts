import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

function rewriteLongRunningCommand(command: string): string | null {
  const c = command.trim();
  if (!c) {
    return null;
  }
  if (/^pnpm\s+run\s+dev(\s|$)/i.test(c)) {
    return c.replace(/^pnpm\s+run\s+dev/i, 'pnpm run build');
  }
  if (/^npm\s+run\s+dev(\s|$)/i.test(c)) {
    return c.replace(/^npm\s+run\s+dev/i, 'npm run build');
  }
  if (/^yarn\s+(run\s+)?dev(\s|$)/i.test(c)) {
    return c.replace(/^yarn\s+(run\s+)?dev/i, 'yarn run build');
  }
  if (/^pnpm\s+run\s+preview(\s|$)/i.test(c)) {
    return c.replace(/^pnpm\s+run\s+preview/i, 'pnpm run build');
  }
  if (/^vite(\s|$)/i.test(c)) {
    return 'pnpm run build';
  }
  return null;
}

@Injectable()
export class LongRunningCommandRepairSkill implements RepairSkill {
  readonly id = 'long-running-command';

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'runCommand') {
      return { score: 0, reason: 'not runCommand failure' };
    }
    const err = (context.failure.error ?? '').toLowerCase();
    if (err.includes('run_command_long_running')) {
      return { score: 1, reason: 'blocked long running command' };
    }
    return { score: 0, reason: 'not long running related' };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const cmd = String(context.failure.step.args.command ?? '');
    const rewritten = rewriteLongRunningCommand(cmd);
    if (!rewritten) {
      return null;
    }
    const fixSteps: WorkerLlmStep[] = [
      { action: 'runCommand', args: { command: rewritten } },
    ];
    return {
      skillId: this.id,
      score: m.score,
      category: 'command_error',
      reason: `rewrite long running command: ${cmd} -> ${rewritten}`,
      fixSteps,
    };
  }
}

