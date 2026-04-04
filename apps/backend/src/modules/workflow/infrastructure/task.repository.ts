import { Injectable } from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { SubTaskSpec } from '../domain/task-split';

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

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
        status: TaskStatus.PENDING,
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
}
