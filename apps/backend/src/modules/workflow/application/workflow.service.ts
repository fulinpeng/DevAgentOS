import { Injectable } from '@nestjs/common';
import { Task } from '@prisma/client';
import { splitTask } from '../domain/task-split';
import { TaskRedis } from '../infrastructure/task.redis';
import { TaskRepository } from '../infrastructure/task.repository';

export type CreateTaskResult = {
  parentTask: Task;
  subTasks: Task[];
};

const REDIS_STATUS_PENDING = 'pending';

/**
 * 应用服务：编排「建主任务 → 领域拆分 → 持久化 → Redis」。
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly taskRedis: TaskRedis,
  ) {}

  async createTaskWithSplit(
    name: string,
    parameters?: Record<string, unknown>,
  ): Promise<CreateTaskResult> {
    const parentTask = await this.taskRepository.createTask({
      name,
      parameters,
      sortOrder: 0,
    });
    const subSpecs = splitTask({ name, parameters });
    const subTasks = await this.taskRepository.createSubTasks(
      parentTask.id,
      subSpecs,
    );
    await this.taskRedis.setTaskStatus(parentTask.id, REDIS_STATUS_PENDING);
    for (const sub of subTasks) {
      await this.taskRedis.setTaskStatus(sub.id, REDIS_STATUS_PENDING);
    }
    return { parentTask, subTasks };
  }
}
