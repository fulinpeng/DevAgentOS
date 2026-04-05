import { Module } from '@nestjs/common';
import { RoleModule } from '../role/role.module';
import { TaskApprovalController } from './task-approval.controller';
import { TaskApprovalService } from './task-approval.service';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryService } from './task-query.service';

@Module({
  imports: [RoleModule],
  controllers: [TaskApprovalController, TaskQueryController],
  providers: [TaskQueryService, TaskApprovalService],
})
export class TaskQueryModule {}
