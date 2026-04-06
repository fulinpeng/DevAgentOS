import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SPLIT_TASK_SYSTEM_PROMPT,
  buildSplitTaskUserPayload,
} from './split-task.prompt';

const DEFAULT_COMPAT_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/** DashScope 兼容 OpenAI Chat Completions；超时避免长时间挂起 */
const LLM_REQUEST_TIMEOUT_MS = 120_000;

function getDashScopeApiKey(config: ConfigService): string {
  return (
    config.get<string>('DASHSCOPE_API_KEY') ??
    config.get<string>('QWEN_API_KEY') ??
    ''
  ).trim();
}

/**
 * Workflow 专用 LLM 网关：DashScope OpenAI 兼容接口，只负责文本补全，不执行业务。
 * 拆任务须调用 {@link callSplitTaskJson}；不再提供「无 LLM 时规则拆分」。
 */
@Injectable()
export class WorkflowLlmService {
  private readonly logger = new Logger(WorkflowLlmService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 通用调用：传入完整 user 内容时可配合外部 system。
   * 默认用于拆分任务时请使用 {@link callSplitTaskJson}。
   */
  async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = getDashScopeApiKey(this.config);
    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is not set');
    }

    const baseUrl =
      this.config.get<string>('LLM_BASE_URL') ?? DEFAULT_COMPAT_URL;
    const model = this.config.get<string>('LLM_MODEL', 'qwen-turbo');

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      LLM_REQUEST_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort') || msg.includes('Abort')) {
        throw new Error(`LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM returned empty or invalid content');
    }
    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* keep raw */
    }
    this.logger.log(
      `LLM 请求成功（已接入）：model=${model} endpoint=${host} charsOut=${content.trim().length}`,
    );
    return content.trim();
  }

  /** 使用结构化 prompt 调用，返回模型原始文本（应为 JSON 数组）。 */
  async callSplitTaskJson(name: string, features: string[]): Promise<string> {
    const user = buildSplitTaskUserPayload(name, features);
    return this.callLLM(SPLIT_TASK_SYSTEM_PROMPT, user);
  }

}
