import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Task, TaskStatus } from '@prisma/client';
import { routeRoleExecution } from '../domain/execution-policy';
import {
  type IWorkerExecutor,
  WORKER_EXECUTOR,
} from '../infrastructure/worker.executor';
import { RoleTaskRedis } from '../infrastructure/task.redis';
import { RoleTaskRepository } from '../infrastructure/task.repository';

export type RoleExecuteResult = {
  task: Task;
  workerResult: { success: boolean; result: Record<string, unknown> };
  idempotent?: boolean;
};

const REDIS_RUNNING = 'running';
const REDIS_COMPLETED = 'completed';

function jsonToResultRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

@Injectable()
export class RoleService {
  constructor(
    private readonly taskRepository: RoleTaskRepository,
    private readonly taskRedis: RoleTaskRedis,
    @Inject(WORKER_EXECUTOR) private readonly workerExecutor: IWorkerExecutor,
  ) {}

  async executeTask(taskId: string): Promise<RoleExecuteResult> {
    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    const route = routeRoleExecution({ status: task.status });
    if (route === 'return_completed') {
      return {
        task,
        workerResult: {
          success: true,
          result: jsonToResultRecord(task.result),
        },
        idempotent: true,
      };
    }
    if (route === 'reject_running') {
      throw new ConflictException(
        `Task ${taskId} is already running; retry later`,
      );
    }

    const locked = await this.taskRedis.acquireLock(taskId);
    if (!locked) {
      throw new ConflictException(`Task ${taskId} could not acquire lock`);
    }

    try {
      const latest = await this.taskRepository.findById(taskId);
      if (!latest) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }
      const r2 = routeRoleExecution({ status: latest.status });
      if (r2 === 'return_completed') {
        return {
          task: latest,
          workerResult: {
            success: true,
            result: jsonToResultRecord(latest.result),
          },
          idempotent: true,
        };
      }
      if (r2 === 'reject_running') {
        throw new ConflictException(
          `Task ${taskId} is already running; retry later`,
        );
      }

      await this.taskRedis.appendLog(taskId, 'role_execution_start');
      await this.taskRepository.updateStatus(taskId, {
        status: TaskStatus.RUNNING,
      });
      await this.taskRedis.updateStatus(taskId, REDIS_RUNNING);

      const workerResult = await this.workerExecutor.execute({
        id: latest.id,
        name: latest.name,
        role: latest.role,
      });

      await this.taskRedis.appendLog(taskId, 'worker_called', {
        success: workerResult.success,
      });

      if (!workerResult.success) {
        throw new BadRequestException('Worker execution failed');
      }

      const updated = await this.taskRepository.updateStatus(taskId, {
        status: TaskStatus.COMPLETED,
        result: workerResult.result,
      });
      await this.taskRedis.updateStatus(taskId, REDIS_COMPLETED);
      await this.taskRedis.appendLog(taskId, 'completed');

      return { task: updated, workerResult };
    } finally {
      await this.taskRedis.releaseLock(taskId);
    }
  }
}
