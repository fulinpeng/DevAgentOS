import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/** PATCH /task/:id — 未开始执行的任务可编辑 name / role / sortOrder / parameters */
export class UpdateTaskFieldsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  /** 空字符串表示清空 role */
  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
