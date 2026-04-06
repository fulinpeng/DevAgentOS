import { IsIn, IsObject, IsOptional } from 'class-validator';

/** 人工将卡住的 RUNNING 标为可续跑暂停（可选合并 result，如手工补 remainingSteps） */
export class UpdateTaskStatusDto {
  @IsIn(['WORKER_PAUSED'])
  status!: 'WORKER_PAUSED';

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;
}
