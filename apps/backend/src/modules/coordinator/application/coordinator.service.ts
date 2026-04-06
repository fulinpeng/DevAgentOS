import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Task, TaskStatus } from '@prisma/client';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import { RoleService } from '../../role/application/role.service';
import { getNextTask } from '../domain/scheduling';
import { CoordinatorRepository } from '../infrastructure/coordinator.repository';

export type CoordinatorRunResult = {
  parent: Task;
  executedTaskIds: string[];
};

@Injectable()
export class CoordinatorService {
  constructor(
    private readonly repository: CoordinatorRepository,
    @Inject(forwardRef(() => RoleService))
    private readonly roleService: RoleService,
    private readonly taskRedis: TaskRedis,
  ) {}

  /**
   * 对主任务 id：依次通过 Role 执行未完成子任务；全部完成后将主任务标为 COMPLETED 并同步 Redis。
   * 无子任务时：若主任务未完成，则直接走 Role 执行主任务。
   */
  async runForParent(parentId: string): Promise<CoordinatorRunResult> {
    const bundle = await this.repository.findParentWithChildren(parentId);
    if (!bundle) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }

    const { parent, children } = bundle;

    /**
     * PLAN_APPROVED：正常计划通过后跑子任务。
     * COMPLETED：工作流已全部跑完；若之后又「追加子任务」，主任务仍为 COMPLETED，
     * 但存在未完成的子任务，需要 Coordinator 继续跑——须允许进入，否则会 409。
     */
    if (
      parent.status !== TaskStatus.PLAN_APPROVED &&
      parent.status !== TaskStatus.COMPLETED
    ) {
      throw new ConflictException(
        `须先通过计划审批（PLAN_APPROVED）后再运行 Coordinator（当前主任务状态=${parent.status}）。请依次：POST /workflow/generate/:id → POST /task/approve-plan/:id`,
      );
    }

    const executedTaskIds: string[] = [];

    if (children.length === 0) {
      if (parent.status === TaskStatus.COMPLETED) {
        return { parent, executedTaskIds };
      }
      // 无子任务时仅执行主任务本身（PLAN_APPROVED 且尚未拆子任务的场景）
      const r = await this.roleService.executeTask(parent.id, {
        chainFromCoordinator: true,
      });
      if (r.workerPaused) {
        return { parent: r.task, executedTaskIds };
      }
      if (!r.pausedForApproval && !r.idempotent) {
        executedTaskIds.push(parent.id);
      }
      const fresh = await this.repository.findParentWithChildren(parentId);
      return { parent: fresh!.parent, executedTaskIds };
    }

    const maxSteps = children.length + 3;
    for (let i = 0; i < maxSteps; i++) {
      const fresh = await this.repository.findParentWithChildren(parentId);
      if (!fresh) {
        break;
      }
      const next = getNextTask(
        fresh.children.map((c) => ({
          id: c.id,
          status: c.status,
          sortOrder: c.sortOrder,
        })),
      );
      if (!next) {
        break;
      }
      const r = await this.roleService.executeTask(next.id, {
        chainFromCoordinator: true,
      });
      if (r.workerPaused) {
        break;
      }
      if (r.pausedForApproval) {
        break;
      }
      if (!r.idempotent) {
        executedTaskIds.push(next.id);
      }
    }

    const finalBundle = await this.repository.findParentWithChildren(parentId);
    if (!finalBundle) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }

    const allChildrenDone = finalBundle.children.every(
      (c) => c.status === TaskStatus.COMPLETED,
    );
    if (
      allChildrenDone &&
      finalBundle.parent.status !== TaskStatus.COMPLETED
    ) {
      const updatedParent = await this.repository.updateTaskStatus(parentId, {
        status: TaskStatus.COMPLETED,
      });
      await this.taskRedis.setTaskStatus(parentId, 'completed');
      await this.taskRedis.appendExecutionLog(parentId, {
        step: 'coordinator_parent_completed',
        time: new Date().toISOString(),
      });
      return { parent: updatedParent, executedTaskIds };
    }

    return { parent: finalBundle.parent, executedTaskIds };
  }
}
