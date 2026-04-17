import { Injectable, Logger } from '@nestjs/common';
import { WorkflowLlmService } from '../../workflow/infrastructure/llm.service';
import type { RepairContext, RepairTriage } from './repair.types';
import {
  REPAIR_TRIAGE_SKILL_IDS,
  REPAIR_TRIAGE_SYSTEM_PROMPT,
  buildRepairTriageUserPrompt,
} from './repair-triage.prompt';

const ALLOWED = new Set<string>(REPAIR_TRIAGE_SKILL_IDS);

function parseTriageJson(raw: string): RepairTriage | null {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const pure = fence ? fence[1].trim() : text;
  try {
    const parsed = JSON.parse(pure) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    const skillId = String(o.skillId ?? '').trim();
    if (!ALLOWED.has(skillId)) {
      return null;
    }
    const focusRaw = o.focusPaths;
    const focusPaths = Array.isArray(focusRaw)
      ? focusRaw
          .map((x) => String(x ?? '').trim())
          .filter((x) => x.length > 0)
          .slice(0, 24)
      : [];
    const rationale = String(o.rationale ?? '').trim().slice(0, 2000);
    return { skillId, focusPaths, rationale };
  } catch {
    return null;
  }
}

@Injectable()
export class RepairTriageService {
  private readonly logger = new Logger(RepairTriageService.name);

  constructor(private readonly llm: WorkflowLlmService) {}

  /**
   * 一次短 LLM 调用，选定修复技能；解析失败返回 null（由 RepairEngine 回退 llm-fallback）。
   */
  async classify(context: RepairContext): Promise<RepairTriage | null> {
    try {
      const user = buildRepairTriageUserPrompt(context);
      const raw = await this.llm.callLLM(REPAIR_TRIAGE_SYSTEM_PROMPT, user, {
        jsonObject: true,
      });
      const triage = parseTriageJson(raw);
      if (!triage) {
        this.logger.warn(
          `repair triage parse failed task=${context.taskId} rawLen=${raw.length}`,
        );
        return null;
      }
      this.logger.log(
        `repair triage task=${context.taskId} skillId=${triage.skillId} paths=${triage.focusPaths.length}`,
      );
      return triage;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`repair triage LLM failed task=${context.taskId}: ${msg}`);
      return null;
    }
  }
}
