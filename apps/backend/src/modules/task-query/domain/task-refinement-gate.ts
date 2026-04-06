import { Task, TaskStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

/**
 * 微调（生成草稿 / 激活 / 按微调追加执行）仅允许对已完成任务。
 */
export function assertCompletedForRefine(task: Task): void {
  if (task.status !== TaskStatus.COMPLETED) {
    throw new BadRequestException(
      `仅 COMPLETED 任务可进行微调（当前=${task.status}）`,
    );
  }
}
