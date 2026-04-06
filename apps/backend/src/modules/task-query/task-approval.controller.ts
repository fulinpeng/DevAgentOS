import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { TaskApprovalService } from './task-approval.service';

@Controller('task')
export class TaskApprovalController {
  constructor(private readonly taskApprovalService: TaskApprovalService) {}

  @Get('pending-plan-approval')
  pendingPlanApproval() {
    return this.taskApprovalService.listPendingPlanApprovals();
  }

  @Post('approve-plan/:id')
  @HttpCode(HttpStatus.OK)
  approvePlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskApprovalService.approvePlan(id);
  }

  @Post('reject-plan/:id')
  @HttpCode(HttpStatus.OK)
  rejectPlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskApprovalService.rejectPlan(id);
  }

  @Get('pending-approval')
  pendingApproval() {
    return this.taskApprovalService.listPendingApproval();
  }

  @Post('approve/:id')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskApprovalService.approve(id);
  }

  @Post('reject/:id')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskApprovalService.reject(id);
  }
}
