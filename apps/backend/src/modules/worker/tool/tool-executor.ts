import { exec } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { normalizeAction } from './action-normalize';
import { resolveUnderBase } from './path-sandbox';
import { toolListFiles, toolReadFile, toolWriteFile } from './file-tools';

const execAsync = promisify(exec);

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

/** 仅允许这些前缀开头的 shell 命令（防任意命令执行） */
const ALLOWED_COMMAND_PREFIXES = [
  'pnpm create vite',
  'pnpm install',
  'pnpm add',
] as const;

function assertAllowedCommand(command: string): void {
  const c = command.trim();
  if (
    !ALLOWED_COMMAND_PREFIXES.some((prefix) => c.startsWith(prefix))
  ) {
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
          if (!pathStr) {
            return {
              success: false,
              tool: action,
              error: 'writeFile requires args.path',
            };
          }
          const r = await toolWriteFile(baseDir, pathStr, content);
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
          const cwdArg = args.cwd;
          const resolvedCwd =
            cwdArg !== undefined && cwdArg !== null && String(cwdArg).trim() !== ''
              ? resolveUnderBase(baseDir, String(cwdArg))
              : baseDir;
          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: resolvedCwd,
              maxBuffer: 10 * 1024 * 1024,
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
