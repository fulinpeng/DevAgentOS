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
# 本轮为「Vitest 测试运行时失败」（常含 Testing Library；非 tsc 编译）
失败信息里常见：TestingLibraryElementError、找不到文案/角色、Found multiple、expect 失败等。

**策略（与系统消息一致）：默认弱化 UI/DOM 测试，优先交互逻辑。**

1) readFile 堆栈中的测试与相关 **src/**（hook、storage、组件）。对照 taskDescription / workflowGoal：**能不改 DOM 就不改**。
2) **首选（除非任务明确要求保留界面用例）**：把失败用例 **改写为交互逻辑测试**——例如对自定义 hook 使用 \`renderHook\` + mock \`localStorage\`；把「添加批注 / 选任务」等流程拆成 **纯函数或模块级单测**；**删除或大幅收缩** \`screen.getBy*\` / \`userEvent\` 驱动的整页测试。组件可保持薄，逻辑下沉到可测单元。
3) **次选**（任务明确要求 UI 验收或改写成本过高）：再做 **最小 RTL 修补**——读源码核对 role/label/placeholder/storage 形状与 key；**禁止** 为绿测试大改组件无障碍语义（如 aside 改 dialog）。
4) **describe is not defined**：vitest \`test.globals: true\` 或测试文件 \`import { describe, it, expect, beforeEach } from 'vitest'\`；\`setupFiles\` 建议数组形式。
5) 禁止 pnpm install 敷衍（非缺包不 install）；path 无 ..；禁止 pnpm run dev；最后一步应再跑 \`pnpm run test\`（或项目等价脚本）。

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
