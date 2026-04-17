import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkerExecutorService } from './application/worker.executor.service';
import { FileContextService } from './infrastructure/file-context.service';
import { RepairEngine } from './repair/repair.engine';
import { RepairTriageService } from './repair/repair-triage.service';
import { ConfigErrorRepairSkill } from './repair/skills/config-error.skill';
import { LlmFallbackRepairSkill } from './repair/skills/llm-fallback.skill';
import { LongRunningCommandRepairSkill } from './repair/skills/long-running-command.skill';
import { MissingAcceptanceVerifyRepairSkill } from './repair/skills/missing-acceptance-verify.skill';
import { MissingScriptRepairSkill } from './repair/skills/missing-script.skill';
import { MissingValidationScriptRepairSkill } from './repair/skills/missing-validation-script.skill';
import { PathSandboxRepairSkill } from './repair/skills/path-sandbox.skill';
import { ReadFileEnoentRepairSkill } from './repair/skills/readfile-enoent.skill';
import { RunCommandBasicRepairSkill } from './repair/skills/run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './repair/skills/typescript-build.skill';
import { UnsafeFullOverwriteRepairSkill } from './repair/skills/unsafe-full-overwrite.skill';
import { VitestRtlAssertionRepairSkill } from './repair/skills/vitest-rtl-assertion.skill';
import { ToolExecutor } from './tool/tool-executor';

@Module({
  imports: [WorkflowModule],
  providers: [
    ToolExecutor,
    FileContextService,
    WorkerExecutorService,
    RepairEngine,
    RepairTriageService,
    LongRunningCommandRepairSkill,
    MissingAcceptanceVerifyRepairSkill,
    PathSandboxRepairSkill,
    ReadFileEnoentRepairSkill,
    UnsafeFullOverwriteRepairSkill,
    MissingScriptRepairSkill,
    MissingValidationScriptRepairSkill,
    ConfigErrorRepairSkill,
    TypeScriptBuildRepairSkill,
    VitestRtlAssertionRepairSkill,
    RunCommandBasicRepairSkill,
    LlmFallbackRepairSkill,
  ],
  exports: [WorkerExecutorService],
})
export class WorkerModule {}
