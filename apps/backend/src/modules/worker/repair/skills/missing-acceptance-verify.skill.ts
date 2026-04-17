import { Injectable } from '@nestjs/common';
import { WorkflowLlmService } from '../../../workflow/infrastructure/llm.service';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import {
  buildRepairSkillUserPrompt,
  REPAIR_SKILL_SYSTEM_PROMPT,
} from '../repair-llm.prompt';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

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

function buildAcceptanceRepairPrompt(context: RepairContext): string {
  const scripts = Array.isArray(context.failure.data?.packageScripts)
    ? context.failure.data?.packageScripts
    : [];
  return [
    buildRepairSkillUserPrompt(context),
    '',
    '# Extra instruction for this repair',
    'The original worker plan changed behavior logic but failed to include valid acceptance verification.',
    'You must produce fixSteps that both implement the required code change and execute behavior verification.',
    'Do NOT use pnpm install unless the plan explicitly adds new dependencies or the error mentions missing packages.',
    'First inspect package.json scripts and reuse existing validation scripts when possible.',
    `Known package.json scripts: ${Array.isArray(scripts) ? scripts.join(', ') || '(none)' : '(unknown)'}`,
    'If there is no reusable validation script, create the smallest viable automated verification setup and execute it.',
    'Prefer adding focused test files and test-specific config files (for example: vitest.config.ts, tsconfig.test.json, src/__tests__/*).',
    'Avoid rewriting tsconfig.json or vite.config.ts unless the failure directly proves they must change; if you add a test runner, you may extend package.json (scripts + devDependencies) as needed.',
    'If test configuration is needed, prefer new dedicated config files over replacing existing main config.',
    'Return JSON only: {"fixSteps":[...]}',
  ].join('\n');
}

@Injectable()
export class MissingAcceptanceVerifyRepairSkill implements RepairSkill {
  readonly id = 'missing-acceptance-verify';

  constructor(private readonly llm: WorkflowLlmService) {}

  async plan(context: RepairContext): Promise<FixPlan | null> {
    if (context.failure.error !== 'worker_llm_missing_acceptance_verify') {
      return null;
    }
    const raw = await this.llm.callLLM(
      REPAIR_SKILL_SYSTEM_PROMPT,
      buildAcceptanceRepairPrompt(context),
    );
    const fixSteps = parseFixSteps(raw);
    if (!fixSteps || fixSteps.length === 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: 1,
      category: 'build_error',
      reason: 'worker plan missing acceptance verification',
      fixSteps,
    };
  }
}
