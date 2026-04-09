import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { TaskRedis } from '../../infrastructure/redis/task.redis';
import { PrismaService } from '../../prisma/prisma.service';
import { TASK_STATUS_WORKER_PAUSED } from '../../prisma/task-status';
import { RoleService } from '../role/application/role.service';
import {
  approvalReason,
  parameterSourceLabel,
} from '../role/domain/approval-policy';
import { resolveRiskLevelForDisplay } from '../role/domain/risk-policy';
import { assertCanAppendChildTask } from './domain/task-append-gate';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';

function jsonToResultRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

export type TaskDetailNode = Task & {
  parameterSourceLabel: string;
  approvalReason: string | null;
  /** low | medium | high */
  riskLevel: string;
};

export type TaskDetailPayload = {
  task: TaskDetailNode;
  children: TaskDetailNode[];
};

export type RootTaskListItem = {
  id: string;
  name: string;
  status: string;
  childCount: number;
  createdAt: Date;
  /** low | medium | high */
  riskLevel: string;
};

function isTaskEditableBeforeExecution(status: TaskStatus): boolean {
  return !(
    status === TaskStatus.RUNNING ||
    status === TaskStatus.COMPLETED ||
    status === TaskStatus.FAILED ||
    status === TaskStatus.WORKER_PAUSED
  );
}

function stripWorkerResumeStepsFromParams(
  parameters: Prisma.JsonValue | null,
): Prisma.InputJsonValue | null {
  if (parameters === null) {
    return null;
  }
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    return parameters as Prisma.InputJsonValue;
  }
  const { workerResumeSteps: _w, ...rest } = parameters as Record<
    string,
    unknown
  >;
  return rest as Prisma.InputJsonValue;
}

/**
 * 任务查询为主；另提供未执行任务字段编辑、追加子任务等。
 */
@Injectable()
export class TaskQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskRedis: TaskRedis,
    private readonly roleService: RoleService,
  ) {}

  async listRootTasks(): Promise<RootTaskListItem[]> {
    const rows = await this.prisma.task.findMany({
      where: { parentId: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { children: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      childCount: r._count.children,
      createdAt: r.createdAt,
      riskLevel: resolveRiskLevelForDisplay({
        name: r.name,
        parameters: r.parameters,
      }),
    }));
  }

  async getTaskDetail(taskId: string): Promise<TaskDetailPayload> {
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        children: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!row) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    const { children, ...task } = row;
    const enrich = (t: Task): TaskDetailNode => {
      const snap = { name: t.name, parameters: t.parameters };
      return {
        ...t,
        parameterSourceLabel: parameterSourceLabel(snap),
        approvalReason: approvalReason(snap),
        riskLevel: resolveRiskLevelForDisplay(snap),
      };
    };
    return {
      task: enrich(task),
      children: children.map(enrich),
    };
  }

  async getTaskLogs(taskId: string) {
    try {
      return await this.taskRedis.getExecutionLogs(taskId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ServiceUnavailableException(
        `Redis 不可用，无法读取任务日志。请确认 Redis 已启动且 apps/backend/.env 的 REDIS_URL 可连通。底层错误：${msg}`,
      );
    }
  }

  /**
   * 未开始执行（非 RUNNING/COMPLETED/FAILED/WORKER_PAUSED）时可编辑 name、role、sortOrder、parameters。
   */
  async updateTaskEditableFields(
    taskId: string,
    dto: {
      name?: string;
      role?: string;
      sortOrder?: number;
      parameters?: Record<string, unknown>;
    },
  ): Promise<TaskDetailPayload> {
    const provided =
      dto.name !== undefined ||
      dto.role !== undefined ||
      dto.sortOrder !== undefined ||
      dto.parameters !== undefined;
    if (!provided) {
      throw new BadRequestException('至少需要提供一个可编辑字段');
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (!isTaskEditableBeforeExecution(task.status)) {
      throw new ConflictException(
        `当前状态不可编辑（${task.status}）；仅未开始执行的任务可修改`,
      );
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.role !== undefined
          ? { role: dto.role.trim() === '' ? null : dto.role.trim() }
          : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.parameters !== undefined
          ? { parameters: dto.parameters as Prisma.InputJsonValue }
          : {}),
      },
    });

    return this.getTaskDetail(taskId);
  }

  /**
   * 微调「执行」前：将 COMPLETED/FAILED 置为 PENDING、清空 result，续跑日志仍挂在同一 taskId。
   */
  async prepareTaskForRerunAfterRefinement(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (
      task.status !== TaskStatus.COMPLETED &&
      task.status !== TaskStatus.FAILED
    ) {
      throw new BadRequestException(
        `仅 COMPLETED 或 FAILED 可准备重新执行（当前=${task.status}）`,
      );
    }
    if (!task.parentId) {
      const childCount = await this.prisma.task.count({
        where: { parentId: task.id },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          '含子任务的主任务不能对主任务单独重跑；请对子任务进行微调后执行',
        );
      }
    }

    const nextParams = stripWorkerResumeStepsFromParams(task.parameters);
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.PENDING,
        result: Prisma.JsonNull,
        parameters:
          nextParams === null ? Prisma.JsonNull : nextParams,
      },
    });
    await this.taskRedis.setTaskStatus(taskId, 'pending');
    await this.taskRedis.appendExecutionLog(taskId, {
      step: 'task_prepare_rerun',
      time: new Date().toISOString(),
      meta: { source: 'refine_execute_prepare' },
    });
  }

  /**
   * 在同父节点下追加子任务并执行（新 Task + Role）。
   */
  async appendTaskAndRun(
    sourceTaskId: string,
    dto: { name: string; role?: string; parameters?: Record<string, unknown> },
  ) {
    const source = await this.prisma.task.findUnique({
      where: { id: sourceTaskId },
    });
    if (!source) {
      throw new NotFoundException(`Task ${sourceTaskId} not found`);
    }
    await assertCanAppendChildTask(this.prisma, source);

    const parentId = source.parentId ?? source.id;
    const agg = await this.prisma.task.aggregate({
      where: { parentId },
      _max: { sortOrder: true },
    });
    const nextOrder = (agg._max.sortOrder ?? 0) + 1;
    const role =
      dto.role !== undefined && dto.role.trim() !== ''
        ? dto.role.trim()
        : source.role;

    const params = dto.parameters ?? {};

    const newTask = await this.prisma.task.create({
      data: {
        parentId,
        name: dto.name.trim(),
        role,
        sortOrder: nextOrder,
        status: TaskStatus.PENDING,
        parameters: params as Prisma.InputJsonValue,
      },
    });

    await this.taskRedis.appendExecutionLog(sourceTaskId, {
      step: 'task_append_created',
      time: new Date().toISOString(),
      meta: { newTaskId: newTask.id, source: 'POST /task/:id/append' },
    });

    const execResult = await this.roleService.executeTask(newTask.id);

    return {
      newTask: {
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

  /**
   * 人工将 RUNNING 标为 WORKER_PAUSED（例如前端仍显示 RUNNING 但实际已卡住），
   * 可选合并 result；续跑仍走 POST /role/execute。
   */
  async updateTaskManualStatus(
    taskId: string,
    dto: UpdateTaskStatusDto,
  ): Promise<TaskDetailPayload> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (dto.status !== 'WORKER_PAUSED') {
      throw new BadRequestException('仅支持 status=WORKER_PAUSED');
    }
    if (task.status !== TaskStatus.RUNNING) {
      throw new ConflictException(
        `仅 RUNNING 可手动置为 WORKER_PAUSED（当前=${task.status}）`,
      );
    }
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TASK_STATUS_WORKER_PAUSED,
        ...(dto.result !== undefined
          ? {
              result: {
                ...jsonToResultRecord(task.result),
                ...dto.result,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    await this.taskRedis.setTaskStatus(taskId, 'worker_paused');
    await this.taskRedis.appendExecutionLog(taskId, {
      step: 'task_manual_worker_paused',
      time: new Date().toISOString(),
      meta: { source: 'PATCH /task/:id/status' },
    });
    return this.getTaskDetail(taskId);
  }
}
