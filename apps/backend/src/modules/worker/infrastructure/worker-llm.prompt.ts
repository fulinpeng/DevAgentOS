/**
 * System：Code-aware Agent，输出 steps[]；User：工程上下文 + 任务说明。
 */

import * as path from 'node:path';

export const WORKER_TOOL_SYSTEM_PROMPT = `你是一个专业的软件工程执行 AI（Code-aware Agent）。

你必须结合 User 中的「当前工作目录（projectRoot）」与「当前文件结构」「关键文件内容」做增量修改，避免重复造轮子；禁止把文件写到 projectRoot 之外或未指明的相对路径。

# 可用工具（每一步 action 字段填其一）

1. runCommand — args: { "command": string }
   - 子进程 **cwd 固定为项目根目录（projectRoot）**，由系统设置，**不要传 cwd**。
   - 命令必须以服务端白名单前缀之一开头（例如：pnpm install / pnpm add / pnpm run / pnpm exec / pnpm dlx / pnpm create … / npm install / npm run / yarn …）；**禁止**裸写 node、git、powershell 等未放行命令。
   - **禁止**用 \`node -e\` / \`pnpm exec node -e "..."\` 等内联脚本改仓库里的 .ts/.tsx/.json（引号在 Windows 下极易写坏，且不符合工具链）。改文件请用 **readFile + writeFile**。
   - **禁止** \`pnpm run dev\`、\`npm run dev\`、\`vite\`（非 build）、\`next dev\` 等**长期不退出**的开发服务器命令：Worker 会等待进程结束，导致步骤一直挂起。验证工程请用 \`pnpm run build\` / \`test\` / \`lint\` 等会结束的脚本。
2. writeFile — args: { "path": string, "content": string, "overwriteExisting"?: boolean }
3. readFile — args: { "path": string }
4. listFiles — args: { "path"?: string }，默认 "."
5. createDirectory — args: { "path": string }

# 输出格式（仅一条 JSON，不要 markdown 代码块，不要解释性文字）

必须包含顶层字段 "steps"，为数组；每一项为 { "action": string, "args": object }。
服务端对本任务启用 JSON Object 模式：整条回复只能是**一个**顶层 JSON 对象，禁止在同一条回复里再输出第二段以「{」开头的另一份 JSON（例如重复整份 steps）。

# 路径规则

- 所有 path 均相对于 **projectRoot（User 中给出的当前工作目录）**，使用正斜杠；不得用 .. 跳出沙箱。
- **cwd 已是完整项目根**：不要再 createDirectory 一层与项目根**最后一级文件夹同名**的子目录（否则会出现「…/imgShow/imgShow」式重复嵌套）。业务子目录用 src、public 等名称。
- 使用 Vite 等脚手架时，优先 **在当前目录初始化**：例如 \`pnpm create vite . --template react-ts\`（项目名参数用 \`.\`），**不要**再写 \`pnpm create vite 项目文件夹名\` 以免在 projectRoot 下又多一层同名文件夹。
- runCommand 已在 projectRoot 下执行；若脚手架**必须**在子目录生成工程，后续读写仍用相对 projectRoot 的路径。

# 需求—测试—实现（顺序）

1. **需求**：以任务说明、项目目标（goal）与父任务上下文（若有）为准，决定「应该有什么行为」。
2. **测试**：编写或修改测试时，必须先保证测试 **表达的是需求**；若发现测试与需求矛盾，**改测试**。**默认优先「交互逻辑测试」**，不要用整块页面的 DOM/UI 去反推需求。
3. **实现**：在测试正确反映需求的前提下，用业务代码满足测试；失败时先判断「测错了」还是「逻辑未实现」，再动对应一侧。
4. **测试风格（重要）**：**不要**把「验收」绑在 **Testing Library 查 DOM**（getByRole/screen 等）上，除非任务**明确要求**界面级/UI 回归。**优先**测可复用的 **交互与数据流**：例如自定义 hook（\`renderHook\` + mock \`localStorage\`）、纯函数、存储读写封装、事件处理提取成函数后单测；组件保持薄、逻辑下沉到可测模块。
5. 禁止为凑绿而删光断言或空测试；也**禁止**为修测试去大改组件无障碍语义，除非任务明确要求。

# 行为规则（必须遵守）

- 若 User 中出现「本轮范围：最小改动模式」：严格遵守其中条款，**禁止**借机重做全项目；steps 应短、补丁式。
1. 必须输出 JSON，且必须使用 steps 数组（至少一步）。
2. 必须基于已有项目结构进行修改或新增；不要重复创建已存在的文件（除非任务明确要求覆盖）。
3. React + TypeScript：\`useState([])\` 必须写元素类型（如 \`useState<ImageItem[]>([])\`），否则易变成 \`never[]\`；表单/输入的 \`e\` 等参数须标注 \`React.ChangeEvent<...>\` 等类型；路由里 import 的页面必须在同一次 steps 中已存在（readFile 确认或 writeFile 创建）。**Import 与导出一致**：若组件为命名导出（\`export function Foo\`），引用处须 \`import { Foo }\`；若用 default import，组件侧须有 \`export default\`；tsc **TS2613** 即此类问题，须对「被引用文件 + 引用方」一起对齐，勿只改一半。
4. 对已存在文件：先 readFile，再做最小改动；只有确需覆盖时才 writeFile + overwriteExisting=true。禁止无必要全盘重写（尤其 App.tsx/routes/核心组件）。
5. 初始化或构建：优先 pnpm install / pnpm run build / pnpm run test / pnpm create …；**不要**用 pnpm run dev 启动本地服务。使用 pnpm create vite 时务必带齐 --template 等参数；若白名单内无合适命令，用 writeFile/createDirectory 搭结构后再 pnpm install。安装依赖用**单独一步** runCommand。
6. **收尾（前端/TS 项目强制）**：凡修改或新增了 \`.tsx\` / \`.ts\` / 路由等源码，**最后一步必须是**会自行结束的 \`pnpm run build\`（或项目 package.json 中等价的 build 脚本，如 \`npm run build\`），且须在 steps 内真实执行。**禁止**在仍可能 TS 报错、缺文件未补全时结束 steps；否则任务会被视为未完成。
7. writeFile/readFile/listFiles 的 path 须为**相对路径**（相对 projectRoot）；禁止在 path 里写盘符或绝对路径。注意：已存在文件若未显式 overwriteExisting=true，服务端会拒绝覆盖（unsafe_full_overwrite）。
8. 禁止输出 action 为 noop；禁止空 steps。
9. 每一步必须真实可执行；runCommand 会**阻塞到命令退出**。开发服务器（dev/preview）不会自行退出，会导致步骤卡死，已被服务端拒绝；请用 build 等命令验证。
10. 只要任务改动了“行为逻辑”（包括但不限于：新增/修改函数、状态更新流程、事件处理、接口调用、缓存与持久化、副作用、数据流与条件分支），仅 build 通过都不算完成。steps 中必须包含至少一条与本次改动直接对应、且可自动结束的验证命令。选择验证命令前，先检查 \`package.json\` 里已有 scripts，优先复用现成的 \`test / verify / check / e2e\`；不要臆造不存在的脚本。若当前项目确无测试体系，则先补最小测试/验证脚本（及所需依赖/配置），再用 runCommand 实际执行。
11. 若新增 Vitest/Jest 等测试文件或 \`vitest.config.ts\`：必须让验证命令与 \`package.json\` 一致——要么写入 \`scripts.test\`（如 \`"test": "vitest run"\`）再执行 \`pnpm run test\`，要么直接使用 \`pnpm exec vitest run\`；**禁止**在 scripts 中不存在 \`test\` 时仍调用 \`pnpm run test\`。
12. **Vitest + Vite + React**：\`vitest.config.ts\` 须用 \`import { defineConfig } from 'vitest/config'\`，并保留 \`@vitejs/plugin-react\` 的 \`react()\` 插件（与现有项目一致）；**禁止**为「让 build 过」而改成只从 \`vite\` 引入 defineConfig、删掉 React 插件与 \`vitest/config\`，否则会破坏测试与 JSX 编译。若 \`pnpm run build\`（\`tsc -b\`）报测试/config 相关类型错误，优先用 \`tsconfig.app.json\` 的 exclude、references 或把测试移出 app 编译范围，**不要**用空 \`export {}\` 清空 \`App.test.tsx\` 或拆除 Vitest 配置敷衍过关。

只输出 JSON。`;

/** 与任务描述、参数或「微调后重跑」日志配合，触发 User 消息中的最小改动区块 */
const MINIMAL_SCOPE_DESC_REGEX =
  /(仅修复|只做|最小改动|不要重写|不要全量|修复\s*pnpm|修复.*test|test\s*报错|测试失败|补齐.*父|父任务.*未完|父级.*未完)/i;

export type MinimalWorkerScopeSignal = {
  taskDescription: string;
  goal: string;
  parametersWorkerMinimalScope?: boolean;
  parametersExecutionScope?: string;
  lastExecutionLog?: { step: string; meta?: Record<string, unknown> } | null;
};

export function shouldInjectMinimalWorkerScope(
  input: MinimalWorkerScopeSignal,
): boolean {
  if (input.parametersWorkerMinimalScope) {
    return true;
  }
  const scope = input.parametersExecutionScope?.trim().toLowerCase();
  if (
    scope === 'minimal' ||
    scope === 'fix-only' ||
    scope === 'fix_only'
  ) {
    return true;
  }
  const last = input.lastExecutionLog;
  if (
    last?.step === 'task_prepare_rerun' &&
    last.meta &&
    last.meta['source'] === 'refine_execute_prepare'
  ) {
    return true;
  }
  const text = `${input.taskDescription}\n${input.goal}`;
  return MINIMAL_SCOPE_DESC_REGEX.test(text);
}

export function formatMinimalWorkerScopeBlock(): string {
  return [
    '# 本轮范围：最小改动模式（必读）',
    '',
    '系统判定本任务应以**补丁式修复**为主（例如：微调后重跑、说明里强调只修测试/只补齐缺口）。',
    '- **默认继承**仓库已有实现，不要当成从零重做整套功能。',
    '- **readFile** 只读：报错堆栈与失败命令指向的文件、其直接依赖、package.json、相关测试配置；**不要**为「摸底」批量读取 ***.css**、index.css、App.css 等与当前失败无直接关系的大文件。',
    '- **writeFile** 优先最小 diff；**禁止**无任务依据时整份替换测试套件或大面积 RTL/UI 用例。**修复测试失败时优先**把逻辑抽到 hook/工具函数并写交互单测，**避免**继续堆 DOM 查询；除非任务明确要求保留 UI 测试。',
    '- 若目标是「修复 pnpm test / 补齐父任务未完成部分」：只改**直接相关**的少数文件，控制 steps 总数，避免把所有的任务从头做一遍。',
    '',
  ].join('\n');
}

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
  /** 项目根目录（已解析后的绝对路径）；runCommand 的 cwd 与所有相对路径均以此为根 */
  projectRoot: string;
  /** 深度扫描得到的文件列表（最多 50） */
  fileTreeDeep: string[];
  /** 关键文件路径 -> 内容片段 */
  importantFiles: Record<string, string>;
  /** 可选：父任务上下文（当子任务描述明确要求感知父任务时注入） */
  parentTaskContext?: {
    parentTaskId: string;
    parentTaskName: string;
    parentTaskRole: string | null;
    parentTaskDescription: string;
  };
  /** 为 true 时在 User 消息中注入「最小改动模式」说明（微调重跑 / 任务文案 / parameters） */
  minimalScopeHint?: boolean;
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

/** 项目根路径最后一级目录名，用于提示模型勿再嵌套同名文件夹 */
export function projectRootLeafName(projectRootAbs: string): string {
  const t = projectRootAbs.trim();
  if (!t) {
    return '';
  }
  const base =
    /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('\\\\')
      ? path.win32.basename(path.win32.normalize(t))
      : path.basename(path.normalize(t));
  return base && base !== '.' && base !== '/' ? base : '';
}

function formatImportantFiles(files: Record<string, string>): string {
  const keys = Object.keys(files);
  if (keys.length === 0) {
    return '（未找到可注入的关键文件，或文件不可读）';
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
  const leaf = projectRootLeafName(input.projectRoot);
  const antiNest =
    leaf !== ''
      ? [
          '# 目录约定（必读，避免多建一层）',
          '',
          `系统已将 **cwd 设为你的项目根**，其最后一级文件夹名为「${leaf}」。`,
          `- 禁止再执行 createDirectory("${leaf}") 或仅创建名为「${leaf}」的单层目录（否则会出现 .../${leaf}/${leaf}/）。`,
          `- 脚手架：请用「在当前目录创建」的方式，例如 pnpm create vite . --template react-ts（注意项目位置用 **.**），不要 pnpm create vite ${leaf}。`,
          `- 需要子目录时请用 src、public、components 等名称，不要用与项目根文件夹重复的名字。`,
          '',
        ]
      : [];

  const parentTaskBlock = input.parentTaskContext
    ? [
        '# 父级任务上下文（按当前子任务要求注入）',
        `- parentTaskId: ${input.parentTaskContext.parentTaskId}`,
        `- 父任务名称: ${input.parentTaskContext.parentTaskName}`,
        `- 父任务角色: ${input.parentTaskContext.parentTaskRole ?? '（未指定）'}`,
        '- 父任务描述：',
        input.parentTaskContext.parentTaskDescription ||
          '（父任务未提供详细描述）',
        '',
      ]
    : [];

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
    ...(input.minimalScopeHint ? [formatMinimalWorkerScopeBlock()] : []),
    ...parentTaskBlock,
    '# 项目目标',
    input.goal || input.taskName,
    '',
    '# 当前工作目录（projectRoot）',
    '',
    '以下目录为唯一工作区：所有 runCommand 的 cwd、以及 writeFile/readFile/listFiles/createDirectory 的相对路径，均以此为根。',
    '',
    input.projectRoot,
    '',
    '禁止在该目录之外创建或引用文件。',
    '',
    ...antiNest,
    '# 当前项目文件结构（递归扫描，已忽略 node_modules / .git / dist，最多 50 个文件）',
    formatFileTreeLines(input.fileTreeDeep),
    '',
    '# 关键文件内容（节选；含基础骨架文件 + 与任务更相关的页面/组件/路由，每文件最多 2000 字符）',
    formatImportantFiles(input.importantFiles),
    '',
    '# 输出要求',
    '- 顶层 JSON 含 steps 数组，按顺序执行（禁止 noop）。',
    '- 若技术栈含 Vite/React 等前端构建：steps **最后一项**须为 pnpm run build（或等价 build），用于确认 TypeScript 与打包通过；改文件后未跑 build 视为不合格计划。',
    '',
    '# 请你输出一条 JSON：顶层含 steps 数组，按顺序完成本任务（禁止 noop）',
  ].join('\n');

  return clipWorkerUserPrompt(body);
}
