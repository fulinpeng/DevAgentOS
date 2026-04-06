import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { WorkflowService } from '../application/workflow.service';

@Controller('workflow')
export class WorkflowGenerateController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('generate/:taskId')
  @HttpCode(HttpStatus.OK)
  generate(@Param('taskId', new ParseUUIDPipe()) taskId: string) {
    return this.workflowService.generatePlan(taskId);
  }
}
