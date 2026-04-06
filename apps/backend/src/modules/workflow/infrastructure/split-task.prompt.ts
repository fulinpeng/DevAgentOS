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
  /** 用户配置的输出根目录（相对仓库根），可与 projectName 拼成实际项目根 */
  outputDir?: string;
  /** 项目在 outputDir 下使用的目录名；与 outputDir 组合即「项目根」语义 */
  projectName?: string;
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
    '目录与「初始化」语义（供 description 写清楚，供执行阶段对齐；请逐条遵守）：',
    '',
    '13. 三个名词（不要混用）：',
    '    - outputDir：用户在任务里配置的**目录字符串**，一律理解为**相对 Git 仓库根**的路径，表示「打算把工程落在哪一片父路径下」。',
    '    - projectName：仅在「outputDir 下面还要再建一层项目文件夹」时使用，表示那一层**文件夹的名字**（不是完整路径），例如 my-api、admin-ui。',
    '    - projectRoot（项目根）：真正用来放 package.json / 源码、执行 pnpm install 或 pip install 的那**一层**目录；执行 AI 的 cwd 通常对应该层。',
    '',
    '14. 如何计算 projectRoot（两种互斥模式，必须先判断再写 description）：',
    '    - 模式 A（父目录 + 子项目）：用户给了 outputDir 作为**父目录**，并会（或你推断）在底下新建 projectName。此时 projectRoot = outputDir 与 projectName 用正斜杠拼接：projectRoot = "<outputDir>/<projectName>"。',
    '      示例：outputDir = "sandbox"，projectName = "my-app" → projectRoot = "sandbox/my-app"。setup 要在 description 里写「在 sandbox/my-app 下初始化」；后续写文件若相对于该根，可写 "src/App.tsx" 并注明「相对 projectRoot sandbox/my-app」。',
    '    - 模式 B（直接就是项目根）：用户把 outputDir 配成**已经是项目根**的一层路径（该路径下就会出现 package.json 等），**不再**额外加 projectName。此时 projectRoot = outputDir（二者完全相同）。',
    '      示例：outputDir = "clients/acme-api" 且工程直接建在该目录 → projectRoot = "clients/acme-api"。不要在 description 里再虚构 clients/acme-api/某子目录 除非用户明确要求。',
    '',
    '15. 若 parameters 未给出 projectName：从用户 goal/description 中推断一个合法文件夹名（小写、短横线均可），并在 setup 的 description **第一段**明确写出「projectRoot 将定为 <outputDir>/<推断名>」或「projectRoot 即 outputDir」。',
    '',
    '16. description 中的路径写法（避免执行阶段歧义）：',
    '    - 需要写「从仓库根开始的完整相对路径」时，写全：如 "sandbox/my-app/src/main.ts"。',
    '    - 写「相对 projectRoot」时，只写 "src/main.ts"，但同一段必须有一句点明「projectRoot = …」（完整相对仓库根路径）。',
    '    - 禁止写磁盘绝对路径（如 C:\\...）；禁止用 .. 跳出 projectRoot。',
    '',
    '17. type 为 setup 的任务表示「从零初始化可运行骨架」：必须按 projectType / techStack 选型（前端可为 React/Vite 等；后端可为 Node/Nest、Python 等），**不要**预设为某一种前端脚手架（例如不要默认成「只能是 Vite」）。',
    '18. setup 之后 feature、config、test、refactor 类任务：在 description 中约定**所有文件路径与依赖安装均在 projectRoot 语义下**，不得写到 projectRoot 之外。',
    '',
    '审核与修正（若用户在后续对话中要求改计划）：',
    '',
    '19. 保持 dependsOn 与「projectRoot 相对 outputDir 的关系」（模式 A 或 B）不变；可调整任务顺序与 description 措辞。',
    '20. 修改后的描述中，凡涉及路径仍须落在 projectRoot 内，不得引入 workspace 其它任意目录作为写入或安装目标。',
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
  const outputDir = input.outputDir?.trim();
  const projectName = input.projectName?.trim();
  const pathHint =
    outputDir || projectName
      ? [
          '# 目录配置（若已提供，setup 与后续任务须在 description 中与之对齐）',
          outputDir
            ? `- outputDir（相对仓库根，父路径或项目根之一）: ${outputDir}`
            : '- outputDir: （未提供，请从需求中推断并在 description 第一段写明）',
          projectName
            ? `- projectName（模式 A 下：outputDir 下的那一层文件夹名）: ${projectName}。有 outputDir 时一般 projectRoot = outputDir + "/" + projectName；若你的 outputDir 已是完整项目根（模式 B），则不要再用本字段拼接。`
            : '- projectName: （未提供时从需求推断目录名，并写明采用模式 A 还是 B）',
          '- 在每条相关 task 的 description 中重复点明：认定的 projectRoot 完整相对路径，以及路径是相对仓库根还是相对 projectRoot。',
          '',
        ]
      : [
          '# 目录配置',
          '- 若需求涉及新建工程：按 system 中「模式 A / 模式 B」判断 projectRoot；在 description 里写清 projectRoot 的完整相对路径，并说明依赖安装与写文件均在该根下。',
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
