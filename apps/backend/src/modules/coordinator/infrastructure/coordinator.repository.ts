import { Injectable } from '@nestjs/common';
import { Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class CoordinatorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 任意节点及其直接子节点 */
  async findTaskWithChildren(taskId: string): Promise<{
    task: Task;
    children: Task[];
  } | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      return null;
    }
    const children = await this.prisma.task.findMany({
      where: { parentId: taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return { task, children };
  }

  /** 子树快照（含根，BFS） */
  async findSubtree(rootId: string): Promise<{
    root: Task;
    nodes: Task[];
  } | null> {
    const root = await this.prisma.task.findUnique({ where: { id: rootId } });
    if (!root) {
      return null;
    }
    const out: Task[] = [root];
    let frontier: string[] = [rootId];
    while (frontier.length > 0) {
      const children = await this.prisma.task.findMany({
        where: { parentId: { in: frontier } },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }],
      });
      if (children.length === 0) {
        break;
      }
      out.push(...children);
      frontier = children.map((c) => c.id);
    }
    return { root, nodes: out };
  }

  async updateTaskStatus(
    id: string,
    input: { status: TaskStatus },
  ): Promise<Task> {
    return this.prisma.task.update({
      where: { id },
      data: { status: input.status },
    });
  }
}
