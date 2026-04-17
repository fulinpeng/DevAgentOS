import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SPLIT_TASK_SYSTEM_PROMPT,
  type WorkflowPlannerInput,
  buildSplitTaskUserPayload,
  buildWorkflowSystemPrompt,
  buildWorkflowUserPrompt,
} from './split-task.prompt';

const DEFAULT_COMPAT_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/** DashScope 兼容 OpenAI Chat Completions；超时避免长时间挂起 */
const LLM_REQUEST_TIMEOUT_MS = 120_000;

export type CallLlmOptions = {
  /**
   * 使用 OpenAI 兼容的 `response_format: { type: "json_object" }`（DashScope 亦支持）。
   * 将单次补全约束为**一个** JSON 对象，从协议层避免模型在同一条回复里拼接多段 `{...}{...}`。
   * 要求 messages 中含 “json” 字样（见阿里云文档）；不适用于需返回 JSON 数组的接口（如部分 workflow 拆分）。
   */
  jsonObject?: boolean;
};

function getDashScopeApiKey(config: ConfigService): string {
  return (
    config.get<string>('DASHSCOPE_API_KEY') ??
    config.get<string>('QWEN_API_KEY') ??
    ''
  ).trim();
}

/**
 * Workflow 专用 LLM 网关：DashScope OpenAI 兼容接口，只负责文本补全，不执行业务。
 * 生成计划请使用 {@link callWorkflowPlanner}；旧版 {@link callSplitTaskJson} 仅保留兼容。
 */
@Injectable()
export class WorkflowLlmService {
  private readonly logger = new Logger(WorkflowLlmService.name);

  constructor(private readonly config: ConfigService) {}

  private async postChatCompletion(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    jsonObject: boolean;
  }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      LLM_REQUEST_TIMEOUT_MS,
    );
    try {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        temperature: 0.2,
      };
      if (params.jsonObject) {
        body.response_format = { type: 'json_object' };
      }
      return await fetch(params.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 通用调用：传入完整 user 内容时可配合外部 system。
   * 默认用于拆分任务时请使用 {@link callSplitTaskJson}。
   */
  async callLLM(
    systemPrompt: string,
    userPrompt: string,
    options?: CallLlmOptions,
  ): Promise<string> {
    const apiKey = getDashScopeApiKey(this.config);
    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is not set');
    }

    const baseUrl =
      this.config.get<string>('LLM_BASE_URL') ?? DEFAULT_COMPAT_URL;
    const model = this.config.get<string>('LLM_MODEL', 'qwen-turbo');
    const wantJsonObject = Boolean(options?.jsonObject);

    const run = async (jsonObject: boolean): Promise<Response> => {
      try {
        return await this.postChatCompletion({
          baseUrl,
          apiKey,
          model,
          systemPrompt,
          userPrompt,
          jsonObject,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('abort') || msg.includes('Abort')) {
          throw new Error(
            `LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`,
          );
        }
        throw e;
      }
    };

    let res = await run(wantJsonObject);

    if (!res.ok && wantJsonObject && res.status === 400) {
      const errText = await res.text();
      const retriable =
        /response_format|json_object|must contain the word ['"]json['"]/i.test(
          errText,
        );
      if (retriable) {
        this.logger.warn(
          `LLM json_object 模式被拒（400），回退为普通补全：${errText.slice(0, 400)}`,
        );
        res = await run(false);
      } else {
        throw new Error(`LLM request failed ${res.status}: ${errText}`);
      }
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
      `LLM 请求成功（已接入）：model=${model} endpoint=${host} charsOut=${content.trim().length} jsonObjectRequested=${wantJsonObject}`,
    );
    return content.trim();
  }

  /** 使用结构化 prompt 调用，返回模型原始文本（应为 JSON 数组）。 */
  async callSplitTaskJson(name: string, features: string[]): Promise<string> {
    const user = buildSplitTaskUserPayload(name, features);
    return this.callLLM(SPLIT_TASK_SYSTEM_PROMPT, user);
  }

  /**
   * Workflow Planner：返回完整 Workflow JSON 字符串；网络/鉴权/解析失败时返回 null。
   */
  async callWorkflowPlanner(
    input: WorkflowPlannerInput,
  ): Promise<string | null> {
    try {
      const systemPrompt = buildWorkflowSystemPrompt();
      const userPrompt = buildWorkflowUserPrompt(input);
      return await this.callLLM(systemPrompt, userPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`callWorkflowPlanner failed: ${msg}`);
      return null;
    }
  }
}
