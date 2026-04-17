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

**务必按系统消息开头的「需求 → 测试 → 实现」顺序决策**，本轮补充：
1) 用 readFile 读堆栈涉及的测试与 **src/** 业务源码；**对照组件实际会渲染出的文案、角色与表单标签（UI 事实）**，再对照 taskDescription / workflowGoal 判断：是 **测试写错了** 还是 **实现未满足需求**。
2) **测试与需求不一致** → 只改测试（期望、数据、RTL 查询与 within 作用域等），不要改业务去迎合错误断言。
3) **测试已正确表达需求** → 改业务（组件、文案、交互、localStorage key 与数据结构等）；种子数据/存储 key 与生产不一致时，以**同一套需求下的单一事实来源**为准（常是导出常量 + 一致字段名）。
4) **不得跳过 UI 检测**：断言/查询必须与真实 DOM 一致；多节点、错误 placeholder、错误 role 等要先从界面实现核对再改。
5) 禁止 pnpm install 敷衍（非缺包不 install）；path 无 ..；禁止 pnpm run dev；最后一步应再跑失败的测试命令（如 pnpm run test）。

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
