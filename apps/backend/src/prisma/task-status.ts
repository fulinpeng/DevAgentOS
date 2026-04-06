import type { TaskStatus } from '@prisma/client';

/**
 * 与 `schema.prisma` 中 `TaskStatus.WORKER_PAUSED` 一致。
 * 若本地 `pnpm prisma generate` 未成功，枚举可能未刷新，故用断言。
 */
export const TASK_STATUS_WORKER_PAUSED = 'WORKER_PAUSED' as TaskStatus;
