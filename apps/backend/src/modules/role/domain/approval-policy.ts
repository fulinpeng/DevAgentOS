/**
 * 纯领域：是否需要人工审批（无框架 / ORM 依赖）。
 * 与 {@link evaluateRisk} 联动：HIGH / MEDIUM 默认需审批，LOW 自动执行。
 */

import { RiskLevel } from '@ai-orchestrator/shared';
import { evaluateRisk } from './risk-policy';

export type ApprovalTaskSnapshot = {
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

export function shouldRequireApproval(task: ApprovalTaskSnapshot): boolean {
  const p = parametersRecord(task.parameters);
  if (p?.approvalGranted === true) {
    return false;
  }
  const risk = evaluateRisk(task);
  return risk === RiskLevel.HIGH || risk === RiskLevel.MEDIUM;
}

/** 供控制台展示的简短说明 */
export function approvalReason(task: ApprovalTaskSnapshot): string | null {
  if (!shouldRequireApproval(task)) {
    return null;
  }
  const risk = evaluateRisk(task);
  if (risk === RiskLevel.HIGH) {
    return '需要审批（原因：高风险操作，名称含 delete）。';
  }
  if (risk === RiskLevel.MEDIUM) {
    return '需要审批（原因：中风险 / AI 来源任务）。';
  }
  return '需要审批。';
}

export function taskParameterSource(
  task: ApprovalTaskSnapshot,
): 'llm' | 'rule' | 'unknown' {
  const p = parametersRecord(task.parameters);
  const s = p?.source;
  if (s === 'llm' || s === 'rule') {
    return s;
  }
  return 'unknown';
}

export function parameterSourceLabel(task: ApprovalTaskSnapshot): string {
  const s = taskParameterSource(task);
  if (s === 'llm') {
    return 'AI（LLM）';
  }
  if (s === 'rule') {
    return '规则拆分';
  }
  return '未知';
}
