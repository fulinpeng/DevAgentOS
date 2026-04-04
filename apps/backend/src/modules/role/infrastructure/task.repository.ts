import { Injectable } from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class RoleTaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id } });
  }

  async updateStatus(
    id: string,
    input: { status: TaskStatus; result?: Record<string, unknown> },
  ): Promise<Task> {
    return this.prisma.task.update({
      where: { id },
      data: {
        status: input.status,
        result:
          input.result !== undefined
            ? (input.result as Prisma.InputJsonValue)
            : undefined,
      },
    });
  }
}
