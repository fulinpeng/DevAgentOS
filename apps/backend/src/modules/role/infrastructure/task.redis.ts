import { Injectable } from '@nestjs/common';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';

/** Role 边界内的 Redis 适配（复用全局连接与键规范） */
@Injectable()
export class RoleTaskRedis {
  constructor(private readonly taskRedis: TaskRedis) {}

  async updateStatus(taskId: string, status: string): Promise<void> {
    await this.taskRedis.setTaskStatus(taskId, status);
  }
}
