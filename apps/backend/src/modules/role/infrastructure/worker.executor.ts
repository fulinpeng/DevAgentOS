import { Injectable } from '@nestjs/common';

export const WORKER_EXECUTOR = Symbol('WORKER_EXECUTOR');

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
