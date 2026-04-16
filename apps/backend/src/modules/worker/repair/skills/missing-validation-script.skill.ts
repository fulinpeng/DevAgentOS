import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { WorkflowLlmService } from '../../../workflow/infrastructure/llm.service';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import {
  buildRepairSkillUserPrompt,
  REPAIR_SKILL_SYSTEM_PROMPT,
} from '../repair-llm.prompt';
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

function parseFixSteps(raw: string): WorkerLlmStep[] | null {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const pure = fence ? fence[1].trim() : text;
  try {
    const parsed = JSON.parse(pure) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as { fixSteps?: unknown };
    if (!Array.isArray(obj.fixSteps) || obj.fixSteps.length === 0) {
      return null;
    }
    const out: WorkerLlmStep[] = [];
    for (const item of obj.fixSteps) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const r = item as Record<string, unknown>;
      const action = String(r.action ?? '').trim();
      if (!action) {
        return null;
      }
      const args =
        r.args && typeof r.args === 'object' && !Array.isArray(r.args)
          ? (r.args as Record<string, unknown>)
          : {};
      out.push({ action, args });
    }
    return out.slice(0, 8);
  } catch {
    return null;
  }
}

function buildValidationScriptRepairPrompt(context: RepairContext): string {
  return [
    buildRepairSkillUserPrompt(context),
    '',
    '# Extra instruction for this repair',
    'The failed validation command references a missing script (test/verify/check/e2e).',
    'Do NOT suggest pnpm install as the primary fix unless missing packages are explicitly mentioned.',
    'First read package.json and inspect existing scripts.',
    'If a suitable script already exists, switch to that script.',
    'If no validation script exists, create the smallest viable automated test/verification setup for this project and then execute it.',
    'Prefer adding focused test files and test-specific config files (for example: vitest.config.ts, tsconfig.test.json, src/__tests__/*).',
    'For THIS error (missing npm script), you MUST fix it by either: (a) adding the missing script to package.json "scripts" (e.g. "test": "vitest run"), and/or (b) changing runCommand to an equivalent that does not rely on that script (e.g. pnpm exec vitest run).',
    'If you modify package.json, keep existing fields/scripts/dependencies and apply minimal additive edits only. Never replace the entire package.json object.',
    'Avoid rewriting primary project config files such as tsconfig.json or vite.config.ts unless the error directly proves they must change; package.json scripts are allowed and expected here.',
    'If other test config is needed, prefer adding new dedicated config files over replacing existing main config.',
    'Return JSON only: {"fixSteps":[...]}',
  ].join('\n');
}

function readPackageJsonMeta(projectRoot: string): {
  scripts: Record<string, string>;
  hasVitest: boolean;
} {
  try {
    const fp = path.join(projectRoot, 'package.json');
    if (!existsSync(fp)) {
      return { scripts: {}, hasVitest: false };
    }
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === 'object'
        ? parsed.scripts
        : {};
    const deps = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };
    const hasVitest = typeof deps.vitest === 'string' && deps.vitest.length > 0;
    return { scripts, hasVitest };
  } catch {
    return { scripts: {}, hasVitest: false };
  }
}

@Injectable()
export class MissingValidationScriptRepairSkill implements RepairSkill {
  readonly id = 'missing-validation-script';

  constructor(private readonly llm: WorkflowLlmService) {}

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'runCommand') {
      return { score: 0, reason: 'not runCommand failure' };
    }
    const missing = extractMissingScriptNameFromRunCommandFailure(
      context.failure,
    );
    if (!missing || !isValidationScript(missing)) {
      return { score: 0, reason: 'not missing validation script error' };
    }
    return { score: 0.97, reason: `missing validation script: ${missing}` };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const missing = extractMissingScriptNameFromRunCommandFailure(context.failure);
    const pkg = readPackageJsonMeta(context.projectRoot);
    if (missing?.toLowerCase() === 'test') {
      if (pkg.scripts.verify) {
        return {
          skillId: this.id,
          score: m.score,
          category: 'missing_script',
          reason: `${m.reason}; fallback to existing verify script`,
          fixSteps: [{ action: 'runCommand', args: { command: 'pnpm run verify' } }],
        };
      }
      if (pkg.scripts.check) {
        return {
          skillId: this.id,
          score: m.score,
          category: 'missing_script',
          reason: `${m.reason}; fallback to existing check script`,
          fixSteps: [{ action: 'runCommand', args: { command: 'pnpm run check' } }],
        };
      }
      if (pkg.hasVitest) {
        return {
          skillId: this.id,
          score: m.score,
          category: 'missing_script',
          reason: `${m.reason}; fallback to pnpm exec vitest run`,
          fixSteps: [{ action: 'runCommand', args: { command: 'pnpm exec vitest run' } }],
        };
      }
    }

    const raw = await this.llm.callLLM(
      REPAIR_SKILL_SYSTEM_PROMPT,
      buildValidationScriptRepairPrompt(context),
    );
    const fixSteps = parseFixSteps(raw);
    if (!fixSteps || fixSteps.length === 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: m.score,
      category: 'missing_script',
      reason: m.reason,
      fixSteps,
    };
  }
}
