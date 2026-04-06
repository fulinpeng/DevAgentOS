import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

/** 仅 CREATED 主任务：可选改 name；带 parameters 时整段替换 */
export class UpdateTaskDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
