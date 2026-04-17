import { Injectable } from '@nestjs/common';
import { WorkflowLlmService } from '../../../workflow/infrastructure/llm.service';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import {
  buildRepairSkillUserPrompt,
  REPAIR_SKILL_SYSTEM_PROMPT,
} from '../repair-llm.prompt';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';

const TS_BUILD_REPAIR_HINT = `
# 本轮为「构建/类型检查失败」修复
失败信息里的 toolData.stdout / toolData.stderr 通常含 tsc 或 Vite 的完整报错（含文件路径与行号）。
请根据报错：
1) 用 readFile 读取需修改的源文件（path 相对 projectRoot）
2) 用 writeFile 写回修正后的完整文件内容；可多个文件分多步
3) 非缺包场景不要只用 pnpm install；缺模块报错再考虑 install
4) 仍须遵守：path 无 ..、禁止 pnpm run dev 等长期命令；需要验证可用 pnpm run build

# React / TS 常见模式（务必对症）
- TS2345 / SetStateAction<never[]> / 「Argument … is not assignable」：多为 useState([]) 被推断成 never[]。请为 state 声明元素类型，例如 useState<ImageItem[]>([]) 或 useState<Array<{ id: number; name: string }>>([])，并与 setState 传入数组元素类型一致。
- TS7006「Parameter 'e' implicitly has an 'any' type」：为事件参数补类型，如 React.ChangeEvent<HTMLInputElement>、React.FormEvent 等（需保证文件顶部有正确 import）。
- TS2307 找不到 ../pages/Xxx：在报错路径下新建对应 .tsx（或修正 import 路径与文件名大小写一致）；组件需与路由/父组件用法匹配（可先 readFile 引用方再写新文件）。
- 对 Vite + React 项目补测试时，优先使用 Vitest + Testing Library；不要引入 Enzyme、React 16 adapter、setupTests 中的 enzyme configure 等过时方案。
- 若报错来自 src/__tests__/*、src/setupTests.ts、vitest/config、enzyme、@testing-library 等测试工具链，优先修测试文件、src/setupTests.ts、vitest.config.ts 与 package.json test 脚本；不要假设业务组件会导出 getTodos/setTodos 之类未声明符号。
- Vitest 报错「Invalid Chai property: toBeInTheDocument」等：说明未注册 @testing-library/jest-dom。在 setup 文件（如 src/setupTests.ts）顶部加 \`import '@testing-library/jest-dom/vitest'\`，并在 vitest.config.ts 的 test.setupFiles 中指向该文件；不要误用 pnpm install 解决。
- **禁止**把 vitest.config.ts 改成「仅从 vite 引入 defineConfig、无 plugins、无 vitest/config」的极简版；React 项目须保留 \`import { defineConfig } from 'vitest/config'\` 与 \`plugins: [react()]\`（@vitejs/plugin-react），除非 stderr 明确要求改 import。为通过 \`tsc -b\` 应改 tsconfig 的 include/exclude/references 或测试文件类型，**不要**删除测试或 gut vitest 配置。
- 除非报错直接指向入口文件，否则不要把 src/main.tsx 改成测试修复的一部分；除非明显需要 Vite 测试配置，否则不要优先修改 vite.config.ts。
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
export class TypeScriptBuildRepairSkill implements RepairSkill {
  readonly id = 'typescript-build';

  constructor(private readonly llm: WorkflowLlmService) {}

  async plan(context: RepairContext): Promise<FixPlan | null> {
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
      score: 1,
      category: 'compile_error',
      reason: context.triage?.rationale || 'tsc/vite TypeScript or compile errors',
      fixSteps,
    };
  }
}
