import { Injectable } from '@nestjs/common';
import { Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class CoordinatorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 仅接受顶层主任务（parentId 为空） */
  async findParentWithChildren(parentId: string): Promise<{
    parent: Task;
    children: Task[];
  } | null> {
    const parent = await this.prisma.task.findUnique({
      where: { id: parentId },
    });
    if (!parent || parent.parentId !== null) {
      return null;
    }
    const children = await this.prisma.task.findMany({
      where: { parentId },
      orderBy: { sortOrder: 'asc' },
    });
    return { parent, children };
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
