import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis：`task:<uuid>` → 状态字符串（如 pending），与验收示例一致用小写。
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

  private key(taskId: string): string {
    return `task:${taskId}`;
  }

  async setTaskStatus(taskId: string, status: string): Promise<void> {
    await this.client.set(this.key(taskId), status);
  }

  async getTaskStatus(taskId: string): Promise<string | null> {
    return this.client.get(this.key(taskId));
  }
}
