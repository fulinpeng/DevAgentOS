import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
