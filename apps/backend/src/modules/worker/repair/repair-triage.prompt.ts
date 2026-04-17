import type { RepairContext } from './repair.types';

/** 与 RepairEngine 注册表一致，供分类 LLM 选择 */
export const REPAIR_TRIAGE_SKILL_IDS = [
  'long-running-command',
  'missing-acceptance-verify',
  'path-sandbox',
  'readfile-enoent',
  'unsafe-full-overwrite',
  'missing-script',
  'missing-validation-script',
  'config-error',
  'vitest-rtl-assertion',
  'typescript-build',
  'run-command-basic',
  'llm-fallback',
] as const;

export type RepairTriageSkillId = (typeof REPAIR_TRIAGE_SKILL_IDS)[number];

export const REPAIR_TRIAGE_SYSTEM_PROMPT = `你是「自动修复技能路由」分类器。根据失败信息，只选一个最合适的 skillId。
必须返回一个 JSON 对象（不要 markdown），字段：
- skillId: 字符串，必须是下列之一：${REPAIR_TRIAGE_SKILL_IDS.map((id) => `"${id}"`).join(', ')}
- focusPaths: 字符串数组，从堆栈或报错里提取的相对项目根的路径（如 src/App.tsx），没有则 []
- rationale: 简短说明（中文即可）

技能含义（按现象选最贴切的）：
- long-running-command: 明确提示长期命令被拦或 run_command_long_running，或应用试图跑 dev/preview 当普通命令
- missing-acceptance-verify: error 字段**恰好**为 worker_llm_missing_acceptance_verify
- path-sandbox: 路径越界 path escapes sandbox
- readfile-enoent: 工具 readFile 且 ENOENT 缺文件
- unsafe-full-overwrite: writeFile 且 unsafe_full_overwrite
- missing-script: pnpm/npm「缺少脚本」但**不是** test/verify/check/e2e 类验证脚本（如缺 dev 脚本）
- missing-validation-script: 缺少 test/verify/check/e2e/vitest 等**验证类**脚本
- config-error: tsconfig/vite.config/webpack 配置、failed to load config、unknown compiler option 等
- vitest-rtl-assertion: Vitest 已跑起来但 **Testing Library / 断言 / 找不到 DOM 元素 / Found multiple elements** 等运行时测试失败（非 TS 编译行）；输出里出现 **Failed Tests**、**FAIL src/…App.test.tsx** 这类用例失败且**没有** error TS 行时，必须选本项，**禁止**选 typescript-build
- typescript-build: **TSxxxx**、Vite 编译/构建、tsc、import-analysis 构建期解析失败、jest-dom/Chai matcher 未注册等偏「编译/类型/打包」输出
- run-command-basic: 缺 npm 包、cannot find module、command not found、明显应先 pnpm install
- llm-fallback: 无法归入以上任一，或信息过少

若同时像编译又像测试断言，优先看是否有 error TS 或 Vite failed to compile → typescript-build；否则 Vitest + TestingLibraryElementError → vitest-rtl-assertion。`;

const MAX_TRIAGE_FIELD = 12_000;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated)`;
}

export function buildRepairTriageUserPrompt(context: RepairContext): string {
  const f = context.failure;
  const n = context.narrative;
  return [
    '# Failure (for routing only)',
    `taskId: ${context.taskId}`,
    `projectRoot: ${context.projectRoot}`,
    `tool: ${f.tool}`,
    `stepIndex: ${f.stepIndex}`,
    `step: ${JSON.stringify(f.step)}`,
    `error: ${clip(f.error ?? '', MAX_TRIAGE_FIELD)}`,
    `toolData: ${clip(JSON.stringify(f.data ?? {}), MAX_TRIAGE_FIELD)}`,
    '',
    '# Task one-liner',
    `taskName: ${clip(n.taskName, 400)}`,
    `taskRole: ${n.taskRole ?? '(null)'}`,
  ].join('\n');
}
