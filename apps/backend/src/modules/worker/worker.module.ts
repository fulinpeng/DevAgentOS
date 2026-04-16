import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkerExecutorService } from './application/worker.executor.service';
import { FileContextService } from './infrastructure/file-context.service';
import { RepairEngine } from './repair/repair.engine';
import { ConfigErrorRepairSkill } from './repair/skills/config-error.skill';
import { LlmFallbackRepairSkill } from './repair/skills/llm-fallback.skill';
import { LongRunningCommandRepairSkill } from './repair/skills/long-running-command.skill';
import { MissingScriptRepairSkill } from './repair/skills/missing-script.skill';
import { PathSandboxRepairSkill } from './repair/skills/path-sandbox.skill';
import { RunCommandBasicRepairSkill } from './repair/skills/run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './repair/skills/typescript-build.skill';
import { ToolExecutor } from './tool/tool-executor';

@Module({
  imports: [WorkflowModule],
  providers: [
    ToolExecutor,
    FileContextService,
    WorkerExecutorService,
    RepairEngine,
    LongRunningCommandRepairSkill,
    PathSandboxRepairSkill,
    MissingScriptRepairSkill,
    ConfigErrorRepairSkill,
    TypeScriptBuildRepairSkill,
    RunCommandBasicRepairSkill,
    LlmFallbackRepairSkill,
  ],
  exports: [WorkerExecutorService],
})
export class WorkerModule {}
