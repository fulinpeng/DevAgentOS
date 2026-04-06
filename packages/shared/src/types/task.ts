/** 与 Prisma `TaskStatus` 枚举名一致（API 序列化） */
export type TaskStatus =
  | 'CREATED'
  | 'PLAN_GENERATED'
  | 'WAITING_PLAN_APPROVAL'
  | 'PLAN_APPROVED'
  | 'PENDING'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'WORKER_PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
}
