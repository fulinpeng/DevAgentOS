/**
 * 纯领域：风险评估（系统规则，不由 AI 裁决）。
 */

import { RiskLevel } from '@ai-orchestrator/shared';

export type RiskTaskSnapshot = {
  name: string;
  parameters: unknown;
};

function parametersRecord(
  parameters: unknown,
): Record<string, unknown> | undefined {
  if (
    parameters !== null &&
    typeof parameters === 'object' &&
    !Array.isArray(parameters)
  ) {
    return parameters as Record<string, unknown>;
  }
  return undefined;
}

/**
 * 第一版规则（确定性）：
 * - 名称含 delete → HIGH（优先于来源）
 * - source === llm → MEDIUM
 * - 否则 → LOW
 */
export function evaluateRisk(task: RiskTaskSnapshot): RiskLevel {
  if (task.name.toLowerCase().includes('delete')) {
    return RiskLevel.HIGH;
  }
  const p = parametersRecord(task.parameters);
  if (p?.source === 'llm') {
    return RiskLevel.MEDIUM;
  }
  return RiskLevel.LOW;
}

/** 优先读已持久化的 `parameters.riskLevel`，否则按规则现算（只读展示用） */
export function resolveRiskLevelForDisplay(task: RiskTaskSnapshot): RiskLevel {
  const p = parametersRecord(task.parameters);
  const stored = p?.riskLevel;
  if (
    stored === RiskLevel.LOW ||
    stored === RiskLevel.MEDIUM ||
    stored === RiskLevel.HIGH
  ) {
    return stored;
  }
  return evaluateRisk(task);
}
