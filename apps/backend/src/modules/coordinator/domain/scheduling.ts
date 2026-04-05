/**
 * 纯领域：在子任务集合中选取下一个待完成项（无框架依赖）。
 */

export type ChildTaskSnapshot = {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED';
  sortOrder: number;
};

/** 按 sortOrder，返回第一个 status !== COMPLETED 的子任务 */
export function getNextTask(
  children: ChildTaskSnapshot[],
): ChildTaskSnapshot | null {
  const sorted = [...children].sort((a, b) => a.sortOrder - b.sortOrder);
  return sorted.find((c) => c.status !== 'COMPLETED') ?? null;
}
