import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CoordinatorService } from '../application/coordinator.service';

@Controller('coordinator')
export class CoordinatorController {
  constructor(private readonly coordinatorService: CoordinatorService) {}

  @Post('run/:taskId')
  @HttpCode(HttpStatus.OK)
  run(@Param('taskId', new ParseUUIDPipe()) taskId: string) {
    return this.coordinatorService.runForParent(taskId);
  }
}
