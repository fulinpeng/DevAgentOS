import {
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
    const executedTaskIds: string[] = [];

    if (children.length === 0) {
      if (parent.status !== TaskStatus.COMPLETED) {
        const r = await this.roleService.executeTask(parent.id);
        if (!r.idempotent) {
          executedTaskIds.push(parent.id);
        }
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
      await this.roleService.executeTask(next.id);
      executedTaskIds.push(next.id);
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
