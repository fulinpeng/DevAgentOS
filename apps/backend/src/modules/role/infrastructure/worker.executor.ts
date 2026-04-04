import { Injectable } from '@nestjs/common';

/** Worker 执行端口（模拟实现，无外部 API） */
export type WorkerExecuteInput = {
  id: string;
  name: string;
  role: string | null;
};

export type WorkerExecuteOutput = {
  success: boolean;
  result: Record<string, unknown>;
};

export interface IWorkerExecutor {
  execute(task: WorkerExecuteInput): Promise<WorkerExecuteOutput>;
}

@Injectable()
export class MockWorkerExecutor implements IWorkerExecutor {
  async execute(_task: WorkerExecuteInput): Promise<WorkerExecuteOutput> {
    return { success: true, result: {} };
  }
}
