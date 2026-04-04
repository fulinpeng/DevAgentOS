import { Module } from '@nestjs/common';
import { RoleService } from './application/role.service';
import { RoleController } from './controller/role.controller';
import { MockWorkerExecutor } from './infrastructure/worker.executor';
import { RoleTaskRedis } from './infrastructure/task.redis';
import { RoleTaskRepository } from './infrastructure/task.repository';

@Module({
  controllers: [RoleController],
  providers: [
    RoleService,
    RoleTaskRepository,
    RoleTaskRedis,
    MockWorkerExecutor,
  ],
})
export class RoleModule {}
