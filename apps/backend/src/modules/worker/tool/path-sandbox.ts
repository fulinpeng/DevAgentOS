import * as path from 'node:path';

/**
 * 将相对路径解析到 baseDir 下，并禁止跳出沙箱（目录穿越 / 绝对路径逃逸）。
 */
export function resolveUnderBase(baseDir: string, relativePath: string): string {
  const base = path.resolve(baseDir);
  const joined = path.resolve(base, relativePath);
  const rel = path.relative(base, joined);
  if (rel.startsWith('..') || rel === '..') {
    throw new Error(`path escapes sandbox: ${relativePath}`);
  }
  return joined;
}
