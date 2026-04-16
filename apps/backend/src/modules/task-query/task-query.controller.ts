import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AppendTaskDto } from './dto/append-task.dto';
import { ExecuteRefinementDto } from './dto/execute-refinement.dto';
import { RefineTaskDto } from './dto/refine-task.dto';
import { UpdateTaskFieldsDto } from './dto/update-task-fields.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TaskRefinementService } from './task-refinement.service';
import { TaskQueryService } from './task-query.service';

@Controller('task')
export class TaskQueryController {
  constructor(
    private readonly taskQueryService: TaskQueryService,
    private readonly taskRefinement: TaskRefinementService,
  ) {}

  @Get('list')
  list() {
    return this.taskQueryService.listRootTasks();
  }

  /**
   * 微调后执行：先在本任务上置 PENDING 并清空 result，再对同一 taskId 执行 Role（日志仍在该任务下）。
   * 新增任务请用 POST /task/:id/append。
   */
  @Post('refine/:taskId/execute')
  executeRefinement(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() body: ExecuteRefinementDto,
  ) {
    return this.taskRefinement.executeRefinementAsRerunOnSameTask(
      taskId,
      body.versionId,
    );
  }

  /** 任务微调：生成新版本草稿（仅 COMPLETED） */
  @Post('refine/:taskId')
  refine(
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() body: RefineTaskDto,
  ) {
    return this.taskRefinement.refine(taskId, body.instruction);
  }

  /** 激活某版本并写回 Task.parameters（不改 name / role 列） */
  @Post('version/activate/:versionId')
  activateVersion(@Param('versionId', new ParseUUIDPipe()) versionId: string) {
    return this.taskRefinement.activateVersion(versionId);
  }

  /** 某任务的微调版本列表（供前端展示草稿与激活） */
  @Get(':taskId/versions')
  listVersions(@Param('taskId', new ParseUUIDPipe()) taskId: string) {
    return this.taskRefinement.listVersions(taskId);
  }

  @Get(':id/logs')
  logs(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskLogs(id);
  }

  /** 删除主任务及其子任务、微调版本（级联）；并清理相关 Redis 键 */
  @Delete(':id')
  deleteTask(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.deleteRootTask(id);
  }

  @Patch(':id/status')
  patchStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTaskStatusDto,
  ) {
    return this.taskQueryService.updateTaskManualStatus(id, body);
  }

  /** FAILED 任务：重置为 PENDING 并重新执行（不要求微调版本） */
  @Post(':id/rerun')
  rerunTask(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.rerunFailedTaskAfterReset(id);
  }

  /** 追加子任务并执行（须已生成计划，见服务内校验） */
  @Post(':id/append')
  appendTask(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AppendTaskDto,
  ) {
    return this.taskQueryService.appendTaskAndRun(id, body);
  }

  @Patch(':id')
  patchTaskFields(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTaskFieldsDto,
  ) {
    return this.taskQueryService.updateTaskEditableFields(id, body);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskDetail(id);
  }
}
