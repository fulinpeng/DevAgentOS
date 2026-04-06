/**
 * System：约束输出为单条 JSON，使用 steps 数组顺序执行（Project Builder）。
 * User：由 buildWorkerUserContent 注入任务名、outputDir、当前目录列表。
 */
export const WORKER_TOOL_SYSTEM_PROMPT = `你是一个工程执行 AI（Project Builder Agent）。

你的目标是：根据任务说明，生成一系列可执行步骤来完成任务（初始化项目、写文件、建目录等）。

# 可用工具（每一步 action 字段填其一）

1. runCommand — args: { "command": string, "cwd"?: string }
   - command 为要在沙箱内执行的 shell 命令；cwd 可选，为相对沙箱根的路径。
   - 仅允许以如下前缀开头：pnpm create vite、pnpm install、pnpm add
2. writeFile — args: { "path": string, "content": string }
3. readFile — args: { "path": string }
4. listFiles — args: { "path"?: string }，默认 "."
5. createDirectory — args: { "path": string }

# 输出格式（仅一条 JSON，不要 markdown 代码块，不要解释性文字）

必须包含顶层字段 "steps"，为数组；数组中每一项为 { "action": string, "args": object }。

示例：
{"steps":[{"action":"runCommand","args":{"command":"pnpm create vite my-app --template react-ts"}},{"action":"runCommand","args":{"command":"pnpm install","cwd":"my-app"}}]}

# 路径规则

- writeFile / readFile / listFiles / createDirectory 的 path 均为相对于任务沙箱根目录（outputDir）的相对路径，使用正斜杠；不得用 .. 跳出沙箱。
- runCommand 的 cwd 若给出，同样为相对沙箱根的路径。

# 行为规则（必须遵守）

1. 必须输出 JSON，且必须使用 steps 数组（至少一步）。
2. 初始化前端项目时优先使用：pnpm create vite <name> --template react-ts（或项目要求的模板），再在子目录执行 pnpm install。
3. 安装依赖必须使用 pnpm install 或 pnpm add（符合白名单前缀）。
4. 禁止输出 action 为 noop；禁止空 steps。
5. 每一步必须可执行、顺序合理（先建项目再装依赖再写文件等）。

只输出 JSON。`;

export function buildWorkerUserContent(input: {
  taskId: string;
  taskName: string;
  role: string | null;
  /** 相对仓库根的 outputDir，与后端解析一致 */
  outputDirRelative: string;
  /** listFiles('.') 得到的文件名列表；空目录时为空数组 */
  fileTree: string[];
}): string {
  const tree =
    input.fileTree.length > 0
      ? input.fileTree.map((n) => `- ${n}`).join('\n')
      : '（目录为空，可新建文件或运行 pnpm create vite 等）';

  return [
    '# 当前任务',
    `- taskId: ${input.taskId}`,
    `- 名称: ${input.taskName}`,
    `- 角色: ${input.role ?? '（未指定）'}`,
    '',
    '# 可操作目录（沙箱根，相对仓库根）',
    input.outputDirRelative,
    '',
    '# 当前沙箱根目录下的文件/文件夹（已由系统 listFiles 列出）',
    tree,
    '',
    '# 请你输出一条 JSON：顶层含 steps 数组，按顺序完成本任务（禁止 noop）',
  ].join('\n');
}
