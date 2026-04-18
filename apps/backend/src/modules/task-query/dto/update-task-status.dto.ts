import { IsIn, IsObject, IsOptional } from 'class-validator';

/**
 * 人工 PATCH /task/:id/status
 * - WORKER_PAUSED：RUNNING → 可续跑暂停（可选合并 result）
 * - COMPLETED：仅当子树内所有后代已为 COMPLETED 时，将本节点标为完成（修根/中间层卡在 PLAN_APPROVED 等）
 */
export class UpdateTaskStatusDto {
  @IsIn(['WORKER_PAUSED', 'COMPLETED'])
  status!: 'WORKER_PAUSED' | 'COMPLETED';

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;
}
