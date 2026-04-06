import { ConfigService } from '@nestjs/config';

/**
 * 写入 Redis 执行日志时，对 LLM 原文做可选截断。
 * 环境变量 `LLM_RAW_LOG_MAX_CHARS`：
 * - 未设置或 `0`：不截断，写入完整内容
 * - 正整数：超过则截断并追加 `…(truncated)`
 */
export function clipLlmRawForRedis(
  config: ConfigService,
  raw: string,
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = raw.length;
  const rawEnv = config.get<string>('LLM_RAW_LOG_MAX_CHARS', '0');
  const max = parseInt(rawEnv.trim(), 10);
  if (!Number.isFinite(max) || max <= 0) {
    return { text: raw, truncated: false, totalChars };
  }
  if (raw.length <= max) {
    return { text: raw, truncated: false, totalChars };
  }
  return {
    text: `${raw.slice(0, max)}…(truncated)`,
    truncated: true,
    totalChars,
  };
}
