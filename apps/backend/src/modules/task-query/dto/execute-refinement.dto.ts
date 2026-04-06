import { IsOptional, IsUUID } from 'class-validator';

/** POST /task/refine/:taskId/execute — 可选指定版本；默认使用已激活版本 */
export class ExecuteRefinementDto {
  @IsOptional()
  @IsUUID()
  versionId?: string;
}
