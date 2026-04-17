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

const LLM_REQUEST_TIMEOUT_DEFAULT_MS = 120_000;
const LLM_REQUEST_TIMEOUT_MIN_MS = 30_000;
const LLM_REQUEST_TIMEOUT_MAX_MS = 900_000;

function readLlmRequestTimeoutMs(config: ConfigService): number {
  const raw = config.get<string>('LLM_REQUEST_TIMEOUT_MS');
  if (raw === undefined || raw.trim() === '') {
    return LLM_REQUEST_TIMEOUT_DEFAULT_MS;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    return LLM_REQUEST_TIMEOUT_DEFAULT_MS;
  }
  return Math.min(
    LLM_REQUEST_TIMEOUT_MAX_MS,
    Math.max(LLM_REQUEST_TIMEOUT_MIN_MS, Math.floor(n)),
  );
}

function readLlmStreamEnabled(config: ConfigService): boolean {
  const raw = config.get<string>('LLM_STREAM');
  if (!raw) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

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
    stream: boolean;
    timeoutMs: number;
  }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      params.timeoutMs,
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
      if (params.stream) {
        body.stream = true;
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

  private extractContentFromChunk(chunk: unknown): string {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      return '';
    }
    const obj = chunk as Record<string, unknown>;
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return '';
    }
    const first = choices[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      return '';
    }
    const c = first as Record<string, unknown>;
    const delta = c.delta;
    if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
      const content = (delta as Record<string, unknown>).content;
      return typeof content === 'string' ? content : '';
    }
    const message = c.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      return typeof content === 'string' ? content : '';
    }
    return '';
  }

  private async readStreamedContent(res: Response): Promise<string> {
    if (!res.body) {
      throw new Error('LLM stream response body is empty');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let out = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            break;
          }
          if (payload) {
            try {
              const parsed = JSON.parse(payload) as unknown;
              out += this.extractContentFromChunk(parsed);
            } catch {
              /* 忽略非 JSON 行，兼容部分代理注入噪声 */
            }
          }
        }
        nl = buffer.indexOf('\n');
      }
    }
    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }
    if (buffer.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(buffer.trim()) as unknown;
        out += this.extractContentFromChunk(parsed);
      } catch {
        /* ignore trailing non-json */
      }
    }
    return out.trim();
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
    const useStream = readLlmStreamEnabled(this.config);
    const timeoutMs = readLlmRequestTimeoutMs(this.config);

    const run = async (
      jsonObject: boolean,
      stream: boolean,
    ): Promise<Response> => {
      try {
        return await this.postChatCompletion({
          baseUrl,
          apiKey,
          model,
          systemPrompt,
          userPrompt,
          jsonObject,
          stream,
          timeoutMs,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('abort') || msg.includes('Abort')) {
          const inner =
            e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          throw new Error(
            `LLM request timed out after ${timeoutMs}ms (${inner})`,
            { cause: e },
          );
        }
        throw e;
      }
    };

    let res = await run(wantJsonObject, useStream);

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
        res = await run(false, useStream);
      } else {
        throw new Error(`LLM request failed ${res.status}: ${errText}`);
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed ${res.status}: ${text}`);
    }

    const content = useStream
      ? await this.readStreamedContent(res)
      : ((await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        }).choices?.[0]?.message?.content;
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
      `LLM 请求成功（已接入）：model=${model} endpoint=${host} charsOut=${content.trim().length} jsonObjectRequested=${wantJsonObject} stream=${useStream}`,
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
