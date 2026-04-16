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

/** 判断是否为 tsc / Vite build / TypeScript 等编译期报错（而非缺依赖、脚本缺失） */
export function looksLikeCompileOrTypeError(text: string): boolean {
  const t = text;
  if (!t.trim()) return false;
  if (/error\s+TS\d{3,5}/i.test(t)) return true;
  if (/\(\d+,\d+\):\s*error\s+TS/i.test(t)) return true;
  if (/is declared but its value is never read/i.test(t)) return true;
  if (/must be imported using a type-only import/i.test(t)) return true;
  if (/is missing the following properties from type/i.test(t)) return true;
  if (/verbatimmodulesyntax/i.test(t)) return true;
  if (/failed to compile/i.test(t)) return true;
  if (/\btsc\b/i.test(t) && /\berror\b/i.test(t)) return true;
  if (/vite build/i.test(t) && /\berror\b/i.test(t)) return true;
  // TS2307：找不到相对路径模块时多为漏建文件/路径错，不是缺 npm 包
  if (/error\s+TS2307\b/i.test(t)) return true;
  if (/cannot find module\s+['`]\.\.?\/[^'`]+['`]/i.test(t)) return true;
  return false;
}
