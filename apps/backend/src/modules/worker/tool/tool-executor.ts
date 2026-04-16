import { exec } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { normalizeAction } from './action-normalize';
import { resolveUnderBase } from './path-sandbox';
import { toolListFiles, toolReadFile, toolWriteFile } from './file-tools';

const execAsync = promisify(exec);

/**
 * `pnpm create vite` / `pnpm install` 等若子进程不退出，未设置 timeout 会导致 Node 一直等待，
 * Worker 无法写入 step_success，任务长期 RUNNING。超时后子进程会被终止并返回 run_command_timeout。
 */
const RUN_COMMAND_TIMEOUT_MS = 600_000; // 10 分钟

function isRunCommandExecTimeout(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) {
    return false;
  }
  const ex = e as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string;
  };
  if (ex.code === 'ETIMEDOUT') {
    return true;
  }
  const msg = String(ex.message ?? '').toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return true;
  }
  /** Node 在 timeout 到期后会 kill 子进程；Windows 上常见 killed + SIGTERM */
  if (ex.killed === true) {
    return true;
  }
  return false;
}

export const ALLOWED_TOOLS = [
  'writeFile',
  'readFile',
  'listFiles',
  'runCommand',
  'createDirectory',
  'noop',
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export type ToolExecuteResult = {
  success: boolean;
  tool: string;
  data?: Record<string, unknown>;
  error?: string;
};

/**
 * 仅允许这些前缀开头的 shell 命令（防任意命令执行）。
 * 较长前缀须优先匹配（例如 pnpm create vite 先于 pnpm create）。
 */
const ALLOWED_COMMAND_PREFIXES = [
  'pnpm create vite',
  'pnpm create',
  'pnpm install',
  'pnpm add',
  'pnpm run',
  'pnpm exec',
  'pnpm dlx',
  'pnpm remove',
  'pnpm update',
  'npm install',
  'npm ci',
  'npm run',
  'npm create',
  'npm exec',
  'yarn install',
  'yarn add',
  'yarn run',
  'yarn create',
] as const;

const ALLOWED_COMMAND_PREFIXES_SORTED = [...ALLOWED_COMMAND_PREFIXES].sort(
  (a, b) => b.length - a.length,
);

/**
 * 开发服务器 / 常驻进程：exec 会一直等待，导致 Worker 步骤无法结束。
 * 允许 vite build；禁止 vite、vite preview、pnpm run dev 等。
 */
export function isLongRunningDevServerCommand(command: string): boolean {
  const c = command.trim();
  if (!c) {
    return false;
  }

  if (/^vite\s+build(\s|$)/i.test(c)) {
    return false;
  }
  if (/^vite(\s|$)/i.test(c)) {
    return true;
  }

  const blocked = [
    /^pnpm\s+run\s+dev(\s|$)/i,
    /^pnpm\s+run\s+preview(\s|$)/i,
    /^pnpm\s+dev(\s|$)/i,
    /^npm\s+run\s+dev(\s|$)/i,
    /^npm\s+run\s+preview(\s|$)/i,
    /^yarn\s+run\s+dev(\s|$)/i,
    /^yarn\s+run\s+preview(\s|$)/i,
    /^yarn\s+dev(\s|$)/i,
    /^next\s+dev(\s|$)/i,
    /^webpack\s+serve(\s|$)/i,
    /^webpack-dev-server(\s|$)/i,
    /^astro\s+dev(\s|$)/i,
    /^nuxt\s+dev(\s|$)/i,
    /^ng\s+serve(\s|$)/i,
  ];
  return blocked.some((re) => re.test(c));
}

const LONG_RUNNING_HINT =
  'run_command_long_running: 开发服务器会持续运行，Worker 需等待子进程结束，无法用于 dev/preview。请改用 pnpm run build（或 test/lint）验证；本地调试请在终端手动执行 pnpm run dev。';

/**
 * 若仅创建「与项目根最后一级同名」的单层目录，会在 projectRoot 下多嵌套一层（如 .../imgShow/imgShow）。
 */
function isRedundantSameNameAsProjectRoot(
  baseDir: string,
  relativePath: string,
): boolean {
  const leaf = path.basename(path.normalize(baseDir));
  if (!leaf || leaf === '.' || leaf === path.sep) {
    return false;
  }
  const norm = relativePath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.\//, '');
  const segments = norm.split('/').filter(Boolean);
  return segments.length === 1 && segments[0] === leaf;
}

function assertAllowedCommand(command: string): void {
  const c = command.trim();
  if (!ALLOWED_COMMAND_PREFIXES_SORTED.some((prefix) => c.startsWith(prefix))) {
    throw new Error(
      `Command not allowed (must start with one of: ${ALLOWED_COMMAND_PREFIXES.join(', ')})`,
    );
  }
}

@Injectable()
export class ToolExecutor {
  private readonly logger = new Logger(ToolExecutor.name);

  async execute(
    actionRaw: string,
    args: Record<string, unknown>,
    baseDir: string,
  ): Promise<ToolExecuteResult> {
    const action = normalizeAction(actionRaw) as AllowedTool | string;
    if (!ALLOWED_TOOLS.includes(action as AllowedTool)) {
      return {
        success: false,
        tool: action,
        error: `tool not allowed: ${actionRaw} (normalized: ${action})`,
      };
    }

    try {
      switch (action) {
        case 'noop':
          return { success: true, tool: 'noop', data: { acknowledged: true } };
        case 'writeFile': {
          const pathStr = String(args.path ?? '');
          const content = String(args.content ?? '');
          const overwriteExisting =
            args.overwriteExisting === true || args.allowOverwrite === true;
          if (!pathStr) {
            return {
              success: false,
              tool: action,
              error: 'writeFile requires args.path',
            };
          }
          const r = await toolWriteFile(baseDir, pathStr, content, {
            overwriteExisting,
          });
          return r.success
            ? { success: true, tool: action, data: r.data }
            : { success: false, tool: action, error: r.error };
        }
        case 'readFile': {
          const pathStr = String(args.path ?? '');
          if (!pathStr) {
            return {
              success: false,
              tool: action,
              error: 'readFile requires args.path',
            };
          }
          const r = await toolReadFile(baseDir, pathStr);
          return r.success
            ? { success: true, tool: action, data: r.data }
            : { success: false, tool: action, error: r.error };
        }
        case 'listFiles': {
          const pathStr = String(args.path ?? '.');
          const r = await toolListFiles(baseDir, pathStr);
          return r.success
            ? { success: true, tool: action, data: r.data }
            : { success: false, tool: action, error: r.error };
        }
        case 'createDirectory': {
          const pathStr = String(args.path ?? '');
          if (!pathStr) {
            return {
              success: false,
              tool: action,
              error: 'createDirectory requires args.path',
            };
          }
          if (isRedundantSameNameAsProjectRoot(baseDir, pathStr)) {
            return {
              success: false,
              tool: action,
              error: `createDirectory("${pathStr}") 与项目根文件夹同名，会多嵌套一层；cwd 已是项目根，请改用 src/public 等子目录，或脚手架使用 pnpm create vite .`,
            };
          }
          const full = resolveUnderBase(baseDir, pathStr);
          mkdirSync(full, { recursive: true });
          return {
            success: true,
            tool: action,
            data: { path: pathStr },
          };
        }
        case 'runCommand': {
          const command = String(args.command ?? '').trim();
          if (!command) {
            return {
              success: false,
              tool: action,
              error: 'runCommand requires args.command',
            };
          }
          try {
            assertAllowedCommand(command);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, tool: action, error: msg };
          }
          if (isLongRunningDevServerCommand(command)) {
            return {
              success: false,
              tool: action,
              error: LONG_RUNNING_HINT,
              data: {
                code: 'run_command_long_running',
                command,
              },
            };
          }
          /** 与文件工具一致：始终在 projectRoot（baseDir）下执行，忽略 args.cwd */
          const resolvedCwd = baseDir;
          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: resolvedCwd,
              maxBuffer: 10 * 1024 * 1024,
              timeout: RUN_COMMAND_TIMEOUT_MS,
            });
            return {
              success: true,
              tool: action,
              data: {
                command,
                cwd: resolvedCwd,
                stdout: String(stdout).slice(0, 12_000),
                stderr: String(stderr).slice(0, 4000),
              },
            };
          } catch (e: unknown) {
            const ex = e as {
              message?: string;
              stdout?: string;
              stderr?: string;
              code?: number;
            };
            if (isRunCommandExecTimeout(e)) {
              return {
                success: false,
                tool: action,
                error: 'run_command_timeout',
                data: {
                  code: 'run_command_timeout',
                  command,
                  cwd: resolvedCwd,
                  stdout: ex.stdout ? String(ex.stdout).slice(0, 4000) : undefined,
                  stderr: ex.stderr ? String(ex.stderr).slice(0, 4000) : undefined,
                },
              };
            }
            const msg =
              ex.message ??
              `runCommand failed (code=${ex.code ?? '?'})`;
            return {
              success: false,
              tool: action,
              error: msg,
              data: {
                command,
                cwd: resolvedCwd,
                stdout: ex.stdout ? String(ex.stdout).slice(0, 4000) : undefined,
                stderr: ex.stderr ? String(ex.stderr).slice(0, 4000) : undefined,
              },
            };
          }
        }
        default:
          return {
            success: false,
            tool: action,
            error: 'unreachable',
          };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`tool error: ${action}: ${msg}`);
      return { success: false, tool: action, error: msg };
    }
  }
}
