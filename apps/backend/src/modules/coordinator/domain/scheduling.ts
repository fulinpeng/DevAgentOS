/**
 * 纯领域：在子任务集合中选取下一个待完成项（无框架依赖）。
 */

export type ChildTaskSnapshot = {
  id: string;
  status:
    | 'PENDING'
    | 'WAITING_APPROVAL'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED';
  sortOrder: number;
};

/**
 * 按 sortOrder，返回第一个未完成子任务。
 * 若队首为 FAILED，整链中止（返回 null，不再执行后续子任务）。
 */
export function getNextTask(
  children: ChildTaskSnapshot[],
): ChildTaskSnapshot | null {
  const sorted = [...children].sort((a, b) => a.sortOrder - b.sortOrder);
  const next = sorted.find((c) => c.status !== 'COMPLETED') ?? null;
  if (!next) {
    return null;
  }
  if (next.status === 'FAILED') {
    return null;
  }
  return next;
}
