/**
 * LLM 拆分任务 / Workflow Planner：仅输出结构化 JSON，不参与系统决策。
 */

import { WORKFLOW_SPLIT_PROMPT_VERSION } from '../domain/task-split.constants';

export const SPLIT_TASK_SYSTEM_PROMPT = `You are a task decomposition assistant inside an orchestration system.
You MUST respond with ONLY a valid JSON array (no markdown, no code fences, no explanation).
Each element must be an object with exactly two string fields:
- "name": concise subtask title in English
- "role": one of "frontend", "backend", "data" only

Do not include any other keys. Do not control execution or state.`;

export function buildSplitTaskUserPayload(
  name: string,
  features: string[],
): string {
  return [
    'Decompose the following parent task into subtasks aligned with the given features.',
    `Prompt schema version: ${WORKFLOW_SPLIT_PROMPT_VERSION}`,
    'Input JSON:',
    JSON.stringify({ name, features }, null, 2),
    '',
    'Output JSON array example shape:',
    '[{"name":"build login page","role":"frontend"},{"name":"build dashboard page","role":"frontend"}]',
  ].join('\n');
}

export type WorkflowPlannerInput = {
  goal: string;
  description: string;
  projectType?: string;
  techStack?: string[];
  constraints?: string[];
};

export function buildWorkflowSystemPrompt(): string {
  return [
    '你是一个资深的软件架构师和AI任务规划专家。',
    '',
    '你的职责是：',
    '将用户需求拆解为结构化任务（Workflow），并为每个任务提供清晰、可执行的说明。',
    '',
    '规则：',
    '',
    '1. 必须输出 JSON，不能有解释文字、不能有 markdown 代码块。',
    '2. 每个 task 必须包含：',
    '   - id（字符串，唯一，如 task_1）',
    '   - name（简短标题）',
    '   - description（非常详细，供执行 AI 使用）',
    '   - type（只能是下列之一）',
    '   - dependsOn（字符串数组，列出依赖的 task id）',
    '',
    '3. description 必须说明：要做什么；若能推断则写明技术；生成什么文件或结构；若在合理范围内则写明目录。',
    '4. 禁止模糊描述，例如「实现功能」「处理逻辑」；必须改为类似「create a React component file under src/...」的具体说明。',
    '5. 必须构建合理依赖关系：至少有一个任务的 dependsOn 非空（即至少存在一条依赖边）。',
    '6. tasks 数量为 2~6 个。',
    '7. type 只能是：setup、feature、config、test、refactor。',
    '8. 顶层必须包含：goal、description、projectType、techStack、tasks。',
    '9. techStack 为字符串数组，列出本项目采用的主要技术（由你根据需求推断，如 react、vite、typescript；勿留空数组，除非确实无法判断）。',
    '10. 每个 task 可选包含 role：frontend | backend | data | general（须与任务职责一致）；若不写则由系统推断。',
    '11. 每个 task 可选包含 techStack 字符串数组，表示该子任务侧重使用的技术；可省略，省略视为 []。',
    '12. 顶层的 goal 与 description 必须与用户输入一致或为其精炼改写（不得编造无关目标）。',
  ].join('\n');
}

function formatList(label: string, items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return `${label}\n（未提供）`;
  }
  return `${label}\n${items.map((x) => `- ${x}`).join('\n')}`;
}

export function buildWorkflowUserPrompt(input: WorkflowPlannerInput): string {
  const projectType = input.projectType?.trim() || '（未指定，请根据需求推断）';
  return [
    '# 用户目标',
    input.goal.trim(),
    '',
    '# 详细需求',
    input.description.trim(),
    '',
    '# 项目类型（参考）',
    projectType,
    '',
    formatList('# 技术栈', input.techStack),
    '',
    formatList('# 约束', input.constraints),
    '',
    '---',
    '',
    '# 请生成 Workflow',
    '',
    '要求：',
    '',
    '1. 拆分为 2~6 个任务',
    '2. 每个任务必须有明确职责',
    '3. 每个任务必须有详细 description（用于执行 AI）',
    '4. 必须构建依赖关系（dependsOn），且至少有一个任务依赖其他任务',
    '5. 顶层 techStack 必须非空数组（主要技术栈）；各 task 可选 techStack、可选 role',
    '',
    '# 输出格式（必须严格为 JSON 对象，仅此一段）',
    '',
    '{',
    '  "goal": "...",',
    '  "description": "...",',
    '  "projectType": "...",',
    '  "techStack": ["react", "vite", "typescript"],',
    '  "tasks": [',
    '    {',
    '      "id": "task_1",',
    '      "name": "...",',
    '      "description": "...",',
    '      "type": "setup",',
    '      "dependsOn": [],',
    '      "role": "frontend",',
    '      "techStack": ["vite"]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}
