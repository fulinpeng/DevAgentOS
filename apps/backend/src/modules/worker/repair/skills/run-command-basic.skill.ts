import { Injectable } from '@nestjs/common';
import type { WorkerLlmStep } from '../../application/worker.executor.service';
import type { RepairSkill } from '../repair-skill.interface';
import type { FixPlan, RepairContext } from '../repair.types';
import { getRunCommandFailureText } from '../run-command-failure-text';

function parseMissingScriptName(text: string): string | null {
  const m = text.match(/Command\s+"([^"]+)"\s+not\s+found/i);
  return m?.[1]?.trim() ?? null;
}

function looksLikeDependencyMissing(errorText: string): boolean {
  const t = errorText.toLowerCase();
  return (
    t.includes('cannot find module') ||
    t.includes('module not found') ||
    t.includes('command not found') ||
    t.includes('not recognized as an internal or external command') ||
    t.includes('err_pnpm_recursive_exec_first_fail')
  );
}

function isPackageManagerInstallCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  return (
    c.startsWith('pnpm install') ||
    c.startsWith('npm install') ||
    c.startsWith('npm ci') ||
    c.startsWith('yarn add') ||
    c.startsWith('yarn install') ||
    c.startsWith('pnpm add')
  );
}

function buildFixStepsForRunCommand(): WorkerLlmStep[] {
  return [{ action: 'runCommand', args: { command: 'pnpm install' } }];
}

@Injectable()
export class RunCommandBasicRepairSkill implements RepairSkill {
  readonly id = 'run-command-basic';

  async plan(context: RepairContext): Promise<FixPlan | null> {
    if (context.failure.tool !== 'runCommand') {
      return null;
    }
    const failedCommand = String(context.failure.step.args.command ?? '');
    if (isPackageManagerInstallCommand(failedCommand)) {
      return null;
    }
    const blob = getRunCommandFailureText(context.failure);
    const missingScript = parseMissingScriptName(blob);
    if (missingScript) {
      return null;
    }
    const err = (context.failure.error ?? '').trim();
    if (!err && !looksLikeDependencyMissing(blob)) {
      return null;
    }
    if (!looksLikeDependencyMissing(err) && !looksLikeDependencyMissing(blob)) {
      return null;
    }
    return {
      skillId: this.id,
      score: 1,
      category: 'missing_dependency',
      reason: 'likely missing dependency/script/runtime — pnpm install',
      fixSteps: buildFixStepsForRunCommand(),
    };
  }
}
