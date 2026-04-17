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
import { getNextTaskInTree, isSubtreeCompleted } from '../domain/scheduling';
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

  private async completeReadyCoordinatorNodes(rootId: string): Promise<void> {
    for (;;) {
      const tree = await this.repository.findSubtree(rootId);
      if (!tree) {
        return;
      }
      const childrenByParent = new Map<string, Task[]>();
      for (const n of tree.nodes) {
        if (!n.parentId) {
          continue;
        }
        const arr = childrenByParent.get(n.parentId) ?? [];
        arr.push(n);
        childrenByParent.set(n.parentId, arr);
      }
      const allDescCompleted = (id: string): boolean => {
        const children = childrenByParent.get(id) ?? [];
        for (const c of children) {
          if (c.status !== TaskStatus.COMPLETED) {
            return false;
          }
          if (!allDescCompleted(c.id)) {
            return false;
          }
        }
        return true;
      };
      const depthOf = (id: string): number => {
        let d = 0;
        let cur = tree.nodes.find((x) => x.id === id) ?? null;
        while (cur?.parentId) {
          d += 1;
          cur = tree.nodes.find((x) => x.id === cur!.parentId) ?? null;
        }
        return d;
      };
      const ready = tree.nodes
        .filter((n) => n.id !== rootId)
        .filter((n) => n.status !== TaskStatus.COMPLETED)
        .filter((n) => (childrenByParent.get(n.id) ?? []).length > 0)
        .filter((n) => allDescCompleted(n.id))
        .sort((a, b) => depthOf(b.id) - depthOf(a.id));
      if (ready.length === 0) {
        return;
      }
      for (const n of ready) {
        await this.repository.updateTaskStatus(n.id, {
          status: TaskStatus.COMPLETED,
        });
        await this.taskRedis.setTaskStatus(n.id, 'completed');
        await this.taskRedis.appendExecutionLog(n.id, {
          step: 'coordinator_node_completed',
          time: new Date().toISOString(),
          meta: { source: 'coordinator_tree_compaction', rootId },
        });
      }
    }
  }

  /**
   * 对任意任务节点：按树形顺序推进其子树执行。
   * - 根节点有子任务时视为协调节点，不直接执行自身；
   * - 非根节点若未完成，先执行自身，再推进其子树；
   * - 子树完成后将当前节点置为 COMPLETED（根节点兼容仅以子树完成判定）。
   */
  async runForParent(parentId: string): Promise<CoordinatorRunResult> {
    const initial = await this.repository.findTaskWithChildren(parentId);
    if (!initial) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }
    const parent = initial.task;
    if (
      parent.status !== TaskStatus.PLAN_APPROVED &&
      parent.status !== TaskStatus.COMPLETED &&
      parent.status !== TaskStatus.PENDING &&
      parent.status !== TaskStatus.FAILED &&
      parent.status !== TaskStatus.WORKER_PAUSED
    ) {
      throw new ConflictException(
        `当前任务状态不允许进入协调执行（当前=${parent.status}）。请先完成计划审批或将任务置于可执行状态。`,
      );
    }

    const executedTaskIds: string[] = [];
    const firstTree = await this.repository.findSubtree(parentId);
    if (!firstTree) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }
    const maxSteps = firstTree.nodes.length + 8;
    for (let i = 0; i < maxSteps; i++) {
      await this.completeReadyCoordinatorNodes(parentId);
      const fresh = await this.repository.findSubtree(parentId);
      if (!fresh) {
        break;
      }
      const next = getNextTaskInTree(
        parentId,
        fresh.nodes.map((n) => ({
          id: n.id,
          parentId: n.parentId,
          status: n.status,
          sortOrder: n.sortOrder,
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

    await this.completeReadyCoordinatorNodes(parentId);
    const finalTree = await this.repository.findSubtree(parentId);
    if (!finalTree) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }

    const allChildrenDone = isSubtreeCompleted(
      parentId,
      finalTree.nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        status: n.status,
        sortOrder: n.sortOrder,
      })),
    );
    if (
      allChildrenDone &&
      finalTree.root.status !== TaskStatus.COMPLETED
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

    return { parent: finalTree.root, executedTaskIds };
  }
}
