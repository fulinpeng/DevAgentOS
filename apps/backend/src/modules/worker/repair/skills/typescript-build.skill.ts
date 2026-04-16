import { Injectable } from '@nestjs/common';
import { WorkflowLlmService } from '../../../workflow/infrastructure/llm.service';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import {
  buildRepairSkillUserPrompt,
  REPAIR_SKILL_SYSTEM_PROMPT,
} from '../repair-llm.prompt';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';
import {
  getRunCommandFailureText,
  looksLikeCompileOrTypeError,
} from '../run-command-failure-text';

const TS_BUILD_REPAIR_HINT = `
# 本轮为「构建/类型检查失败」修复
失败信息里的 toolData.stdout / toolData.stderr 通常含 tsc 或 Vite 的完整报错（含文件路径与行号）。
请根据报错：
1) 用 readFile 读取需修改的源文件（path 相对 projectRoot）
2) 用 writeFile 写回修正后的完整文件内容；可多个文件分多步
3) 非缺包场景不要只用 pnpm install；缺模块报错再考虑 install
4) 仍须遵守：path 无 ..、禁止 pnpm run dev 等长期命令；需要验证可用 pnpm run build
`;

const MAX_FIX_STEPS = 8;

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
    return out.slice(0, MAX_FIX_STEPS);
  } catch {
    return null;
  }
}

@Injectable()
export class TypeScriptBuildRepairSkill implements RepairSkill {
  readonly id = 'typescript-build';

  constructor(private readonly llm: WorkflowLlmService) {}

  match(context: RepairContext): { score: number; reason: string } {
    if (context.failure.tool !== 'runCommand') {
      return { score: 0, reason: 'not runCommand' };
    }
    const blob = getRunCommandFailureText(context.failure);
    if (!looksLikeCompileOrTypeError(blob)) {
      return { score: 0, reason: 'not compile/type output' };
    }
    return { score: 0.88, reason: 'tsc/vite TypeScript or compile errors in output' };
  }

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const m = this.match(context);
    if (m.score <= 0) {
      return null;
    }
    const user =
      buildRepairSkillUserPrompt(context) +
      '\n' +
      TS_BUILD_REPAIR_HINT +
      '\n仅返回 JSON：{"fixSteps":[{"action":"...","args":{...}}]}，fixSteps 最多 ' +
      String(MAX_FIX_STEPS) +
      ' 条。';
    const raw = await this.llm.callLLM(REPAIR_SKILL_SYSTEM_PROMPT, user);
    const fixSteps = parseFixSteps(raw);
    if (!fixSteps || fixSteps.length === 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: m.score,
      category: 'compile_error',
      reason: m.reason,
      fixSteps,
    };
  }
}
