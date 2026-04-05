import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export type TaskExecutionLogEntry = {
  step: string;
  time: string;
  meta?: Record<string, unknown>;
};

/**
 * 全局任务状态：`task:<id>` → 小写状态字符串。
 * 执行锁：`task:<id>:lock`（SET NX EX）。
 * 执行日志：`task:<id>:logs`（Redis List，JSON 行）。
 */
@Injectable()
export class TaskRedis implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL', 'redis://127.0.0.1:6379');
    this.client = new Redis(url);
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  private statusKey(taskId: string): string {
    return `task:${taskId}`;
  }

  private lockKey(taskId: string): string {
    return `task:${taskId}:lock`;
  }

  private logsKey(taskId: string): string {
    return `task:${taskId}:logs`;
  }

  async setTaskStatus(taskId: string, status: string): Promise<void> {
    await this.client.set(this.statusKey(taskId), status);
  }

  async getTaskStatus(taskId: string): Promise<string | null> {
    return this.client.get(this.statusKey(taskId));
  }

  /** SET NX EX，拿到锁返回 true */
  async acquireExecutionLock(
    taskId: string,
    ttlSeconds = 30,
  ): Promise<boolean> {
    const r = await this.client.set(
      this.lockKey(taskId),
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return r === 'OK';
  }

  async releaseExecutionLock(taskId: string): Promise<void> {
    await this.client.del(this.lockKey(taskId));
  }

  async appendExecutionLog(
    taskId: string,
    entry: TaskExecutionLogEntry,
  ): Promise<void> {
    await this.client.rpush(this.logsKey(taskId), JSON.stringify(entry));
  }

  async getExecutionLogs(taskId: string): Promise<TaskExecutionLogEntry[]> {
    const raw = await this.client.lrange(this.logsKey(taskId), 0, -1);
    return raw.map((line) => JSON.parse(line) as TaskExecutionLogEntry);
  }
}
