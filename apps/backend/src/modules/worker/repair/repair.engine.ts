import { Injectable, Logger } from '@nestjs/common';
import type { RepairSkill } from './repair-skill.interface';
import type { FixPlan, RepairContext } from './repair.types';
import { ConfigErrorRepairSkill } from './skills/config-error.skill';
import { LlmFallbackRepairSkill } from './skills/llm-fallback.skill';
import { LongRunningCommandRepairSkill } from './skills/long-running-command.skill';
import { MissingScriptRepairSkill } from './skills/missing-script.skill';
import { PathSandboxRepairSkill } from './skills/path-sandbox.skill';
import { RunCommandBasicRepairSkill } from './skills/run-command-basic.skill';
import { TypeScriptBuildRepairSkill } from './skills/typescript-build.skill';

@Injectable()
export class RepairEngine {
  private readonly logger = new Logger(RepairEngine.name);
  private readonly skills: RepairSkill[];

  constructor(
    longRunningCommand: LongRunningCommandRepairSkill,
    pathSandbox: PathSandboxRepairSkill,
    missingScript: MissingScriptRepairSkill,
    configError: ConfigErrorRepairSkill,
    typescriptBuild: TypeScriptBuildRepairSkill,
    runCommandBasic: RunCommandBasicRepairSkill,
    llmFallback: LlmFallbackRepairSkill,
  ) {
    this.skills = [
      longRunningCommand,
      pathSandbox,
      missingScript,
      configError,
      typescriptBuild,
      runCommandBasic,
      llmFallback,
    ];
  }

  async planFixSteps(context: RepairContext): Promise<FixPlan | null> {
    let best: { skill: RepairSkill; score: number; reason: string } | null =
      null;
    for (const skill of this.skills) {
      const m = skill.match(context);
      if (!best || m.score > best.score) {
        best = { skill, score: m.score, reason: m.reason };
      }
    }
    if (!best || best.score <= 0) {
      return null;
    }
    const plan = await best.skill.plan(context);
    if (!plan || plan.fixSteps.length === 0) {
      this.logger.warn(
        `repair skill produced no fix: skill=${best.skill.id} task=${context.taskId}`,
      );
      return null;
    }
    return plan;
  }
}

