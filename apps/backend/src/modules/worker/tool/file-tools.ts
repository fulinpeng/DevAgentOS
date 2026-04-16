import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveUnderBase } from './path-sandbox';

export type FileToolResult = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

async function exists(fullPath: string): Promise<boolean> {
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function toolWriteFile(
  baseDir: string,
  relativePath: string,
  content: string,
  options?: { overwriteExisting?: boolean },
): Promise<FileToolResult> {
  try {
    const full = resolveUnderBase(baseDir, relativePath);
    const alreadyExists = await exists(full);
    if (alreadyExists && options?.overwriteExisting !== true) {
      return {
        success: false,
        error:
          'unsafe_full_overwrite: 目标文件已存在。为避免整文件覆盖导致功能丢失，默认禁止直接 writeFile 覆盖；请先 readFile 后做最小改动，并显式传 overwriteExisting=true。',
      };
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return {
      success: true,
      data: {
        path: relativePath,
        bytes: Buffer.byteLength(content, 'utf8'),
        overwrittenExisting: alreadyExists,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

export async function toolReadFile(
  baseDir: string,
  relativePath: string,
): Promise<FileToolResult> {
  try {
    const full = resolveUnderBase(baseDir, relativePath);
    const content = await readFile(full, 'utf8');
    return {
      success: true,
      data: { path: relativePath, content },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

export async function toolListFiles(
  baseDir: string,
  relativePath: string,
): Promise<FileToolResult> {
  try {
    const full = resolveUnderBase(baseDir, relativePath);
    const names = await readdir(full);
    return {
      success: true,
      data: { path: relativePath, entries: names },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
