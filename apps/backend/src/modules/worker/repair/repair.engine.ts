import { Injectable, Logger } from '@nestjs/common';
import type { RepairSkill } from './repair-skill.interface';
import type { FixPlan, RepairContext } from './repair.types';
import { refineRepairTriageAfterLlm } from './repair-triage-refine';
import { RepairTriageService } from './repair-triage.service';
import { ConfigErrorRepairSkill } from './skills/config-error.skill';
import { LlmFallbackRepairSkill } from './skills/llm-fallback.skill';
import { LongRunningCommandRepairSkill } from './skills/long-running-command.skill';
import { MissingAcceptanceVerifyRepairSkill } from './skills/missing-acceptance-verify.skill';
import { MissingScriptRepairSkill } from './skills/missing-script.skill';
import { MissingValidationScriptRepairSkill } from './skills/missing-validation-script.skill';
import { PathSandboxRepairSkill } from './skills/path-sandbox.skill';
import { ReadFileEnoentRepairSkill } from './skills/readfile-enoent.skill';
import { RunCommandBasicRepairSkill } from './skills/run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './skills/typescript-build.skill';
import { UnsafeFullOverwriteRepairSkill } from './skills/unsafe-full-overwrite.skill';
import { VitestRtlAssertionRepairSkill } from './skills/vitest-rtl-assertion.skill';

@Injectable()
export class RepairEngine {
  private readonly logger = new Logger(RepairEngine.name);
  private readonly skills: RepairSkill[];
  private readonly skillById: Map<string, RepairSkill>;

  constructor(
    private readonly triageService: RepairTriageService,
    longRunningCommand: LongRunningCommandRepairSkill,
    missingAcceptanceVerify: MissingAcceptanceVerifyRepairSkill,
    pathSandbox: PathSandboxRepairSkill,
    readFileEnoent: ReadFileEnoentRepairSkill,
    unsafeFullOverwrite: UnsafeFullOverwriteRepairSkill,
    missingScript: MissingScriptRepairSkill,
    missingValidationScript: MissingValidationScriptRepairSkill,
    configError: ConfigErrorRepairSkill,
    typescriptBuild: TypeScriptBuildRepairSkill,
    vitestRtlAssertion: VitestRtlAssertionRepairSkill,
    runCommandBasic: RunCommandBasicRepairSkill,
    llmFallback: LlmFallbackRepairSkill,
  ) {
    this.skills = [
      longRunningCommand,
      missingAcceptanceVerify,
      pathSandbox,
      readFileEnoent,
      unsafeFullOverwrite,
      missingScript,
      missingValidationScript,
      configError,
      vitestRtlAssertion,
      typescriptBuild,
      runCommandBasic,
      llmFallback,
    ];
    this.skillById = new Map(this.skills.map((s) => [s.id, s]));
  }

  async planFixSteps(context: RepairContext): Promise<FixPlan | null> {
    const rawTriage = await this.triageService.classify(context);
    const triage = refineRepairTriageAfterLlm(context, rawTriage);
    if (triage !== rawTriage && triage) {
      this.logger.log(
        `repair triage refined task=${context.taskId} ${rawTriage?.skillId ?? 'null'} -> ${triage.skillId}`,
      );
    }
    const ctx: RepairContext = triage
      ? { ...context, triage }
      : { ...context };

    const primaryId =
      triage?.skillId && this.skillById.has(triage.skillId)
        ? triage.skillId
        : 'llm-fallback';

    const tryOrder = [primaryId, 'llm-fallback'].filter(
      (id, i, arr) => arr.indexOf(id) === i,
    );

    for (const id of tryOrder) {
      const skill = this.skillById.get(id);
      if (!skill) {
        continue;
      }
      const plan = await skill.plan(ctx);
      if (plan && plan.fixSteps.length > 0) {
        if (id !== primaryId) {
          this.logger.warn(
            `repair primary skill=${primaryId} produced no plan; used fallback skill=${id} task=${context.taskId}`,
          );
        }
        return plan;
      }
    }

    this.logger.warn(
      `repair no plan from triage chain task=${context.taskId} primary=${primaryId}`,
    );
    return null;
  }
}
