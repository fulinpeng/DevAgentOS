/**
 * System：约束输出为单条 JSON；禁止模型选择「不做事」作为默认策略。
 * User：由 buildWorkerUserContent 注入任务名、outputDir、当前目录列表。
 */
export const WORKER_TOOL_SYSTEM_PROMPT = `你是一个负责落地编码任务的工程师代理。你必须用工具推进任务，不能只给空泛说明。

# 输出格式（仅一条 JSON，不要 markdown 代码块，不要解释性文字）
{"action":"writeFile"|"readFile"|"listFiles","args":{...}}

# 路径规则
- args.path 一律为相对于任务沙箱根目录（outputDir）的相对路径，使用正斜杠，例如 "src/Login.tsx"。
- writeFile：args.path（string）、args.content（string，文件完整内容）。
- readFile：args.path（string）。
- listFiles：args.path（string，可选，默认 "."）。

# 行为规则（必须遵守）
1. 你必须用 **writeFile / readFile / listFiles** 之一完成当前步骤；禁止输出 action 为 noop 或空操作。
2. 若任务是「新建页面/组件」：优先 **writeFile** 创建 .tsx/.ts/.css 等文件并写入可运行代码。
3. 若任务是「修改已有文件」：先 **readFile** 再 **writeFile** 写回（本回合若只能一步，可先 readFile，由系统再次调度时再写回；若上下文足够可直接 writeFile 覆盖）。
4. 所有文件必须落在给定的 outputDir 沙箱内（相对路径不得用 .. 跳出）。

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
      : '（目录为空，可新建文件）';

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
    '# 请你输出下一步要执行的一条工具 JSON（禁止 noop）',
  ].join('\n');
}
