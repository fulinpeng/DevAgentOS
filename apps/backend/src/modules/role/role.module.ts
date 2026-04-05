import { Module } from '@nestjs/common';
import { RoleService } from './application/role.service';
import { RoleController } from './controller/role.controller';
import {
  MockWorkerExecutor,
  WORKER_EXECUTOR,
} from './infrastructure/worker.executor';
import { RoleTaskRedis } from './infrastructure/task.redis';
import { RoleTaskRepository } from './infrastructure/task.repository';

@Module({
  controllers: [RoleController],
  providers: [
    RoleService,
    RoleTaskRepository,
    RoleTaskRedis,
    MockWorkerExecutor,
    { provide: WORKER_EXECUTOR, useExisting: MockWorkerExecutor },
  ],
  exports: [RoleService],
})
export class RoleModule {}
