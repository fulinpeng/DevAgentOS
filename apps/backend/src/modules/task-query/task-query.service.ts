import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { TaskRedis } from '../../infrastructure/redis/task.redis';
import { PrismaService } from '../../prisma/prisma.service';
import {
  approvalReason,
  parameterSourceLabel,
} from '../role/domain/approval-policy';
import { resolveRiskLevelForDisplay } from '../role/domain/risk-policy';

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

/**
 * 任务查询为主；另提供 CREATED 主任务的草稿编辑（合并 parameters）。
 */
@Injectable()
export class TaskQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskRedis: TaskRedis,
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

  getTaskLogs(taskId: string) {
    return this.taskRedis.getExecutionLogs(taskId);
  }

  /**
   * 仅主任务且 CREATED：可选更新 name；若带 parameters 则整段替换（便于清空 features 等字段）。
   */
  async updateRootTaskDraft(
    taskId: string,
    dto: { name?: string; parameters?: Record<string, unknown> },
  ): Promise<TaskDetailPayload> {
    if (dto.name === undefined && dto.parameters === undefined) {
      throw new BadRequestException('至少需要提供 name 或 parameters 之一');
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (task.parentId !== null) {
      throw new BadRequestException('仅主任务可编辑草稿');
    }
    if (task.status !== TaskStatus.CREATED) {
      throw new ConflictException(
        `仅 CREATED 状态可编辑名称与参数（当前=${task.status}）`,
      );
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.parameters !== undefined
          ? { parameters: dto.parameters as Prisma.InputJsonValue }
          : {}),
      },
    });

    return this.getTaskDetail(taskId);
  }
}
