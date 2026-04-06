import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clipLlmRawForRedis } from '../../../infrastructure/llm-log-meta';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  IWorkerExecutor,
  WorkerExecuteInput,
  WorkerExecuteOutput,
} from '../../role/infrastructure/worker.executor';
import { WorkflowLlmService } from '../../workflow/infrastructure/llm.service';
import {
  getWorkspaceRoot,
  resolveOutputDirRelative,
  toAbsoluteSandbox,
} from '../infrastructure/resolve-output-dir';
import {
  buildWorkerUserPayload,
  WORKER_TOOL_SYSTEM_PROMPT,
} from '../infrastructure/worker-llm.prompt';
import { ToolExecutor } from '../tool/tool-executor';

function getDashScopeApiKey(config: ConfigService): string {
  return (
    config.get<string>('DASHSCOPE_API_KEY') ??
    config.get<string>('QWEN_API_KEY') ??
    ''
  ).trim();
}

function parseWorkerActionJson(text: string): {
  action: string;
  args: Record<string, unknown>;
} | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    const action = String(r.action ?? 'noop');
    const args =
      r.args && typeof r.args === 'object' && !Array.isArray(r.args)
        ? (r.args as Record<string, unknown>)
        : {};
    return { action, args };
  } catch {
    return null;
  }
}

@Injectable()
export class WorkerExecutorService implements IWorkerExecutor {
  private readonly logger = new Logger(WorkerExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: WorkflowLlmService,
    private readonly toolExecutor: ToolExecutor,
    private readonly taskRedis: TaskRedis,
  ) {}

  async execute(task: WorkerExecuteInput): Promise<WorkerExecuteOutput> {
    const rel = await resolveOutputDirRelative(
      this.prisma,
      task.parameters,
      task.parentId,
    );
    if (!rel) {
      return {
        success: false,
        result: {
          error:
            '未配置 outputDir：请在根任务的 parameters.outputDir 中设置相对仓库根的路径（子任务会继承父任务）。',
        },
      };
    }

    const workspaceRoot = getWorkspaceRoot(this.config);
    const baseDir = toAbsoluteSandbox(workspaceRoot, rel);

    const apiKey = getDashScopeApiKey(this.config);
    let action: string;
    let args: Record<string, unknown>;

    if (!apiKey) {
      this.logger.log(
        `Worker LLM 未调用（无 API Key），taskId=${task.id}，使用 noop`,
      );
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_skipped',
        time: new Date().toISOString(),
        meta: { reason: 'no_dashscope_or_qwen_api_key' },
      });
      action = 'noop';
      args = {};
    } else {
      this.logger.log(`Worker LLM 将调用：taskId=${task.id}`);
      const user = buildWorkerUserPayload({
        id: task.id,
        name: task.name,
        role: task.role,
      });
      let raw: string;
      try {
        raw = await this.llm.callLLM(WORKER_TOOL_SYSTEM_PROMPT, user);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Worker LLM failed: ${msg}`);
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'worker_llm_error',
          time: new Date().toISOString(),
          meta: { message: msg.slice(0, 300) },
        });
        return {
          success: false,
          result: { error: `worker_llm_failed: ${msg}` },
        };
      }
      const parsed = parseWorkerActionJson(raw);
      if (!parsed) {
        const clipped = clipLlmRawForRedis(this.config, raw);
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'worker_llm_invalid_json',
          time: new Date().toISOString(),
          meta: {
            raw: clipped.text,
            rawChars: clipped.totalChars,
            rawTruncated: clipped.truncated,
          },
        });
        return {
          success: false,
          result: {
            error: 'worker_llm_invalid_json',
            raw: clipped.text,
            rawChars: clipped.totalChars,
            rawTruncated: clipped.truncated,
          },
        };
      }
      action = parsed.action;
      args = parsed.args;
      const clippedOk = clipLlmRawForRedis(this.config, raw);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_ok',
        time: new Date().toISOString(),
        meta: {
          action,
          raw: clippedOk.text,
          rawChars: clippedOk.totalChars,
          rawTruncated: clippedOk.truncated,
        },
      });
      this.logger.log(
        `Worker LLM 已接入：解析 action=${action} taskId=${task.id}`,
      );
    }

    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'tool_called',
      time: new Date().toISOString(),
      meta: { action, baseDir },
    });

    const toolResult = await this.toolExecutor.execute(action, args, baseDir);

    if (toolResult.tool === 'writeFile' && toolResult.success) {
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'file_written',
        time: new Date().toISOString(),
        meta: toolResult.data,
      });
    }

    return {
      success: toolResult.success,
      result: {
        action: toolResult.tool,
        ...(toolResult.data ?? {}),
        ...(toolResult.error ? { error: toolResult.error } : {}),
      },
    };
  }
}
