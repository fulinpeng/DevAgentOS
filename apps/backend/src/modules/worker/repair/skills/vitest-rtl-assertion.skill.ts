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

**策略（与系统消息一致）：前端只需要 JS/TS 逻辑单测，不要交互式 UI 测试。**

1) readFile 堆栈中的测试与相关 **src/**（hook、storage、纯逻辑模块）。对照 taskDescription / workflowGoal：**不要**为绿测试去补 \`userEvent\` / 整页 \`render\` + \`screen\` 类交互流程。
2) **默认做法**：把失败用例 **改写或替换为逻辑层单测**——\`renderHook\` + mock \`localStorage\`、纯函数、从组件抽出的 handler/ reducer、模块级断言；**删除** \`userEvent\`、\`fireEvent\`、整页 DOM 查询式用例。组件保持薄，逻辑下沉到可测单元。
3) **例外**：仅当任务描述 **明文要求** 界面/无障碍回归时，才允许 **最小** RTL 对齐（role/label/placeholder/storage 与源码一致）；**禁止** 为大改无障碍语义（如 aside 改 dialog）而迁就错误测试。
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
        'vitest failure: prefer JS logic tests, no interaction/UI tests unless task requires UI',
      fixSteps,
    };
  }
}
