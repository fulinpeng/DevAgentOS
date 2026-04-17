import type { RepairFailure } from './repair.types';

/** 合并 message 与 runCommand 附带的 stdout/stderr，供修复技能与 LLM 使用 */
export function getRunCommandFailureText(failure: RepairFailure): string {
  const parts = [failure.error ?? ''];
  const d = failure.data;
  if (d && typeof d === 'object') {
    const stdout = (d as Record<string, unknown>).stdout;
    const stderr = (d as Record<string, unknown>).stderr;
    if (typeof stdout === 'string') parts.push(stdout);
    if (typeof stderr === 'string') parts.push(stderr);
  }
  return parts.join('\n');
}

/**
 * 从 runCommand 失败信息中解析「缺失的 npm/pnpm/yarn script 名」。
 * 优先匹配包管理器明确报错；若 stdout/stderr 为空（部分环境下仅 error 首行），则从失败命令推断。
 */
export function extractMissingScriptNameFromRunCommandFailure(
  failure: RepairFailure,
): string | null {
  if (failure.tool !== 'runCommand') {
    return null;
  }
  const text = getRunCommandFailureText(failure);
  let m = text.match(/Command\s+"([^"]+)"\s+not\s+found/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  m = text.match(/Missing script:\s*"([^"]+)"/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  m = text.match(/Missing script:\s*'([^']+)'/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  m = text.match(/error\s+Command\s+"([^"]+)"\s+not\s+found/i);
  if (m?.[1]) {
    return m[1].trim();
  }

  const data = failure.data;
  const stdout =
    data && typeof data === 'object'
      ? String((data as Record<string, unknown>).stdout ?? '').trim()
      : '';
  const stderr =
    data && typeof data === 'object'
      ? String((data as Record<string, unknown>).stderr ?? '').trim()
      : '';
  if (!stdout && !stderr) {
    const errLine = String(failure.error ?? '');
    let fromErr = errLine.match(
      /Command failed:\s*(?:pnpm|npm)\s+run\s+(\S+)/i,
    );
    if (fromErr?.[1]) {
      return fromErr[1].trim();
    }
    fromErr = errLine.match(/Command failed:\s*yarn\s+(?:run\s+)?(\S+)/i);
    if (fromErr?.[1]) {
      return fromErr[1].trim();
    }
    const stepCmd = String(
      (failure.step.args as Record<string, unknown> | undefined)?.command ?? '',
    ).trim();
    let fromStep = stepCmd.match(/^(?:pnpm|npm)\s+run\s+(\S+)/i);
    if (fromStep?.[1]) {
      return fromStep[1].trim();
    }
    fromStep = stepCmd.match(/^yarn\s+(?:run\s+)?(\S+)/i);
    if (fromStep?.[1]) {
      return fromStep[1].trim();
    }
  }
  return null;
}

/**
 * Vitest + Testing Library 等「运行时找不到元素 / 断言」类失败。
 * 与 tsc / Vite 编译错误区分，避免误走 typescript-build 提示词。
 * 若同一段输出已含 TS 错误行，仍视为编译问题（由 looksLikeCompileOrTypeError 处理）。
 */
export function looksLikeTestAssertionFailure(text: string): boolean {
  const t = text;
  if (!t.trim()) return false;
  if (/error\s+TS\d{3,5}/i.test(t)) return false;
  if (/\(\d+,\d+\):\s*error\s+TS/i.test(t)) return false;
  if (/testinglibraryelementerror/i.test(t)) return true;
  if (/unable to find an element/i.test(t)) return true;
  if (/unable to find role/i.test(t)) return true;
  if (/found multiple elements/i.test(t)) return true;
  if (/testing-library\/dom/i.test(t) && /getelementerror/i.test(t)) return true;
  if (/\bassertionerror\b/i.test(t) && /expect\(/i.test(t)) return true;
  return false;
}

/** 判断是否为 tsc / Vite build / TypeScript 等编译期报错（而非缺依赖、脚本缺失） */
export function looksLikeCompileOrTypeError(text: string): boolean {
  const t = text;
  if (!t.trim()) return false;
  if (looksLikeTestAssertionFailure(t)) return false;
  if (/error\s+TS\d{3,5}/i.test(t)) return true;
  if (/\(\d+,\d+\):\s*error\s+TS/i.test(t)) return true;
  if (/is declared but its value is never read/i.test(t)) return true;
  if (/must be imported using a type-only import/i.test(t)) return true;
  if (/is missing the following properties from type/i.test(t)) return true;
  if (/verbatimmodulesyntax/i.test(t)) return true;
  if (/failed to compile/i.test(t)) return true;
  if (/failed to resolve import/i.test(t)) return true;
  if (/does the file exist\?/i.test(t)) return true;
  if (/vite:import-analysis/i.test(t)) return true;
  if (/\btsc\b/i.test(t) && /\berror\b/i.test(t)) return true;
  if (/vite build/i.test(t) && /\berror\b/i.test(t)) return true;
  // TS2307：找不到相对路径模块时多为漏建文件/路径错，不是缺 npm 包
  if (/error\s+TS2307\b/i.test(t)) return true;
  if (/cannot find module\s+['`]\.\.?\/[^'`]+['`]/i.test(t)) return true;
  // React + strict TS 常见：useState([]) 推断 never[]、隐式 any、缺页面文件
  if (/setstateaction<\s*never/i.test(t)) return true;
  if (/implicitly has an 'any' type/i.test(t)) return true;
  if (/does not exist on type 'never'/i.test(t)) return true;
  if (
    /is not assignable to parameter of type/i.test(t) &&
    /setstateaction/i.test(t)
  ) {
    return true;
  }
  // Vitest + @testing-library/jest-dom：未 setup 时 Chai 不认识 toBeInTheDocument 等 matcher
  if (/invalid chai property/i.test(t)) return true;
  if (/tobeinthedocument/i.test(t)) return true;
  return false;
}

/**
 * Vitest 已执行用例但失败（含 Testing Library / 断言），且同一段输出中**无** TS 编译行。
 * 用于在 LLM triage 误判为 typescript-build 时纠偏到 vitest-rtl-assertion。
 */
export function looksLikeVitestDomOrAssertionFailure(text: string): boolean {
  const t = text;
  if (!t.trim()) return false;
  if (/error\s+TS\d{3,5}/i.test(t)) return false;
  if (/\(\d+,\d+\):\s*error\s+TS/i.test(t)) return false;
  if (looksLikeTestAssertionFailure(t)) return true;
  if (
    /failed tests\s+\d+/i.test(t) &&
    /\bfail\s+src\/[^\s]+\.test\.(tsx?|jsx?)/i.test(t)
  ) {
    return true;
  }
  if (/failed tests\s+\d+/i.test(t) && /testinglibrary/i.test(t)) {
    return true;
  }
  return false;
}
