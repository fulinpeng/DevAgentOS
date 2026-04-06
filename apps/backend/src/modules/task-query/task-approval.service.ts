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
import { resolveRiskLevelForDisplay } from '../role/domain/risk-policy';

export type PendingApprovalRow = Task & {
  parameterSourceLabel: string;
  approvalReason: string | null;
  riskLevel: string;
};

function enrichTask(row: Task): PendingApprovalRow {
  const snap = { name: row.name, parameters: row.parameters };
  return {
    ...row,
    parameterSourceLabel: parameterSourceLabel(snap),
    approvalReason: approvalReason(snap),
    riskLevel: resolveRiskLevelForDisplay(snap),
  };
}

/** 计划通过后：子任务仍带 source:llm，但不再要求二次「执行前审批」。 */
function mergeApprovalGranted(parameters: unknown): Prisma.InputJsonValue {
  const prev =
    parameters !== null &&
    typeof parameters === 'object' &&
    !Array.isArray(parameters)
      ? { ...(parameters as Record<string, unknown>) }
      : {};
  return { ...prev, approvalGranted: true };
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

  /** 主任务：等待审批执行计划 */
  async listPendingPlanApprovals() {
    return this.prisma.task.findMany({
      where: {
        parentId: null,
        status: TaskStatus.WAITING_PLAN_APPROVAL,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        children: { orderBy: { sortOrder: 'asc' } },
      },
    });
  }

  /** 批准计划：主任务 WAITING_PLAN_APPROVAL → PLAN_APPROVED */
  async approvePlan(parentId: string) {
    const parent = await this.prisma.task.findUnique({
      where: { id: parentId },
      include: { children: true },
    });
    if (!parent || parent.parentId !== null) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }
    if (parent.status !== TaskStatus.WAITING_PLAN_APPROVAL) {
      throw new ConflictException(
        `任务不在待审计划状态（当前=${parent.status}）`,
      );
    }
    if (parent.children.length === 0) {
      throw new ConflictException('没有子任务，无法批准计划');
    }

    await this.prisma.$transaction([
      ...parent.children.map((child) =>
        this.prisma.task.update({
          where: { id: child.id },
          data: { parameters: mergeApprovalGranted(child.parameters) },
        }),
      ),
      this.prisma.task.update({
        where: { id: parentId },
        data: { status: TaskStatus.PLAN_APPROVED },
      }),
    ]);

    const updated = await this.prisma.task.findUniqueOrThrow({
      where: { id: parentId },
    });

    await this.taskRedis.appendExecutionLog(parentId, {
      step: 'plan_approved',
      time: new Date().toISOString(),
      meta: { subTaskCount: parent.children.length },
    });

    return { parent: updated };
  }

  /** 驳回计划：删除子任务，主任务回到 CREATED */
  async rejectPlan(parentId: string) {
    const parent = await this.prisma.task.findUnique({
      where: { id: parentId },
      include: { children: true },
    });
    if (!parent || parent.parentId !== null) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }
    if (parent.status !== TaskStatus.WAITING_PLAN_APPROVAL) {
      throw new ConflictException(
        `任务不在待审计划状态（当前=${parent.status}）`,
      );
    }

    await this.prisma.task.deleteMany({ where: { parentId } });
    const updated = await this.prisma.task.update({
      where: { id: parentId },
      data: { status: TaskStatus.CREATED },
    });

    await this.taskRedis.appendExecutionLog(parentId, {
      step: 'plan_rejected',
      time: new Date().toISOString(),
    });

    return { parent: updated };
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
