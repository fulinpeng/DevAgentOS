import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { TaskRedis } from '../../infrastructure/redis/task.redis';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleService } from '../role/application/role.service';
import {
  approvalReason,
  parameterSourceLabel,
} from '../role/domain/approval-policy';

export type PendingApprovalRow = Task & {
  parameterSourceLabel: string;
  approvalReason: string | null;
};

function enrichTask(row: Task): PendingApprovalRow {
  const snap = { name: row.name, parameters: row.parameters };
  return {
    ...row,
    parameterSourceLabel: parameterSourceLabel(snap),
    approvalReason: approvalReason(snap),
  };
}

@Injectable()
export class TaskApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
    private readonly taskRedis: TaskRedis,
  ) {}

  async listPendingApproval(): Promise<PendingApprovalRow[]> {
    const rows = await this.prisma.task.findMany({
      where: { status: TaskStatus.WAITING_APPROVAL },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(enrichTask);
  }

  async approve(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (task.status !== TaskStatus.WAITING_APPROVAL) {
      throw new ConflictException(
        `Task ${taskId} is not waiting for approval (status=${task.status})`,
      );
    }

    const prev =
      task.parameters !== null &&
      typeof task.parameters === 'object' &&
      !Array.isArray(task.parameters)
        ? { ...(task.parameters as Record<string, unknown>) }
        : {};
    const nextParams = { ...prev, approvalGranted: true };

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.PENDING,
        parameters: nextParams as Prisma.InputJsonValue,
      },
    });

    await this.taskRedis.appendExecutionLog(taskId, {
      step: 'approved',
      time: new Date().toISOString(),
    });

    return this.roleService.executeTask(taskId);
  }

  async reject(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (task.status !== TaskStatus.WAITING_APPROVAL) {
      throw new ConflictException(
        `Task ${taskId} is not waiting for approval (status=${task.status})`,
      );
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.FAILED },
    });
    await this.taskRedis.setTaskStatus(taskId, 'failed');
    await this.taskRedis.appendExecutionLog(taskId, {
      step: 'rejected',
      time: new Date().toISOString(),
    });
    return { task: updated };
  }
}
