import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';
import { extractMissingScriptNameFromRunCommandFailure } from '../run-command-failure-text';

function isValidationScript(script: string): boolean {
  return [
    'test',
    'verify',
    'check',
    'e2e',
    'vitest',
    'jest',
    'playwright',
    'cypress',
  ].includes(script.toLowerCase());
}

function fallbackScript(script: string): string {
  const s = script.toLowerCase();
  if (s === 'dev' || s === 'preview' || s === 'start') {
    return 'build';
  }
  if (s === 'build') {
    return 'test';
  }
  return 'build';
}

function rewriteMissingScriptCommand(original: string, missingScript: string): string {
  const replacement = fallbackScript(missingScript);
  if (/^pnpm\s+run\s+\S+/i.test(original)) {
    return original.replace(/^pnpm\s+run\s+\S+/i, `pnpm run ${replacement}`);
  }
  if (/^npm\s+run\s+\S+/i.test(original)) {
    return original.replace(/^npm\s+run\s+\S+/i, `npm run ${replacement}`);
  }
  if (/^yarn\s+(run\s+)?\S+/i.test(original)) {
    return `yarn run ${replacement}`;
  }
  return `pnpm run ${replacement}`;
}

@Injectable()
export class MissingScriptRepairSkill implements RepairSkill {
  readonly id = 'missing-script';

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'runCommand') {
      return { score: 0, reason: 'not runCommand failure' };
    }
    const missing = extractMissingScriptNameFromRunCommandFailure(
      context.failure,
    );
    if (!missing) {
      return { score: 0, reason: 'not missing script error' };
    }
    if (isValidationScript(missing)) {
      return {
        score: 0,
        reason: `missing validation script: ${missing} — use llm fallback`,
      };
    }
    return { score: 0.99, reason: `missing script: ${missing}` };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const missing = extractMissingScriptNameFromRunCommandFailure(
      context.failure,
    );
    if (!missing) {
      return null;
    }
    if (isValidationScript(missing)) {
      return null;
    }
    const command = String(context.failure.step.args.command ?? '');
    const rewritten = rewriteMissingScriptCommand(command, missing);
    const fixSteps: WorkerLlmStep[] = [
      { action: 'readFile', args: { path: 'package.json' } },
      { action: 'runCommand', args: { command: rewritten } },
    ];
    return {
      skillId: this.id,
      score: m.score,
      category: 'missing_script',
      reason: m.reason,
      fixSteps,
    };
  }
}

