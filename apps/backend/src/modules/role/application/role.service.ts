import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CoordinatorService } from '../../coordinator/application/coordinator.service';
import { Task, TaskStatus } from '@prisma/client';
import { TASK_STATUS_WORKER_PAUSED } from '../../../prisma/task-status';
import { shouldRequireApproval } from '../domain/approval-policy';
import { evaluateRisk } from '../domain/risk-policy';
import {
  routeRoleExecution,
  type TaskStatusSnapshot,
} from '../domain/execution-policy';
import {
  type IWorkerExecutor,
  WORKER_EXECUTOR,
} from '../infrastructure/worker.executor';
import { RoleTaskRedis } from '../infrastructure/task.redis';
import { RoleTaskRepository } from '../infrastructure/task.repository';

/** 由 Coordinator 调用时传 chainFromCoordinator，避免子任务完成后再次嵌套 runForParent */
export type ExecuteTaskOptions = {
  chainFromCoordinator?: boolean;
};

export type RoleExecuteResult = {
  task: Task;
  workerResult: { success: boolean; result: Record<string, unknown> };
  idempotent?: boolean;
  /** 已进入待审批，未调用 Worker */
  pausedForApproval?: boolean;
  /** Worker 步骤超时等可续跑暂停，任务已标为 WORKER_PAUSED */
  workerPaused?: boolean;
};

const REDIS_RUNNING = 'running';
const REDIS_COMPLETED = 'completed';
const REDIS_WAITING_APPROVAL = 'waiting_approval';
const REDIS_WORKER_PAUSED = 'worker_paused';

function toStatusSnapshot(status: TaskStatus): TaskStatusSnapshot {
  return status as TaskStatusSnapshot;
}

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

function mergeParameters(
  base: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const prev = jsonToResultRecord(base);
  return { ...prev, ...patch };
}

function stripWorkerResumeSteps(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const { workerResumeSteps: _w, ...rest } = params;
  return rest;
}

@Injectable()
export class RoleService {
  constructor(
    private readonly taskRepository: RoleTaskRepository,
    private readonly taskRedis: RoleTaskRedis,
    @Inject(WORKER_EXECUTOR) private readonly workerExecutor: IWorkerExecutor,
    @Inject(forwardRef(() => CoordinatorService))
    private readonly coordinatorService: CoordinatorService,
  ) {}

  async executeTask(
    taskId: string,
    options?: ExecuteTaskOptions,
  ): Promise<RoleExecuteResult> {
    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    if (!task.parentId) {
      const childCount = await this.taskRepository.countChildren(task.id);
      if (childCount > 0) {
        throw new ConflictException(
          `含子任务的主任务请使用 POST /coordinator/run/${task.id} 执行，勿对主任务直接调用 Role`,
        );
      }
    }

    const route = routeRoleExecution({ status: toStatusSnapshot(task.status) });
    if (route === 'blocked_plan') {
      throw new ConflictException(
        '主任务当前不可由 Role 直接执行：请先 POST /workflow/generate/:taskId 生成计划，再 POST /task/approve-plan/:id 审批，最后 POST /coordinator/run/:id',
      );
    }
    if (route === 'blocked_approval') {
      return {
        task,
        workerResult: { success: false, result: {} },
        idempotent: true,
        pausedForApproval: true,
      };
    }
    if (route === 'blocked_failed') {
      return {
        task,
        workerResult: {
          success: false,
          result: jsonToResultRecord(task.result),
        },
        idempotent: true,
      };
    }
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
      const r2 = routeRoleExecution({ status: toStatusSnapshot(latest.status) });
      if (r2 === 'blocked_approval') {
        return {
          task: latest,
          workerResult: { success: false, result: {} },
          idempotent: true,
          pausedForApproval: true,
        };
      }
      if (r2 === 'blocked_failed') {
        return {
          task: latest,
          workerResult: {
            success: false,
            result: jsonToResultRecord(latest.result),
          },
          idempotent: true,
        };
      }
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
      if (r2 === 'blocked_plan') {
        throw new ConflictException(
          '主任务当前不可由 Role 直接执行：请先完成计划生成与审批，再使用 Coordinator',
        );
      }

      const risk = evaluateRisk(latest);
      let mergedParams = mergeParameters(latest.parameters, {
        riskLevel: risk,
      });

      if (latest.status === TASK_STATUS_WORKER_PAUSED) {
        const prevResult = jsonToResultRecord(latest.result);
        const rem = prevResult.remainingSteps;
        if (Array.isArray(rem) && rem.length > 0) {
          mergedParams = mergeParameters(mergedParams, {
            workerResumeSteps: rem,
          });
        }
      }

      await this.taskRedis.appendLog(taskId, 'risk_evaluated', {
        level: risk,
      });

      const gateSnapshot = { name: latest.name, parameters: mergedParams };
      if (
        latest.status !== TASK_STATUS_WORKER_PAUSED &&
        shouldRequireApproval(gateSnapshot)
      ) {
        const waiting = await this.taskRepository.updateTask(taskId, {
          status: TaskStatus.WAITING_APPROVAL,
          parameters: mergedParams,
        });
        await this.taskRedis.updateStatus(taskId, REDIS_WAITING_APPROVAL);
        await this.taskRedis.appendLog(taskId, 'approval_requested');
        return {
          task: waiting,
          workerResult: { success: false, result: {} },
          pausedForApproval: true,
        };
      }

      const latestForRun = await this.taskRepository.updateTask(taskId, {
        parameters: mergedParams,
      });

      await this.taskRedis.appendLog(taskId, 'role_execution_start');
      await this.taskRepository.updateTask(taskId, {
        status: TaskStatus.RUNNING,
      });
      await this.taskRedis.updateStatus(taskId, REDIS_RUNNING);

      const workerResult = await this.workerExecutor.execute({
        id: latestForRun.id,
        name: latestForRun.name,
        role: latestForRun.role,
        parameters: mergedParams,
        parentId: latestForRun.parentId,
      });

      await this.taskRedis.appendLog(taskId, 'worker_called', {
        success: workerResult.success,
      });

      const wr = jsonToResultRecord(workerResult.result);
      if (wr.workerPaused === true) {
        const updated = await this.taskRepository.updateTask(taskId, {
          status: TASK_STATUS_WORKER_PAUSED,
          result: workerResult.result,
        });
        await this.taskRedis.updateStatus(taskId, REDIS_WORKER_PAUSED);
        await this.taskRedis.appendLog(taskId, 'worker_paused', {
          pauseReason: wr.pauseReason,
        });
        return { task: updated, workerResult, workerPaused: true };
      }

      if (!workerResult.success) {
        throw new BadRequestException('Worker execution failed');
      }

      const paramsAfter = stripWorkerResumeSteps(mergedParams);

      const updated = await this.taskRepository.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        result: workerResult.result,
        parameters: paramsAfter,
      });
      await this.taskRedis.updateStatus(taskId, REDIS_COMPLETED);
      await this.taskRedis.appendLog(taskId, 'completed');

      if (
        latestForRun.parentId &&
        !options?.chainFromCoordinator
      ) {
        await this.coordinatorService.runForParent(latestForRun.parentId);
      }

      return { task: updated, workerResult };
    } finally {
      await this.taskRedis.releaseLock(taskId);
    }
  }
}
