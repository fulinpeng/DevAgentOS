import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveUnderBase } from './path-sandbox';

export type FileToolResult = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

export async function toolWriteFile(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<FileToolResult> {
  try {
    const full = resolveUnderBase(baseDir, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return {
      success: true,
      data: { path: relativePath, bytes: Buffer.byteLength(content, 'utf8') },
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
