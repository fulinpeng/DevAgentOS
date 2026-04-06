import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { RefineTaskDto } from './dto/refine-task.dto';
import { UpdateTaskDraftDto } from './dto/update-task-draft.dto';
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

  /** 任务微调：生成新版本草稿（需后续 POST version/activate 生效） */
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

  @Get(':id/logs')
  logs(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskLogs(id);
  }

  @Patch(':id/status')
  patchStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTaskStatusDto,
  ) {
    return this.taskQueryService.updateTaskManualStatus(id, body);
  }

  @Patch(':id')
  patchDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTaskDraftDto,
  ) {
    return this.taskQueryService.updateRootTaskDraft(id, body);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskDetail(id);
  }
}
