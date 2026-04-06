import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { UpdateTaskDraftDto } from './dto/update-task-draft.dto';
import { TaskQueryService } from './task-query.service';

@Controller('task')
export class TaskQueryController {
  constructor(private readonly taskQueryService: TaskQueryService) {}

  @Get('list')
  list() {
    return this.taskQueryService.listRootTasks();
  }

  @Get(':id/logs')
  logs(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskLogs(id);
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
