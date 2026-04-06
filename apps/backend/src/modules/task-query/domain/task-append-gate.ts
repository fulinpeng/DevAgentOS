import { Task, TaskStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

/**
 * 追加子任务：根任务须已生成计划（至少一条子任务），或状态已离开 CREATED。
 */
export async function assertCanAppendChildTask(
  prisma: {
    task: {
      count: (args: { where: { parentId: string } }) => Promise<number>;
    };
  },
  task: Task,
): Promise<void> {
  if (task.parentId !== null) {
    return;
  }
  const n = await prisma.task.count({ where: { parentId: task.id } });
  if (n > 0) {
    return;
  }
  if (task.status !== TaskStatus.CREATED) {
    return;
  }
  throw new BadRequestException(
    '请先生成工作流计划（至少产生一条子任务）后再追加任务',
  );
}
