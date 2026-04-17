import type { RepairContext } from './repair.types';

/** 所有 Repair 技能共用的「需求—测试—实现」顺序，避免「先对齐 UI 再反改测试」 */
export const REPAIR_REQUIREMENTS_TEST_UI_ORDER = `
# 决策顺序（必须遵守：需求 → 测试 → 实现）

1) **需求是最高依据**：以当前任务的 taskDescription、workflowGoal、workflow outline 与用户意图为准；不要用「现有 UI 长什么样」当作真理去否定需求。
2) **先判断测试是否在表达需求**：若失败来自断言/期望与**需求**矛盾，应 **修改测试**（期望、测试数据、查询方式、作用域如 within），使测试成为需求的可执行规格；禁止为了绿灯把业务改成迎合**错误**的测试。
3) **再判断实现是否满足已校对的测试**：在确认测试与需求一致后仍失败，应 **修改业务代码 / UI / 状态与持久化**，使实现通过测试。
4) **UI 检测须保留**：读业务组件/页面源码，核对**真实渲染**（文案、role、aria-label、表单标签、可见结构、事件路径）与失败堆栈中的查询是否一致；RTL/DOM 类失败必须以「界面实际长什么样」为事实输入之一，再按 1)～3) 决定改测试还是改实现——**禁止**不看 UI、纯猜断言过关。
5) **禁止**：未对照任务说明就「让测试迁就当前 UI」；或未核对需求就删断言、空测试敷衍过关。
`;

export const REPAIR_SKILL_SYSTEM_PROMPT = `你是一个“自动修复步骤生成器”。
你只输出 JSON，对象顶层必须是 {"fixSteps":[...]}。
${REPAIR_REQUIREMENTS_TEST_UI_ORDER.trim()}

约束：
1) 只能使用 action: runCommand|writeFile|createDirectory|readFile|listFiles
2) fixSteps 数量 1~8（编译/多文件错误可略多），且尽量最小变更
3) 所有 path 为相对 projectRoot，禁止绝对路径与 ..
4) 禁止 dev/preview 等长期不退出命令（如 pnpm run dev）
5) 优先修复当前失败原因，再继续后续 remainingSteps（由系统执行）
6) runCommand 失败时务必查看 toolData 中的 stdout/stderr（tsc/Vite 报错多在此，而非仅看 error 首行）
7) 结合用户给出的工作流目标、当前任务说明与计划步骤，判断应创建或修改哪些文件；TS2307 相对路径缺文件时应在项目内补全源码，不要误用 pnpm install 代替
8) React+TS：useState([]) 易导致 never[]，应改为 useState<具体类型[]>([])；隐式 any 的事件参数需补全类型；缺页面组件则 writeFile 创建并与 import 路径一致
9) 对“已存在文件”禁止盲目整文件重写：必须先 readFile，尽量最小改动；确需覆盖时 writeFile 需携带 overwriteExisting=true（否则服务端会报 unsafe_full_overwrite）
10) 只要修复涉及“行为逻辑”变更（包括但不限于：函数实现、状态更新、事件处理、接口调用、缓存与持久化、副作用、数据流与条件分支），仅 build 通过不算修复完成；fixSteps 必须包含至少一条与改动直接对应、且可自动结束的验证命令，并且应先检查 package.json 中已有 scripts，优先复用 test / verify / check / e2e，禁止臆造不存在的脚本；若项目没有测试体系，则先补最小测试/验证脚本后再执行。优先新增测试文件与测试专用配置（如 vitest.config.ts、tsconfig.test.json），避免重写主 tsconfig.json / vite.config.ts，除非错误已直接指向必须修改；若缺 npm script（如 test），可最小改动补充 package.json 的 scripts 或改用 pnpm exec vitest run 等不依赖别名的命令
11) React+Vite+Vitest：修改 vitest.config.ts 时须保留 defineConfig 来自 vitest/config 与 @vitejs/plugin-react；禁止改成仅从 vite 引入 defineConfig 且去掉 react 插件的“极简配置”来糊弄 build。build 因测试被纳入 tsc 失败时优先调整 tsconfig exclude/references，勿清空测试文件或拆除 Vitest`;

const MAX_FIELD = 6000;
const MAX_OUTLINE_STEPS = 40;

function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated)`;
}

export function buildRepairSkillUserPrompt(context: RepairContext): string {
  const failure = context.failure;
  const n = context.narrative;
  const outline = context.workflowOutline;
  const executed = context.executedStepsPreview;
  const outlineBlock = outline
    ? JSON.stringify(
        {
          rootTaskId: outline.rootTaskId,
          rootTaskName: outline.rootTaskName,
          pathFromRoot: outline.pathFromRoot,
          planSteps: outline.planSteps.slice(0, MAX_OUTLINE_STEPS),
        },
        null,
        2,
      )
    : '(unavailable)';

  return [
    '# Repair Context',
    `taskId: ${context.taskId}`,
    `projectRoot: ${context.projectRoot}`,
    `attempt: ${context.attempt}/${context.maxAttempts}`,
    `workflowTechStack: ${context.workflowTechStack.join(', ') || '(empty)'}`,
    `taskTechStack: ${context.taskTechStack.join(', ') || '(empty)'}`,
    '',
    '# Task & workflow intent（修复时必须参考，避免脱离需求乱改）',
    `currentTaskName: ${clipText(n.taskName, 500)}`,
    `currentTaskRole: ${n.taskRole ?? '(null)'}`,
    `taskDescription: ${clipText(n.taskDescription, MAX_FIELD)}`,
    `workflowGoal: ${clipText(n.workflowGoal, MAX_FIELD)}`,
    `workflowDescription: ${clipText(n.workflowDescription, MAX_FIELD)}`,
    '',
    '# Workflow outline（根任务下的计划子任务 + 根→当前任务路径）',
    outlineBlock,
    '',
    '# Executed steps so far（含此前成功/失败的工具步）',
    JSON.stringify(executed.slice(-60), null, 2),
    '',
    '# Last Failure',
    `stepIndex: ${failure.stepIndex}`,
    `tool: ${failure.tool}`,
    `error: ${failure.error ?? ''}`,
    `step: ${JSON.stringify(failure.step)}`,
    `toolData: ${JSON.stringify(failure.data ?? {})}`,
    '',
    '# Remaining Steps（修复成功后将继续执行）',
    JSON.stringify(context.remainingSteps, null, 2),
    '',
    '# Repair history（本轮已尝试的修复技能）',
    JSON.stringify(context.history, null, 2),
    '',
    context.triage
      ? [
          '# Repair triage（路由 LLM 结论，生成 fixSteps 时请优先对齐）',
          `skillId: ${context.triage.skillId}`,
          `rationale: ${context.triage.rationale}`,
          `focusPaths: ${JSON.stringify(context.triage.focusPaths)}`,
          '',
        ].join('\n')
      : '',
    '仅返回 JSON：{"fixSteps":[{"action":"...","args":{...}}]}',
  ].join('\n');
}

