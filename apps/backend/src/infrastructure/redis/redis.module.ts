import { Global, Module } from '@nestjs/common';
import { TaskRedis } from './task.redis';

@Global()
@Module({
  providers: [TaskRedis],
  exports: [TaskRedis],
})
export class RedisInfraModule {}
