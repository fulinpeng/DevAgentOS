/**
 * 解析 / 校验任务微调 LLM 输出（纯函数，无框架依赖）。
 */

export type RefinementStep = {
  action: string;
  args: Record<string, unknown>;
};

export type RefinementPayload = {
  description: string;
  parameters: Record<string, unknown>;
  steps: RefinementStep[];
};

function stripMarkdownFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : text.trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 校验已解析对象（与 LLM 输出结构一致）；不合法返回 null。
 */
export function refinePayloadFromValue(parsed: unknown): RefinementPayload | null {
  if (!isPlainObject(parsed)) {
    return null;
  }
  const o = parsed;
  if (typeof o.description !== 'string' || !o.description.trim()) {
    return null;
  }
  if (!isPlainObject(o.parameters)) {
    return null;
  }
  if (!Array.isArray(o.steps)) {
    return null;
  }
  const steps: RefinementStep[] = [];
  for (const item of o.steps) {
    if (!isPlainObject(item)) {
      return null;
    }
    const s = item as Record<string, unknown>;
    if (typeof s.action !== 'string' || !s.action.trim()) {
      return null;
    }
    const args =
      s.args !== undefined && isPlainObject(s.args)
        ? s.args
        : s.args === undefined
          ? {}
          : null;
    if (args === null) {
      return null;
    }
    steps.push({ action: s.action.trim(), args });
  }
  return {
    description: o.description.trim(),
    parameters: { ...o.parameters },
    steps,
  };
}

/**
 * 校验并返回结构化结果；不合法返回 null。
 */
export function parseRefinementLlmOutput(raw: string): RefinementPayload | null {
  const text = stripMarkdownFence(raw);
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return refinePayloadFromValue(parsed);
}
