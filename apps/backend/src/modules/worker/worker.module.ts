import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkerExecutorService } from './application/worker.executor.service';
import { FileContextService } from './infrastructure/file-context.service';
import { RepairEngine } from './repair/repair.engine';
import { LlmFallbackRepairSkill } from './repair/skills/llm-fallback.skill';
import { RunCommandBasicRepairSkill } from './repair/skills/run-command-basic.skill';
import { ToolExecutor } from './tool/tool-executor';

@Module({
  imports: [WorkflowModule],
  providers: [
    ToolExecutor,
    FileContextService,
    WorkerExecutorService,
    RepairEngine,
    RunCommandBasicRepairSkill,
    LlmFallbackRepairSkill,
  ],
  exports: [WorkerExecutorService],
})
export class WorkerModule {}
