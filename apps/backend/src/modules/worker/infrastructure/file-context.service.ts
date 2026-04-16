import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';

/** 深度扫描时最多收集的文件路径条数 */
const MAX_TREE_FILES = 50;

/** 单文件读入 Prompt 的最大字符数 */
const MAX_FILE_CONTENT_CHARS = 2000;

/** 最多注入多少个“关键文件内容”到 Worker prompt */
const MAX_IMPORTANT_FILES = 12;

/** 基础骨架文件：优先注入 */
const CORE_IMPORTANT_REL_PATHS = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'src/main.tsx',
  'src/App.tsx',
  'src/routes.tsx',
] as const;

const IGNORE_DIR_NAMES = new Set(['node_modules', '.git', 'dist']);

type ImportantFileSelectionInput = {
  taskName?: string;
  taskDescription?: string;
  goal?: string;
  fileTree?: string[];
};

function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

function shouldPreferAsAppSource(rel: string): boolean {
  return /^(src\/(pages|components|routes|router|hooks|store|context|api|services|types)\/|src\/[A-Z].*\.(tsx|ts)$)/i.test(
    rel,
  );
}

function tokenizeTaskText(input: ImportantFileSelectionInput): string[] {
  const raw = [input.taskName, input.taskDescription, input.goal]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join(' ')
    .toLowerCase();
  if (!raw) {
    return [];
  }
  const tokens = raw
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 || /[\u4e00-\u9fa5]{2,}/.test(x));
  return Array.from(new Set(tokens)).slice(0, 24);
}

function scorePath(rel: string, tokens: string[]): number {
  const lower = rel.toLowerCase();
  let score = 0;
  if (CORE_IMPORTANT_REL_PATHS.some((p) => p.toLowerCase() === lower)) score += 100;
  if (shouldPreferAsAppSource(rel)) score += 25;
  if (/^src\/(pages|components)\//i.test(rel)) score += 20;
  if (/^src\/(routes|router)\//i.test(rel) || /^src\/routes\.tsx$/i.test(rel)) {
    score += 18;
  }
  if (/\.(tsx|ts|jsx|js|css|scss|json)$/.test(lower)) score += 8;
  if (/index\.(tsx|ts|jsx|js)$/.test(lower)) score += 4;
  for (const token of tokens) {
    if (lower.includes(token)) score += 15;
  }
  return score;
}

@Injectable()
export class FileContextService {
  /**
   * 递归列出相对 baseDir 的文件路径（不含目录名作为单独条目），最多 {@link MAX_TREE_FILES} 条。
   * 跳过名为 node_modules、.git、dist 的目录。
   */
  getFileTree(baseDir: string): string[] {
    if (!existsSync(baseDir)) {
      return [];
    }
    const acc: string[] = [];

    const walk = (dir: string): void => {
      if (acc.length >= MAX_TREE_FILES) {
        return;
      }
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      );
      for (const ent of entries) {
        if (acc.length >= MAX_TREE_FILES) {
          return;
        }
        const baseName = String(ent.name);
        if (IGNORE_DIR_NAMES.has(baseName)) {
          continue;
        }
        const full = path.join(dir, baseName);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const rel = path.relative(baseDir, full).replace(/\\/g, '/');
          if (!rel.startsWith('..') && rel.length > 0) {
            acc.push(rel);
          }
        }
      }
    };

    walk(baseDir);
    return acc.sort((a, b) => a.localeCompare(b));
  }

  /**
   * 读取少量关键文件内容（每文件最多 {@link MAX_FILE_CONTENT_CHARS} 字符）。
   */
  getImportantFiles(
    baseDir: string,
    input: ImportantFileSelectionInput = {},
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(baseDir)) {
      return out;
    }
    const fileTree =
      input.fileTree && input.fileTree.length > 0
        ? input.fileTree.map(normalizeRelPath)
        : this.getFileTree(baseDir);
    const tokens = tokenizeTaskText(input);
    const candidateSet = new Set<string>();

    for (const rel of CORE_IMPORTANT_REL_PATHS) {
      candidateSet.add(rel);
    }

    const scored = fileTree
      .map((rel) => ({ rel, score: scorePath(rel, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

    for (const item of scored) {
      if (candidateSet.size >= MAX_IMPORTANT_FILES) {
        break;
      }
      candidateSet.add(item.rel);
    }

    for (const rel of candidateSet) {
      const full = path.join(baseDir, rel);
      if (!existsSync(full)) {
        continue;
      }
      try {
        const raw = readFileSync(full, 'utf8');
        out[rel] =
          raw.length > MAX_FILE_CONTENT_CHARS
            ? `${raw.slice(0, MAX_FILE_CONTENT_CHARS)}\n…(truncated)`
            : raw;
      } catch {
        /* 跳过不可读文件 */
      }
    }
    return out;
  }
}
