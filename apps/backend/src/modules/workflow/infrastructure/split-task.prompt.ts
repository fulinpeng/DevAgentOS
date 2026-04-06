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
  /** 用户配置的项目根（相对仓库根或绝对路径）；执行与初始化均在此目录下 */
  projectRoot?: string;
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
    '3. description 必须说明：要做什么；若能推断则写明技术；生成什么文件或结构；若在合理范围内则写明**相对项目根的路径**。',
    '4. 禁止模糊描述，例如「实现功能」「处理逻辑」；必须改为类似「在 src/... 下新增或修改某文件」的具体说明。',
    '5. 必须构建合理依赖关系：至少有一个任务的 dependsOn 非空（即至少存在一条依赖边）。',
    '6. tasks 数量为 2~6 个。',
    '7. 字段名必须使用 type（不要用 taskType 等别名）。type 只能是：setup、feature、config、test、refactor。',
    '8. 顶层必须包含：goal、description、projectType、techStack、tasks。',
    '9. techStack 为字符串数组，列出本项目采用的主要技术（由你根据 projectType 与需求推断；勿留空数组，除非确实无法判断）。',
    '10. 每个 task 可选包含 role：frontend | backend | data | general（须与任务职责一致；纯前端勿标 backend）；若不写则由系统推断。',
    '11. 每个 task 可选包含 techStack 字符串数组，表示该子任务侧重使用的技术；可省略，省略视为 []。',
    '12. 顶层的 goal 与 description 必须与用户输入一致或为其精炼改写（不得编造无关目标）。',
    '',
    '项目根 projectRoot（与执行器一致，勿再引入 outputDir 等别名）：',
    '',
    '13. 系统只使用一个目录：用户在任务 parameters.projectRoot 中配置的**项目根**（相对 Git 仓库根，或本机绝对路径）。Worker 的 cwd、依赖安装、读写文件，全部在该目录下进行；不要在 description 中要求「再在 projectRoot 下新建一层工程子目录」除非用户明确说要子工程。',
    '14. 各 task 的 description 里涉及路径时，一律按「相对 projectRoot」书写（如 src/App.tsx）；并可在首句点明「projectRoot 由用户配置为 …」。',
    '15. type 为 setup：在 projectRoot 下从零初始化可运行骨架，按 projectType / techStack 选型（前端、后端或其它均可），不要写死为某一种脚手架。',
    '16. setup 之后的 feature、config、test、refactor：仍只在 projectRoot 内操作，不得写到其它目录。',
    '',
    '审核与修正（若用户在后续对话中要求改计划）：',
    '',
    '17. 保持 dependsOn 不变；可调整任务顺序与 description；凡涉及路径仍须在 projectRoot 内。',
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
  const projectRoot = input.projectRoot?.trim();
  const pathHint = projectRoot
    ? [
        '# 项目根（用户已配置，各 task 的 description 须与之对齐）',
        `- projectRoot: ${projectRoot}`,
        '',
      ]
    : [
        '# 项目根',
        '- 若用户未在 parameters 中提供 projectRoot，请在 description 中说明推断的 projectRoot（相对仓库根或用户给出的绝对路径）。',
        '',
      ];
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
    ...pathHint,
    '---',
    '',
    '# 请生成 Workflow',
    '',
    '要求：',
    '',
    '1. 拆分为 2~6 个任务',
    '2. 每个任务必须有明确职责',
    '3. 每个任务必须有详细 description（用于执行 AI；路径相对 projectRoot）',
    '4. 必须构建依赖关系（dependsOn），且至少有一个任务依赖其他任务',
    '5. 顶层 techStack 必须非空数组（主要技术栈）；各 task 可选 techStack、可选 role',
    '6. 若存在从零搭建：至少一个 task 的 type 为 setup，且与 projectType/techStack 一致（可为前端、后端或其它形态，勿写死为某一种脚手架）。',
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
