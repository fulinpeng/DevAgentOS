/** 与 Prisma `TaskStatus` 枚举名一致（API 序列化） */
export type TaskStatus =
  | 'PENDING'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
}
