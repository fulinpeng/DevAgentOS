import { Module } from '@nestjs/common';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryService } from './task-query.service';

@Module({
  controllers: [TaskQueryController],
  providers: [TaskQueryService],
})
export class TaskQueryModule {}
