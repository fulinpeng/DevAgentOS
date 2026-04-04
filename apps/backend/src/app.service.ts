import { Injectable } from '@nestjs/common';
import type { Task } from '@shared';

/** 校验 `@shared` 路径别名可解析（无运行时逻辑） */
type _SharedAliasOk = Task;

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
