import type { RepairContext } from './repair.types';

export const REPAIR_SKILL_SYSTEM_PROMPT = `你是一个“自动修复步骤生成器”。
你只输出 JSON，对象顶层必须是 {"fixSteps":[...]}。

约束：
1) 只能使用 action: runCommand|writeFile|createDirectory|readFile|listFiles
2) fixSteps 数量 1~8（编译/多文件错误可略多），且尽量最小变更
3) 所有 path 为相对 projectRoot，禁止绝对路径与 ..
4) 禁止 dev/preview 等长期不退出命令（如 pnpm run dev）
5) 优先修复当前失败原因，再继续后续 remainingSteps（由系统执行）
6) runCommand 失败时务必查看 toolData 中的 stdout/stderr（tsc/Vite 报错多在此，而非仅看 error 首行）
7) 结合用户给出的工作流目标、当前任务说明与计划步骤，判断应创建或修改哪些文件；TS2307 相对路径缺文件时应在项目内补全源码，不要误用 pnpm install 代替
8) React+TS：useState([]) 易导致 never[]，应改为 useState<具体类型[]>([])；隐式 any 的事件参数需补全类型；缺页面组件则 writeFile 创建并与 import 路径一致`;

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
    '仅返回 JSON：{"fixSteps":[{"action":"...","args":{...}}]}',
  ].join('\n');
}

