import { Injectable, NotFoundException } from '@nestjs/common';
import { TaskRedis } from '../../infrastructure/redis/task.redis';
import { PrismaService } from '../../prisma/prisma.service';

export type RootTaskListItem = {
  id: string;
  name: string;
  status: string;
  childCount: number;
  createdAt: Date;
};

/**
 * 只读查询：供控制台展示，不参与任务状态机写入。
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
    }));
  }

  async getTaskDetail(taskId: string) {
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
    return { task, children };
  }

  getTaskLogs(taskId: string) {
    return this.taskRedis.getExecutionLogs(taskId);
  }
}
