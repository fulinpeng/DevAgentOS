import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkerExecutorService } from './application/worker.executor.service';
import { ToolExecutor } from './tool/tool-executor';

@Module({
  imports: [WorkflowModule],
  providers: [ToolExecutor, WorkerExecutorService],
  exports: [WorkerExecutorService],
})
export class WorkerModule {}
