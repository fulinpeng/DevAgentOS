import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Task, TaskStatus } from '@prisma/client';
import { clipLlmRawForRedis } from '../../../infrastructure/llm-log-meta';
import { TaskRedis } from '../../../infrastructure/redis/task.redis';
import { WORKFLOW_SPLIT_PROMPT_VERSION } from '../domain/task-split.constants';
import { splitTask } from '../domain/task-split';
import { WorkflowLlmService } from '../infrastructure/llm.service';
import { TaskRepository } from '../infrastructure/task.repository';

export type CreateTaskResult = {
  parentTask: Task;
  subTasks: Task[];
  /** 生成计划时千问未成功等说明 */
  splitHint?: string;
};

const REDIS_STATUS_PENDING = 'pending';

/**
 * 应用服务：
 * - 仅创建需求（CREATED，无子任务）
 * - 生成计划（Workflow AI 拆子任务 → WAITING_PLAN_APPROVAL，不执行）
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly taskRedis: TaskRedis,
    private readonly llmService: WorkflowLlmService,
    private readonly config: ConfigService,
  ) {}

  /** Step1：只建主任务，不拆子任务、不执行 */
  async createTaskOnly(
    name: string,
    parameters?: Record<string, unknown>,
  ): Promise<CreateTaskResult> {
    const parentTask = await this.taskRepository.createTask({
      name,
      parameters,
      sortOrder: 0,
    });
    await this.taskRedis.setTaskStatus(parentTask.id, REDIS_STATUS_PENDING);
    return { parentTask, subTasks: [] };
  }

  /**
   * Step2：对 CREATED 主任务调用 AI/规则拆分，生成子任务并冻结为待审计划。
   */
  async generatePlan(parentId: string): Promise<CreateTaskResult> {
    const parent = await this.taskRepository.findById(parentId);
    if (!parent) {
      throw new NotFoundException(`Task ${parentId} not found`);
    }
    if (parent.parentId !== null) {
      throw new BadRequestException('仅主任务可生成执行计划');
    }
    if (parent.status !== TaskStatus.CREATED) {
      throw new ConflictException(
        `主任务状态须为 CREATED 才能生成计划（当前=${parent.status}）`,
      );
    }

    const existing = await this.taskRepository.countChildren(parentId);
    if (existing > 0) {
      throw new ConflictException(
        '已存在子任务，请先驳回计划或删除子任务后再生成',
      );
    }

    const name = parent.name;
    const parameters =
      parent.parameters !== null &&
      typeof parent.parameters === 'object' &&
      !Array.isArray(parent.parameters)
        ? (parent.parameters as Record<string, unknown>)
        : undefined;

    const features = parameters?.features;
    const featureList = Array.isArray(features)
      ? features.filter((x): x is string => typeof x === 'string')
      : [];
    if (featureList.length === 0) {
      throw new BadRequestException(
        '请先在任务参数中提供非空 features（或创建任务时填写），用于生成拆分计划',
      );
    }

    let llmRaw: string | null = null;
    llmRaw = await this.llmService.tryCallSplitTaskJson(name, featureList);

    const llmModel = this.config.get<string>('LLM_MODEL', 'qwen-turbo');
    const subSpecs = splitTask({ name, parameters }, llmRaw, {
      llmModel,
      promptVersion: WORKFLOW_SPLIT_PROMPT_VERSION,
    });
    if (subSpecs.length === 0) {
      throw new BadRequestException(
        '未能生成任何子任务，请检查 features 或稍后重试',
      );
    }

    const subTasks = await this.taskRepository.createSubTasks(
      parent.id,
      subSpecs,
    );

    const parentTask = await this.taskRepository.updateTaskStatus(
      parent.id,
      TaskStatus.WAITING_PLAN_APPROVAL,
    );

    await this.taskRedis.setTaskStatus(parentTask.id, REDIS_STATUS_PENDING);
    for (const sub of subTasks) {
      await this.taskRedis.setTaskStatus(sub.id, REDIS_STATUS_PENDING);
    }
    const llmTrim = llmRaw?.trim() ?? '';
    const clipped = llmTrim
      ? clipLlmRawForRedis(this.config, llmTrim)
      : null;
    await this.taskRedis.appendExecutionLog(parentTask.id, {
      step: 'plan_generated',
      time: new Date().toISOString(),
      meta: {
        subTaskCount: subTasks.length,
        llmSplitUsed: Boolean(llmTrim),
        ...(clipped
          ? {
              /** 模型返回的完整原文（默认不截断，见 LLM_RAW_LOG_MAX_CHARS） */
              llmRaw: clipped.text,
              llmRawChars: clipped.totalChars,
              llmRawTruncated: clipped.truncated,
            }
          : {}),
      },
    });

    return { parentTask, subTasks };
  }
}
