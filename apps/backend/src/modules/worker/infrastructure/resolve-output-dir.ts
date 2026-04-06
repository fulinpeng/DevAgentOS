import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * 从 parameters 读取项目根路径：优先 projectRoot，兼容旧字段 outputDir。
 */
function extractProjectRoot(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const o = params as Record<string, unknown>;
  for (const key of ['projectRoot', 'outputDir'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

/**
 * 沿当前任务及父任务链查找 projectRoot（或旧 outputDir）。
 */
export async function resolveProjectRootFromTaskChain(
  prisma: PrismaService,
  parameters: unknown,
  parentId: string | null,
): Promise<string | null> {
  const local = extractProjectRoot(parameters);
  if (local) {
    return local;
  }
  if (parentId) {
    const parent = await prisma.task.findUnique({ where: { id: parentId } });
    if (!parent) {
      return null;
    }
    return resolveProjectRootFromTaskChain(
      prisma,
      parent.parameters,
      parent.parentId,
    );
  }
  return null;
}

export function getWorkspaceRoot(config: ConfigService): string {
  const explicit = config.get<string>('WORKSPACE_ROOT');
  if (explicit?.trim()) {
    return path.resolve(explicit.trim());
  }
  return path.resolve(process.cwd(), '..', '..');
}

/** Windows 盘符路径或 UNC；在 Linux 上 path.isAbsolute 可能为 false，需单独识别 */
function looksLikeWindowsAbsolutePath(p: string): boolean {
  const t = p.trim();
  return /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('\\\\');
}

/**
 * 将任务里配置的 projectRoot 解析为实际磁盘目录（Worker cwd / 沙箱根）。
 * - 绝对路径（含 Windows `C:\\...`）：原样规范化，整段即项目根，不再截取子路径。
 * - 相对路径：相对 **workspace 根** 完整拼接（不再只取第一层目录）。
 */
export function resolveWorkerBaseDir(
  workspaceRoot: string,
  projectRootConfig: string,
): { baseDir: string; projectRoot: string } {
  const trimmed = projectRootConfig.trim();
  if (!trimmed) {
    return { baseDir: workspaceRoot, projectRoot: workspaceRoot };
  }

  if (path.isAbsolute(trimmed) || looksLikeWindowsAbsolutePath(trimmed)) {
    const baseDir = looksLikeWindowsAbsolutePath(trimmed)
      ? path.win32.normalize(trimmed)
      : path.normalize(trimmed);
    return { baseDir, projectRoot: baseDir };
  }

  const baseDir = path.resolve(workspaceRoot, trimmed);
  return { baseDir, projectRoot: baseDir };
}
