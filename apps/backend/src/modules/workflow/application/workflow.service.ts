import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Task } from '@prisma/client';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import { WORKFLOW_SPLIT_PROMPT_VERSION } from '../domain/task-split.constants';
import { splitTask } from '../domain/task-split';
import { WorkflowLlmService } from '../infrastructure/llm.service';
import { TaskRepository } from '../infrastructure/task.repository';

export type CreateTaskResult = {
  parentTask: Task;
  subTasks: Task[];
};

const REDIS_STATUS_PENDING = 'pending';

/**
 * 应用服务：编排「建主任务 → 领域拆分 → 持久化 → Redis」。
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly taskRedis: TaskRedis,
    private readonly llmService: WorkflowLlmService,
    private readonly config: ConfigService,
  ) {}

  async createTaskWithSplit(
    name: string,
    parameters?: Record<string, unknown>,
  ): Promise<CreateTaskResult> {
    const parentTask = await this.taskRepository.createTask({
      name,
      parameters,
      sortOrder: 0,
    });

    const features = parameters?.features;
    const featureList = Array.isArray(features)
      ? features.filter((x): x is string => typeof x === 'string')
      : [];

    let llmRaw: string | null = null;
    if (featureList.length > 0) {
      llmRaw = await this.llmService.tryCallSplitTaskJson(name, featureList);
    }

    const llmModel = this.config.get<string>('LLM_MODEL', 'qwen-turbo');
    const subSpecs = splitTask({ name, parameters }, llmRaw, {
      llmModel,
      promptVersion: WORKFLOW_SPLIT_PROMPT_VERSION,
    });
    const subTasks = await this.taskRepository.createSubTasks(
      parentTask.id,
      subSpecs,
    );
    await this.taskRedis.setTaskStatus(parentTask.id, REDIS_STATUS_PENDING);
    for (const sub of subTasks) {
      await this.taskRedis.setTaskStatus(sub.id, REDIS_STATUS_PENDING);
    }
    return { parentTask, subTasks };
  }
}
