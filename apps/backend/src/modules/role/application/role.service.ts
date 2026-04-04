import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Task, TaskStatus } from '@prisma/client';
import { decideExecution } from '../domain/execution-policy';
import { MockWorkerExecutor } from '../infrastructure/worker.executor';
import { RoleTaskRedis } from '../infrastructure/task.redis';
import { RoleTaskRepository } from '../infrastructure/task.repository';

export type RoleExecuteResult = {
  task: Task;
  workerResult: { success: boolean; result: Record<string, unknown> };
};

const REDIS_RUNNING = 'running';
const REDIS_COMPLETED = 'completed';

@Injectable()
export class RoleService {
  constructor(
    private readonly taskRepository: RoleTaskRepository,
    private readonly taskRedis: RoleTaskRedis,
    private readonly workerExecutor: MockWorkerExecutor,
  ) {}

  async executeTask(taskId: string): Promise<RoleExecuteResult> {
    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    if (!decideExecution({ status: task.status })) {
      throw new BadRequestException(
        `Task ${taskId} is not executable (must be PENDING, got ${task.status})`,
      );
    }

    await this.taskRepository.updateStatus(taskId, {
      status: TaskStatus.RUNNING,
    });
    await this.taskRedis.updateStatus(taskId, REDIS_RUNNING);

    const workerResult = await this.workerExecutor.execute({
      id: task.id,
      name: task.name,
      role: task.role,
    });

    if (!workerResult.success) {
      throw new BadRequestException('Worker execution failed');
    }

    const updated = await this.taskRepository.updateStatus(taskId, {
      status: TaskStatus.COMPLETED,
      result: workerResult.result,
    });
    await this.taskRedis.updateStatus(taskId, REDIS_COMPLETED);

    return { task: updated, workerResult };
  }
}
