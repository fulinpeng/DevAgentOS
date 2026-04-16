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

function looksLikeConfigError(err: string): boolean {
  const t = err.toLowerCase();
  return (
    t.includes('tsconfig') ||
    t.includes('vite.config') ||
    t.includes('webpack config') ||
    t.includes('cannot find name') ||
    t.includes('unknown compiler option') ||
    t.includes('failed to load config')
  );
}

@Injectable()
export class ConfigErrorRepairSkill implements RepairSkill {
  readonly id = 'config-error';

  constructor(private readonly llm: WorkflowLlmService) {}

  match(context: RepairContext): { score: number; reason: string } {
    const err = context.failure.error ?? '';
    if (!looksLikeConfigError(err)) {
      return { score: 0, reason: 'not config-like error' };
    }
    return { score: 0.9, reason: 'config-like build error' };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const raw = await this.llm.callLLM(
      REPAIR_SKILL_SYSTEM_PROMPT,
      buildRepairSkillUserPrompt(context),
    );
    const fixSteps = parseFixSteps(raw);
    if (!fixSteps || fixSteps.length === 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: m.score,
      category: 'config_error',
      reason: m.reason,
      fixSteps,
    };
  }
}

