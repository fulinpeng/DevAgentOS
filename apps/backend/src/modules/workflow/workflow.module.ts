import { Module } from '@nestjs/common';
import { WorkflowService } from './application/workflow.service';
import { WorkflowController } from './controller/workflow.controller';
import { WorkflowLlmService } from './infrastructure/llm.service';
import { TaskRepository } from './infrastructure/task.repository';

@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, TaskRepository, WorkflowLlmService],
})
export class WorkflowModule {}
