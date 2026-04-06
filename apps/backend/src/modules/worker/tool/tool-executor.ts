import { Injectable, Logger } from '@nestjs/common';
import { normalizeAction } from './action-normalize';
import { toolListFiles, toolReadFile, toolWriteFile } from './file-tools';

export const ALLOWED_TOOLS = [
  'writeFile',
  'readFile',
  'listFiles',
  'noop',
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export type ToolExecuteResult = {
  success: boolean;
  tool: string;
  data?: Record<string, unknown>;
  error?: string;
};

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
