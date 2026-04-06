import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RefineTaskDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  instruction!: string;
}
