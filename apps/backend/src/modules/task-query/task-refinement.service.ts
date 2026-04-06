import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TaskRedis } from '../../infrastructure/redis/task.redis';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleService } from '../role/application/role.service';
import { TaskQueryService } from './task-query.service';
import { WorkflowLlmService } from '../workflow/infrastructure/llm.service';
import { assertCompletedForRefine } from './domain/task-refinement-gate';
import {
  type RefinementPayload,
  parseRefinementLlmOutput,
  refinePayloadFromValue,
} from './domain/task-refinement-parse';
import {
  TASK_REFINEMENT_SYSTEM_PROMPT,
  buildTaskRefinementUserPrompt,
} from './infrastructure/task-refinement.prompt';

function taskSnapshotForPrompt(task: {
  id: string;
  name: string;
  role: string | null;
  status: string;
  parentId: string | null;
  sortOrder: number;
  parameters: Prisma.JsonValue;
}): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    role: task.role,
    status: task.status,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    parameters: task.parameters ?? null,
  };
}

function mergeParametersIntoTask(
  current: Prisma.JsonValue | null,
  payload: RefinementPayload,
): Prisma.InputJsonValue {
  const base =
    current !== null &&
    typeof current === 'object' &&
    !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const { role: _dropRole, name: _dropName, ...restParams } =
    payload.parameters;
  return {
    ...base,
    ...restParams,
    description: payload.description,
    steps: payload.steps,
  } as Prisma.InputJsonValue;
}

@Injectable()
export class TaskRefinementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowLlm: WorkflowLlmService,
    private readonly roleService: RoleService,
    private readonly taskRedis: TaskRedis,
    private readonly taskQueryService: TaskQueryService,
  ) {}

  /**
   * 列出某任务的全部微调版本（新版本号在前）。
   */
  async listVersions(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    assertCompletedForRefine(task);
    return this.prisma.taskVersion.findMany({
      where: { taskId },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * 基于当前任务与指令生成新版本草稿（isActive=false）。
   */
  async refine(taskId: string, instruction: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    assertCompletedForRefine(task);

    const taskJson = JSON.stringify(
      taskSnapshotForPrompt(task),
      null,
      2,
    );
    const userPrompt = buildTaskRefinementUserPrompt(taskJson, instruction);
    const raw = await this.workflowLlm.callLLM(
      TASK_REFINEMENT_SYSTEM_PROMPT,
      userPrompt,
    );
    const parsed = parseRefinementLlmOutput(raw);
    if (!parsed) {
      throw new BadRequestException(
        'LLM 输出无法解析为合法 JSON，或缺少 description / parameters / steps',
      );
    }

    const agg = await this.prisma.taskVersion.aggregate({
      where: { taskId },
      _max: { version: true },
    });
    const nextVersion = (agg._max.version ?? 0) + 1;

    const data = parsed as unknown as Prisma.InputJsonValue;
    return this.prisma.taskVersion.create({
      data: {
        taskId,
        version: nextVersion,
        data,
        isActive: false,
      },
    });
  }

  /**
   * 激活指定版本：同任务其他版本置为非激活，并将 data 合并写入 Task.parameters（不改 name / role 列）。
   */
  async activateVersion(versionId: string) {
    const ver = await this.prisma.taskVersion.findUnique({
      where: { id: versionId },
    });
    if (!ver) {
      throw new NotFoundException(`TaskVersion ${versionId} not found`);
    }

    const task = await this.prisma.task.findUnique({
      where: { id: ver.taskId },
    });
    if (!task) {
      throw new NotFoundException(`Task ${ver.taskId} not found`);
    }
    assertCompletedForRefine(task);

    const payload = refinePayloadFromValue(ver.data);
    if (!payload) {
      throw new BadRequestException('该版本 data 结构无效，无法激活');
    }

    const merged = mergeParametersIntoTask(task.parameters, payload);

    await this.prisma.$transaction([
      this.prisma.taskVersion.updateMany({
        where: { taskId: ver.taskId, id: { not: versionId } },
        data: { isActive: false },
      }),
      this.prisma.taskVersion.update({
        where: { id: versionId },
        data: { isActive: true },
      }),
      this.prisma.task.update({
        where: { id: ver.taskId },
        data: { parameters: merged },
      }),
    ]);

    return this.prisma.taskVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
  }

  /**
   * 微调后执行：先在本任务上置为 PENDING 并清空 result（与新增任务不同），再对同一 taskId 调用 Role，
   * 执行日志仍追加在当前任务的 Redis 键下。
   */
  async executeRefinementAsRerunOnSameTask(taskId: string, versionId?: string) {
    const source = await this.prisma.task.findUnique({
      where: { id: taskId },
    });
    if (!source) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    assertCompletedForRefine(source);
    await this.resolveVersionForExecute(taskId, versionId);

    await this.taskQueryService.prepareTaskForRerunAfterRefinement(taskId);

    const execResult = await this.roleService.executeTask(taskId);

    return {
      task: {
        id: execResult.task.id,
        name: execResult.task.name,
        status: execResult.task.status,
      },
      workerResult: execResult.workerResult,
      idempotent: execResult.idempotent,
      pausedForApproval: execResult.pausedForApproval,
      workerPaused: execResult.workerPaused,
    };
  }

  private async resolveVersionForExecute(taskId: string, versionId?: string) {
    if (versionId) {
      const v = await this.prisma.taskVersion.findFirst({
        where: { id: versionId, taskId },
      });
      if (!v) {
        throw new NotFoundException(`TaskVersion ${versionId} not found`);
      }
      return v;
    }
    const active = await this.prisma.taskVersion.findFirst({
      where: { taskId, isActive: true },
    });
    if (!active) {
      throw new BadRequestException('请先激活某一微调版本，再执行重跑');
    }
    return active;
  }
}
