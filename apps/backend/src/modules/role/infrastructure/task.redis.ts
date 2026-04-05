import { Injectable } from '@nestjs/common';
import {
  TaskExecutionLogEntry,
  TaskRedis,
} from '../../../infrastructure/redis/task.redis';

/** Role 边界内的 Redis 适配（复用全局连接与键规范） */
@Injectable()
export class RoleTaskRedis {
  constructor(private readonly taskRedis: TaskRedis) {}

  async updateStatus(taskId: string, status: string): Promise<void> {
    await this.taskRedis.setTaskStatus(taskId, status);
  }

  async acquireLock(taskId: string, ttlSeconds?: number): Promise<boolean> {
    return this.taskRedis.acquireExecutionLock(taskId, ttlSeconds);
  }

  async releaseLock(taskId: string): Promise<void> {
    await this.taskRedis.releaseExecutionLock(taskId);
  }

  async appendLog(
    taskId: string,
    step: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const entry: TaskExecutionLogEntry = {
      step,
      time: new Date().toISOString(),
      meta,
    };
    await this.taskRedis.appendExecutionLog(taskId, entry);
  }
}
