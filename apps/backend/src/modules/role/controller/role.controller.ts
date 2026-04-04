import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RoleService } from '../application/role.service';

@Controller('role')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Post('execute/:taskId')
  @HttpCode(HttpStatus.OK)
  execute(@Param('taskId', new ParseUUIDPipe()) taskId: string) {
    return this.roleService.executeTask(taskId);
  }
}
