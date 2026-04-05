import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
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

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskQueryService.getTaskDetail(id);
  }
}
