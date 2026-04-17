import { Injectable } from '@nestjs/common';
import { WorkflowLlmService } from '../../../workflow/infrastructure/llm.service';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import {
  buildRepairSkillUserPrompt,
  REPAIR_SKILL_SYSTEM_PROMPT,
} from '../repair-llm.prompt';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

const TEST_ASSERTION_REPAIR_HINT = `
# 本轮为「测试运行时 / Testing Library 断言失败」修复（非 tsc 编译）
失败信息里常见：TestingLibraryElementError、找不到文案/角色、Found multiple elements、expect 断言失败等。
请根据堆栈中的文件与行号：
1) 用 readFile 读取相关 **src/** 下的业务源码与测试文件（path 相对 projectRoot）
2) 用 writeFile 做最小修改；可改 **业务组件**（*.tsx 等）或 **测试**（*.test.tsx、*.spec.tsx）、**测试种子数据 / localStorage 预置**、**导出的常量**（如 storage key）等，使测试意图与实现一致
3) 若测试先写了 localStorage 但应用用另一 key 读取，应统一为同一导出常量或同一字符串，而不是只重跑测试
4) 不要用 pnpm install 敷衍；非缺包不要 install
5) 仍须遵守：path 无 ..；禁止 pnpm run dev；验证可再跑失败的测试命令（如 pnpm run test）

仅返回 JSON：{"fixSteps":[{"action":"...","args":{...}}]}，fixSteps 最多 10 条。
`;

const MAX_FIX_STEPS = 10;

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
export class VitestRtlAssertionRepairSkill implements RepairSkill {
  readonly id = 'vitest-rtl-assertion';

  constructor(private readonly llm: WorkflowLlmService) {}

  async plan(context: RepairContext): Promise<FixPlan | null> {
    const user =
      buildRepairSkillUserPrompt(context) +
      '\n' +
      TEST_ASSERTION_REPAIR_HINT;
    const raw = await this.llm.callLLM(REPAIR_SKILL_SYSTEM_PROMPT, user);
    const fixSteps = parseFixSteps(raw);
    if (!fixSteps || fixSteps.length === 0) {
      return null;
    }
    return {
      skillId: this.id,
      score: 1,
      category: 'test_assertion',
      reason:
        context.triage?.rationale ||
        'vitest/testing-library assertion or DOM query failure',
      fixSteps,
    };
  }
}
