import { Module } from '@nestjs/common';
import { WorkflowService } from './application/workflow.service';
import { WorkflowController } from './controller/workflow.controller';
import { WorkflowGenerateController } from './controller/workflow-generate.controller';
import { WorkflowLlmService } from './infrastructure/llm.service';
import { TaskRepository } from './infrastructure/task.repository';

@Module({
  controllers: [WorkflowController, WorkflowGenerateController],
  providers: [WorkflowService, TaskRepository, WorkflowLlmService],
  exports: [WorkflowLlmService],
})
export class WorkflowModule {}
