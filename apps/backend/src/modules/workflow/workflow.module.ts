import { Module } from '@nestjs/common';
import { WorkflowService } from './application/workflow.service';
import { WorkflowController } from './controller/workflow.controller';
import { TaskRedis } from './infrastructure/task.redis';
import { TaskRepository } from './infrastructure/task.repository';

@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, TaskRepository, TaskRedis],
})
export class WorkflowModule {}
