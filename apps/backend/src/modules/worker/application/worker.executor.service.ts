import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  buildWorkerUserContent,
  WORKER_TOOL_SYSTEM_PROMPT,
} from '../infrastructure/worker-llm.prompt';
import { ToolExecutor } from '../tool/tool-executor';
import { normalizeAction } from '../tool/action-normalize';

function getDashScopeApiKey(config: ConfigService): string {
  return (
    config.get<string>('DASHSCOPE_API_KEY') ??
    config.get<string>('QWEN_API_KEY') ??
    ''
  ).trim();
}

export type WorkerLlmStep = {
  action: string;
  args: Record<string, unknown>;
};

/**
 * 解析 LLM 输出：优先 `steps[]`，否则兼容单条 `{ action, args }`。
 */
function parseWorkerLlmOutput(text: string): WorkerLlmStep[] | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return null;
    }
    const r = o as Record<string, unknown>;

    if (Array.isArray(r.steps) && r.steps.length > 0) {
      const out: WorkerLlmStep[] = [];
      for (const item of r.steps) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }
        const s = item as Record<string, unknown>;
        if (s.action === undefined || s.action === null) {
          return null;
        }
        const action = String(s.action).trim();
        if (!action) {
          return null;
        }
        const args =
          s.args && typeof s.args === 'object' && !Array.isArray(s.args)
            ? (s.args as Record<string, unknown>)
            : {};
        out.push({ action, args });
      }
      return out;
    }

    if (r.action !== undefined && r.action !== null) {
      const action = String(r.action).trim();
      if (!action) {
        return null;
      }
      const args =
        r.args && typeof r.args === 'object' && !Array.isArray(r.args)
          ? (r.args as Record<string, unknown>)
          : {};
      return [{ action, args }];
    }

    return null;
  } catch {
    return null;
  }
}

function stepsContainOnlyNoop(steps: WorkerLlmStep[]): boolean {
  return steps.every((s) => normalizeAction(s.action) === 'noop');
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

    if (!apiKey) {
      this.logger.log(
        `Worker LLM 未调用（无 API Key），taskId=${task.id}，使用 noop`,
      );
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_skipped',
        time: new Date().toISOString(),
        meta: { reason: 'no_dashscope_or_qwen_api_key' },
      });
      const toolResult = await this.toolExecutor.execute('noop', {}, baseDir);
      return {
        success: toolResult.success,
        result: {
          action: toolResult.tool,
          ...(toolResult.data ?? {}),
          ...(toolResult.error ? { error: toolResult.error } : {}),
        },
      };
    }

    if (!existsSync(baseDir)) {
      try {
        await mkdir(baseDir, { recursive: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          result: { error: `worker_sandbox_mkdir_failed: ${msg}` },
        };
      }
    }

    const listRes = await this.toolExecutor.execute(
      'listFiles',
      { path: '.' },
      baseDir,
    );
    const fileTree: string[] =
      listRes.success && Array.isArray(listRes.data?.entries)
        ? (listRes.data!.entries as string[])
        : [];
    if (!listRes.success) {
      this.logger.warn(
        `Worker 列出沙箱目录失败（将继续 LLM）：${listRes.error ?? 'unknown'}`,
      );
    }

    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'worker_context_injected',
      time: new Date().toISOString(),
      meta: {
        outputDirRelative: rel,
        baseDir,
        fileTree,
        listFilesOk: listRes.success,
      },
    });

    this.logger.log(
      `Worker LLM 将调用：taskId=${task.id} files=${fileTree.length}`,
    );

    const user = buildWorkerUserContent({
      taskId: task.id,
      taskName: task.name,
      role: task.role,
      outputDirRelative: rel,
      fileTree,
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

    const steps = parseWorkerLlmOutput(raw);
    if (!steps || steps.length === 0) {
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

    if (stepsContainOnlyNoop(steps)) {
      const clipped = clipLlmRawForRedis(this.config, raw);
      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'worker_llm_rejected_noop',
        time: new Date().toISOString(),
        meta: {
          raw: clipped.text,
          fileTree,
          hint: '禁止 noop；请使用 steps 产出 runCommand/writeFile/createDirectory 等',
        },
      });
      return {
        success: false,
        result: {
          error: 'worker_llm_rejected_noop',
          message:
            '模型返回了 noop；当前策略要求必须产出可执行步骤（如 runCommand、writeFile）。',
          raw: clipped.text,
        },
      };
    }

    const clippedOk = clipLlmRawForRedis(this.config, raw);
    await this.taskRedis.appendExecutionLog(task.id, {
      step: 'worker_llm_ok',
      time: new Date().toISOString(),
      meta: {
        stepCount: steps.length,
        raw: clippedOk.text,
        rawChars: clippedOk.totalChars,
        rawTruncated: clippedOk.truncated,
        fileTree,
      },
    });
    this.logger.log(
      `Worker LLM 已接入：steps=${steps.length} taskId=${task.id}`,
    );

    const stepResults: Array<{
      index: number;
      action: string;
      success: boolean;
      error?: string;
    }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const isoTime = new Date().toISOString();

      await this.taskRedis.appendExecutionLog(task.id, {
        step: 'step_start',
        time: isoTime,
        meta: { index: i, action: step.action, args: step.args },
      });

      const toolResult = await this.toolExecutor.execute(
        step.action,
        step.args,
        baseDir,
      );

      if (toolResult.success) {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'step_success',
          time: new Date().toISOString(),
          meta: {
            index: i,
            tool: toolResult.tool,
            data: toolResult.data,
          },
        });
        stepResults.push({
          index: i,
          action: toolResult.tool,
          success: true,
        });
        if (toolResult.tool === 'writeFile') {
          await this.taskRedis.appendExecutionLog(task.id, {
            step: 'file_written',
            time: new Date().toISOString(),
            meta: toolResult.data,
          });
        }
      } else {
        await this.taskRedis.appendExecutionLog(task.id, {
          step: 'step_fail',
          time: new Date().toISOString(),
          meta: {
            index: i,
            tool: toolResult.tool,
            error: toolResult.error,
          },
        });
        stepResults.push({
          index: i,
          action: toolResult.tool,
          success: false,
          error: toolResult.error,
        });
        return {
          success: false,
          result: {
            mode: 'steps',
            failedAtIndex: i,
            steps: stepResults,
            error: toolResult.error,
            lastTool: toolResult.tool,
          },
        };
      }
    }

    const last = stepResults[stepResults.length - 1];
    return {
      success: true,
      result: {
        mode: 'steps',
        stepsExecuted: steps.length,
        steps: stepResults,
        lastAction: last?.action,
        /** 与旧版单 action 结果对齐，便于调用方 / 测试断言 */
        action: last?.action,
      },
    };
  }
}
