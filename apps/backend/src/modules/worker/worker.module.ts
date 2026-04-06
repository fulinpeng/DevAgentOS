import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkerExecutorService } from './application/worker.executor.service';
import { FileContextService } from './infrastructure/file-context.service';
import { ToolExecutor } from './tool/tool-executor';

@Module({
  imports: [WorkflowModule],
  providers: [ToolExecutor, FileContextService, WorkerExecutorService],
  exports: [WorkerExecutorService],
})
export class WorkerModule {}
