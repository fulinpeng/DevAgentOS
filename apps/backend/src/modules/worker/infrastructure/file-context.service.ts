import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';

/** 深度扫描时最多收集的文件路径条数 */
const MAX_TREE_FILES = 50;

/** 单文件读入 Prompt 的最大字符数 */
const MAX_FILE_CONTENT_CHARS = 2000;

/** 按优先级尝试读取的关键路径（相对沙箱根） */
const IMPORTANT_REL_PATHS = [
  'package.json',
  'vite.config.ts',
  'src/main.tsx',
  'src/App.tsx',
] as const;

const IGNORE_DIR_NAMES = new Set(['node_modules', '.git', 'dist']);

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
  getImportantFiles(baseDir: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(baseDir)) {
      return out;
    }
    for (const rel of IMPORTANT_REL_PATHS) {
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
