import type { RepairContext, RepairTriage } from './repair.types';
import {
  getRunCommandFailureText,
  looksLikeCompileOrTypeError,
  looksLikeVitestDomOrAssertionFailure,
} from './run-command-failure-text';

function isLikelyTestRunCommand(context: RepairContext): boolean {
  if (context.failure.tool !== 'runCommand') {
    return false;
  }
  const cmd = String(context.failure.step.args.command ?? '').toLowerCase();
  return (
    /\brun\s+test\b/.test(cmd) ||
    /\btest\b/.test(cmd) ||
    cmd.includes('vitest') ||
    cmd.includes('jest')
  );
}

/**
 * LLM 分类后再做确定性纠偏，避免纯 Vitest/RTL 失败被误标为 typescript-build（进而生成偏编译的 fix、触发 validation 拒绝）。
 */
export function refineRepairTriageAfterLlm(
  context: RepairContext,
  triage: RepairTriage | null,
): RepairTriage | null {
  if (context.failure.tool !== 'runCommand') {
    return triage;
  }
  const blob = getRunCommandFailureText(context.failure);
  const vitestRuntime = looksLikeVitestDomOrAssertionFailure(blob);
  const compile = looksLikeCompileOrTypeError(blob);

  const skillId = triage?.skillId;
  const focusPaths = triage?.focusPaths ?? [];
  const rationale = triage?.rationale ?? '';

  if (
    vitestRuntime &&
    !compile &&
    (skillId === 'typescript-build' || skillId === 'config-error')
  ) {
    return {
      skillId: 'vitest-rtl-assertion',
      focusPaths,
      rationale:
        (rationale ? `[refined] ${rationale}; ` : '') +
        '输出为 Vitest/测试运行时失败（无 TS 编译行），改用 vitest-rtl-assertion',
    };
  }

  if (compile && skillId === 'vitest-rtl-assertion' && !vitestRuntime) {
    return {
      skillId: 'typescript-build',
      focusPaths,
      rationale:
        (rationale ? `[refined] ${rationale}; ` : '') +
        '输出含编译/类型错误，改用 typescript-build',
    };
  }

  if (
    !triage &&
    vitestRuntime &&
    !compile &&
    isLikelyTestRunCommand(context)
  ) {
    return {
      skillId: 'vitest-rtl-assertion',
      focusPaths: [],
      rationale:
        'heuristic: Vitest 测试失败且输出无 TS 编译行，triage 解析失败时的兜底路由',
    };
  }

  return triage;
}
