import { Injectable } from '@nestjs/common';

export const WORKER_EXECUTOR = Symbol('WORKER_EXECUTOR');

export type WorkerExecuteInput = {
  id: string;
  name: string;
  role: string | null;
  /** 任务 parameters（含 projectRoot 等）；子任务可继承父链上的 projectRoot（兼容旧 outputDir） */
  parameters: Record<string, unknown> | null;
  parentId: string | null;
};

export type WorkerExecuteOutput = {
  success: boolean;
  result: Record<string, unknown>;
};

export interface IWorkerExecutor {
  execute(task: WorkerExecuteInput): Promise<WorkerExecuteOutput>;
}

/** 测试或本地桩可用；生产环境请使用 WorkerModule 中的 WorkerExecutorService */
@Injectable()
export class MockWorkerExecutor implements IWorkerExecutor {
  async execute(_task: WorkerExecuteInput): Promise<WorkerExecuteOutput> {
    return { success: true, result: {} };
  }
}
