/**
 * 纯领域：是否需要人工审批（无框架 / ORM 依赖）。
 */

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
  if (p?.source === 'llm') {
    return true;
  }
  if (task.name.toLowerCase().includes('delete')) {
    return true;
  }
  return false;
}

/** 供控制台展示的简短说明 */
export function approvalReason(task: ApprovalTaskSnapshot): string | null {
  if (!shouldRequireApproval(task)) {
    return null;
  }
  const p = parametersRecord(task.parameters);
  if (p?.source === 'llm') {
    return '子任务来源为 AI（LLM）拆分，需人工确认后执行。';
  }
  if (task.name.toLowerCase().includes('delete')) {
    return '任务名称包含高风险关键词 delete，需人工确认。';
  }
  return '命中审批规则，需人工确认。';
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
