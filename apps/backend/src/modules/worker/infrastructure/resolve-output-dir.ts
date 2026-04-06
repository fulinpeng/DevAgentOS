import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

function extractOutputDir(params: unknown): string | null {
  if (params && typeof params === 'object' && 'outputDir' in params) {
    const v = (params as { outputDir?: unknown }).outputDir;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 从当前任务 parameters 或沿 parent 链查找 outputDir（相对仓库根）。
 */
export async function resolveOutputDirRelative(
  prisma: PrismaService,
  parameters: unknown,
  parentId: string | null,
): Promise<string | null> {
  const local = extractOutputDir(parameters);
  if (local) return local;
  if (parentId) {
    const parent = await prisma.task.findUnique({ where: { id: parentId } });
    if (!parent) return null;
    return resolveOutputDirRelative(prisma, parent.parameters, parent.parentId);
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

export function toAbsoluteSandbox(
  workspaceRoot: string,
  outputDirRelative: string,
): string {
  return path.resolve(workspaceRoot, outputDirRelative);
}
