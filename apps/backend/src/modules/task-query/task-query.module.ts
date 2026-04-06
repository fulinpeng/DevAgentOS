import { Module } from '@nestjs/common';
import { RoleModule } from '../role/role.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TaskApprovalController } from './task-approval.controller';
import { TaskApprovalService } from './task-approval.service';
import { TaskQueryController } from './task-query.controller';
import { TaskRefinementService } from './task-refinement.service';
import { TaskQueryService } from './task-query.service';

@Module({
  imports: [RoleModule, WorkflowModule],
  controllers: [TaskApprovalController, TaskQueryController],
  providers: [TaskQueryService, TaskApprovalService, TaskRefinementService],
})
export class TaskQueryModule {}
