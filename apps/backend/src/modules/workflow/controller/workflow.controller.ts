import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkflowService } from '../application/workflow.service';
import { CreateTaskDto } from './dto/create-task.dto';

@Controller('task')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTaskDto) {
    return this.workflowService.createTaskWithSplit(dto.name, dto.parameters);
  }
}
