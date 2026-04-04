/**
 * 纯领域：是否允许 Role 拉起执行（无框架 / ORM 依赖）。
 */

export type TaskStatusSnapshot = 'PENDING' | 'RUNNING' | 'COMPLETED';

export type TaskExecutionSnapshot = {
  status: TaskStatusSnapshot;
};

/** 仅 PENDING 可进入执行管线 */
export function decideExecution(task: TaskExecutionSnapshot): boolean {
  return task.status === 'PENDING';
}
