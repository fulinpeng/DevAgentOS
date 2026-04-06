import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

/** POST /task/:id/append — 在当前任务下追加子任务并执行 */
export class AppendTaskDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
