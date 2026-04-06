import { Module, forwardRef } from '@nestjs/common';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { WorkerExecutorService } from '../worker/application/worker.executor.service';
import { WorkerModule } from '../worker/worker.module';
import { RoleService } from './application/role.service';
import { RoleController } from './controller/role.controller';
import { WORKER_EXECUTOR } from './infrastructure/worker.executor';
import { RoleTaskRedis } from './infrastructure/task.redis';
import { RoleTaskRepository } from './infrastructure/task.repository';

@Module({
  imports: [WorkerModule, forwardRef(() => CoordinatorModule)],
  controllers: [RoleController],
  providers: [
    RoleService,
    RoleTaskRepository,
    RoleTaskRedis,
    { provide: WORKER_EXECUTOR, useExisting: WorkerExecutorService },
  ],
  exports: [RoleService],
})
export class RoleModule {}
