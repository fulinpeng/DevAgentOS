import { Injectable } from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { SubTaskSpec } from '../domain/task-split';

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id } });
  }

  async createTask(input: {
    name: string;
    parameters?: Record<string, unknown>;
    sortOrder?: number;
  }): Promise<Task> {
    return this.prisma.task.create({
      data: {
        name: input.name,
        sortOrder: input.sortOrder ?? 0,
        parameters:
          input.parameters !== undefined
            ? (input.parameters as Prisma.InputJsonValue)
            : undefined,
        status: TaskStatus.CREATED,
      },
    });
  }

  async createSubTasks(parentId: string, specs: SubTaskSpec[]): Promise<Task[]> {
    if (specs.length === 0) {
      return [];
    }
    return this.prisma.$transaction(
      specs.map((spec) =>
        this.prisma.task.create({
          data: {
            parentId,
            name: spec.name,
            role: spec.role,
            sortOrder: spec.order,
            status: TaskStatus.PENDING,
            parameters: spec.parameters as Prisma.InputJsonValue,
          },
        }),
      ),
    );
  }

  async deleteChildrenOfParent(parentId: string): Promise<number> {
    const r = await this.prisma.task.deleteMany({
      where: { parentId },
    });
    return r.count;
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    return this.prisma.task.update({
      where: { id },
      data: { status },
    });
  }

  async countChildren(parentId: string): Promise<number> {
    return this.prisma.task.count({ where: { parentId } });
  }
}
