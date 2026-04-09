import type { RepairContext } from './repair.types';

export const REPAIR_SKILL_SYSTEM_PROMPT = `你是一个“自动修复步骤生成器”。
你只输出 JSON，对象顶层必须是 {"fixSteps":[...]}。

约束：
1) 只能使用 action: runCommand|writeFile|createDirectory|readFile|listFiles
2) fixSteps 数量 1~5，且尽量最小变更
3) 所有 path 为相对 projectRoot，禁止绝对路径与 ..
4) 禁止 dev/preview 等长期不退出命令（如 pnpm run dev）
5) 优先修复当前失败原因，再继续后续 remainingSteps（由系统执行）`;

export function buildRepairSkillUserPrompt(context: RepairContext): string {
  const failure = context.failure;
  return [
    '# Repair Context',
    `taskId: ${context.taskId}`,
    `projectRoot: ${context.projectRoot}`,
    `attempt: ${context.attempt}/${context.maxAttempts}`,
    `workflowTechStack: ${context.workflowTechStack.join(', ') || '(empty)'}`,
    `taskTechStack: ${context.taskTechStack.join(', ') || '(empty)'}`,
    '',
    '# Last Failure',
    `stepIndex: ${failure.stepIndex}`,
    `tool: ${failure.tool}`,
    `error: ${failure.error ?? ''}`,
    `step: ${JSON.stringify(failure.step)}`,
    `toolData: ${JSON.stringify(failure.data ?? {})}`,
    '',
    '# Remaining Steps',
    JSON.stringify(context.remainingSteps, null, 2),
    '',
    '仅返回 JSON：{"fixSteps":[{"action":"...","args":{...}}]}',
  ].join('\n');
}

