/**
 * 纯领域：Role 执行路由（无框架 / ORM 依赖）。
 */

export type TaskStatusSnapshot =
  | 'CREATED'
  | 'PLAN_GENERATED'
  | 'WAITING_PLAN_APPROVAL'
  | 'PLAN_APPROVED'
  | 'PENDING'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export type TaskExecutionSnapshot = {
  status: TaskStatusSnapshot;
};

export type RoleExecutionRoute =
  | 'execute'
  | 'return_completed'
  | 'reject_running'
  | 'blocked_approval'
  | 'blocked_failed'
  | 'blocked_plan';

/**
 * - PENDING → 走完整执行管线（含审批门禁）
 * - COMPLETED → 幂等，直接返回已有结果
 * - RUNNING → 拒绝（并发/重入由应用层配合锁处理）
 * - WAITING_APPROVAL → 禁止自动执行，等待 POST /task/approve
 * - FAILED → 终态，禁止再执行
 * - CREATED / Plan 阶段 → 禁止 Role 执行（须先审批计划或走 Coordinator）
 */
export function routeRoleExecution(
  task: TaskExecutionSnapshot,
): RoleExecutionRoute {
  if (task.status === 'COMPLETED') {
    return 'return_completed';
  }
  if (task.status === 'FAILED') {
    return 'blocked_failed';
  }
  if (task.status === 'WAITING_APPROVAL') {
    return 'blocked_approval';
  }
  if (task.status === 'RUNNING') {
    return 'reject_running';
  }
  if (
    task.status === 'CREATED' ||
    task.status === 'PLAN_GENERATED' ||
    task.status === 'WAITING_PLAN_APPROVAL' ||
    task.status === 'PLAN_APPROVED'
  ) {
    return 'blocked_plan';
  }
  return 'execute';
}

/** @deprecated 使用 routeRoleExecution；保留便于阅读旧代码 */
export function decideExecution(task: TaskExecutionSnapshot): boolean {
  return routeRoleExecution(task) === 'execute';
}
