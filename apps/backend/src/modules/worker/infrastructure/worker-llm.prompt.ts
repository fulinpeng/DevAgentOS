/**
 * System：Code-aware Agent，输出 steps[]；User：工程上下文 + 任务说明。
 */

export const WORKER_TOOL_SYSTEM_PROMPT = `你是一个专业的软件工程执行 AI（Code-aware Agent）。

你必须结合 User 中的「当前工作目录（projectRoot）」与「当前文件结构」「关键文件内容」做增量修改，避免重复造轮子；禁止把文件写到 workspace 根目录之外或未指明的路径。

# 可用工具（每一步 action 字段填其一）

1. runCommand — args: { "command": string }
   - 子进程 **cwd 固定为项目根目录（projectRoot）**，由系统设置，**不要传 cwd**。
   - 仅允许命令以如下前缀开头：pnpm create vite、pnpm install、pnpm add（安全白名单；具体依赖包名须与 User 中给出的技术栈一致）
2. writeFile — args: { "path": string, "content": string }
3. readFile — args: { "path": string }
4. listFiles — args: { "path"?: string }，默认 "."
5. createDirectory — args: { "path": string }

# 输出格式（仅一条 JSON，不要 markdown 代码块，不要解释性文字）

必须包含顶层字段 "steps"，为数组；每一项为 { "action": string, "args": object }。

# 路径规则

- 所有 path 均相对于 **projectRoot（User 中给出的当前工作目录）**，使用正斜杠；不得用 .. 跳出沙箱。
- runCommand 已在 projectRoot 下执行；若 pnpm create vite 在子目录生成工程，后续对该子目录的读写仍用相对 projectRoot 的路径。

# 行为规则（必须遵守）

1. 必须输出 JSON，且必须使用 steps 数组（至少一步）。
2. 必须基于已有项目结构进行修改或新增；不要重复创建已存在的文件（除非任务明确要求覆盖）。
3. 优先修改已有文件，而不是无必要地全盘重写。
4. 初始化新项目时可用 pnpm create vite（务必带齐 --template 等参数，避免交互卡住）；创建完成后用**单独一步** runCommand 执行 pnpm install；路径参数相对于 projectRoot。
5. 禁止使用磁盘绝对路径（如 C:\\...）。
6. 禁止输出 action 为 noop；禁止空 steps。
7. 每一步必须真实可执行；系统对单次 runCommand 有最长等待时间，子进程不退出会导致整步无法结束。

只输出 JSON。`;

export type BuildWorkerUserContentInput = {
  taskId: string;
  taskName: string;
  /** 任务执行说明（来自 parameters 或名称） */
  taskDescription: string;
  /** 项目/工作流目标 */
  goal: string;
  role: string | null;
  /** Workflow 级技术栈（parameters.workflowTechStack） */
  workflowTechStack?: string[];
  /** 子任务侧重技术栈（parameters.taskTechStack） */
  taskTechStack?: string[];
  /** 相对仓库根的 outputDir（配置原值，可能含子路径） */
  outputDirRelative: string;
  /** 相对仓库根的项目根（第一层目录），与工具沙箱一致 */
  projectRootRelative: string;
  /** 深度扫描得到的文件列表（最多 50） */
  fileTreeDeep: string[];
  /** 关键文件路径 -> 内容片段 */
  importantFiles: Record<string, string>;
};

/** 控制 User 消息总长，避免超出模型上下文 */
const MAX_USER_PROMPT_CHARS = 48_000;

export function clipWorkerUserPrompt(text: string): string {
  if (text.length <= MAX_USER_PROMPT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_USER_PROMPT_CHARS)}\n\n…(user prompt truncated)`;
}

function formatTechStackLines(
  workflow?: string[],
  task?: string[],
): string {
  const wf = workflow?.filter(Boolean) ?? [];
  const tk = task?.filter(Boolean) ?? [];
  const wLine =
    wf.length > 0 ? `- 工作流级: ${wf.join(', ')}` : '- 工作流级: （未记录）';
  const tLine =
    tk.length > 0 ? `- 本子任务侧重: ${tk.join(', ')}` : '- 本子任务侧重: （未单独列出）';
  return [wLine, tLine].join('\n');
}

function formatFileTreeLines(paths: string[]): string {
  if (paths.length === 0) {
    return '（空目录或尚未创建文件）';
  }
  return paths.map((p) => `- ${p}`).join('\n');
}

function formatImportantFiles(files: Record<string, string>): string {
  const keys = Object.keys(files);
  if (keys.length === 0) {
    return '（未找到 package.json / vite.config.ts / src/main.tsx / src/App.tsx 或不可读）';
  }
  return keys
    .map((k) => {
      const body = files[k] ?? '';
      return `### ${k}\n\`\`\`\n${body}\n\`\`\``;
    })
    .join('\n\n');
}

export function buildWorkerUserContent(
  input: BuildWorkerUserContentInput,
): string {
  const body = [
    '# 当前任务',
    `- taskId: ${input.taskId}`,
    `- 名称: ${input.taskName}`,
    `- 角色: ${input.role ?? '（未指定）'}`,
    '',
    '# 技术栈（Workflow 规划，供选型与依赖安装参考）',
    formatTechStackLines(input.workflowTechStack, input.taskTechStack),
    '',
    '# 任务说明',
    input.taskDescription || '（未单独提供，见名称）',
    '',
    '# 项目目标',
    input.goal || input.taskName,
    '',
    '# 当前工作目录',
    '',
    '你正在以下目录中执行任务（相对仓库根）：',
    '',
    input.projectRootRelative,
    '',
    '所有路径必须基于该目录。',
    '禁止在该目录之外创建文件。',
    '',
    '（配置中的 outputDir 可能更深，例如含子路径；系统已将沙箱与命令 cwd 统一为上述 projectRoot。）',
    `outputDir 配置值：${input.outputDirRelative}`,
    '',
    '# 当前项目文件结构（递归扫描，已忽略 node_modules / .git / dist，最多 50 个文件）',
    formatFileTreeLines(input.fileTreeDeep),
    '',
    '# 关键文件内容（节选，每文件最多 2000 字符）',
    formatImportantFiles(input.importantFiles),
    '',
    '# 请你输出一条 JSON：顶层含 steps 数组，按顺序完成本任务（禁止 noop）',
  ].join('\n');

  return clipWorkerUserPrompt(body);
}
