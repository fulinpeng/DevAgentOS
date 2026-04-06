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
import {
  buildFallbackSubTaskSpecs,
  parseWorkflow,
  workflowToSubTaskSpecs,
} from '../domain/task-split';
import { WorkflowLlmService } from '../infrastructure/llm.service';
import { TaskRepository } from '../infrastructure/task.repository';

export type CreateTaskResult = {
  parentTask: Task;
  subTasks: Task[];
  /** 生成计划时千问未成功等说明 */
  splitHint?: string;
};

const REDIS_STATUS_PENDING = 'pending';

function readStringParam(
  parameters: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = parameters?.[key];
  return typeof v === 'string' ? v.trim() : undefined;
}

function readStringArrayParam(
  parameters: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const v = parameters?.[key];
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.filter((x): x is string => typeof x === 'string').map((s) => s.trim());
  return out.length > 0 ? out : undefined;
}

/**
 * 应用服务：
 * - 仅创建需求（CREATED，无子任务）
 * - 生成计划（Workflow Planner → 子任务 → WAITING_PLAN_APPROVAL，不执行）
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
   * Step2：对 CREATED 主任务调用 LLM Workflow Planner，生成子任务并冻结为待审计划。
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

    const parameters =
      parent.parameters !== null &&
      typeof parent.parameters === 'object' &&
      !Array.isArray(parent.parameters)
        ? (parent.parameters as Record<string, unknown>)
        : undefined;

    const goal = readStringParam(parameters, 'goal') ?? parent.name.trim();
    const description = readStringParam(parameters, 'description');
    if (!description) {
      throw new BadRequestException(
        '请先在任务 parameters 中提供非空 description（详细自然语言需求），用于生成 Workflow 计划',
      );
    }

    const projectType = readStringParam(parameters, 'projectType');
    const techStack = readStringArrayParam(parameters, 'techStack');
    const constraints = readStringArrayParam(parameters, 'constraints');
    const outputDir = readStringParam(parameters, 'outputDir');
    const projectName = readStringParam(parameters, 'projectName');

    const llmModel = this.config.get<string>('LLM_MODEL', 'qwen-turbo');

    const raw = await this.llmService.callWorkflowPlanner({
      goal,
      description,
      ...(projectType ? { projectType } : {}),
      ...(techStack ? { techStack } : {}),
      ...(constraints ? { constraints } : {}),
      ...(outputDir ? { outputDir } : {}),
      ...(projectName ? { projectName } : {}),
    });

    if (raw?.trim()) {
      const clipped = clipLlmRawForRedis(this.config, raw.trim());
      await this.taskRedis.appendExecutionLog(parentId, {
        step: 'workflow_llm_raw',
        time: new Date().toISOString(),
        meta: {
          llmRaw: clipped.text,
          llmRawChars: clipped.totalChars,
          llmRawTruncated: clipped.truncated,
        },
      });
    }

    let parsedOk = false;
    const workflow = raw ? parseWorkflow(raw) : null;
    if (workflow) {
      parsedOk = true;
      await this.taskRedis.appendExecutionLog(parentId, {
        step: 'workflow_parsed_success',
        time: new Date().toISOString(),
        meta: { taskCount: workflow.tasks.length },
      });
    } else {
      await this.taskRedis.appendExecutionLog(parentId, {
        step: 'workflow_parsed_failed',
        time: new Date().toISOString(),
        meta: {
          hadRaw: Boolean(raw?.trim()),
        },
      });
    }

    const subSpecs = parsedOk
      ? workflowToSubTaskSpecs(workflow!, parent.name, { llmModel })
      : buildFallbackSubTaskSpecs(
          parent.name,
          goal,
          description,
          projectType ?? '',
          llmModel,
        );

    const subTasks = await this.taskRepository.createSubTasks(
      parent.id,
      subSpecs,
    );

    const auditedProjectType = parsedOk
      ? workflow!.projectType
      : (projectType ?? '').trim() || 'unknown';
    await this.taskRepository.mergeTaskParameters(parent.id, {
      goal,
      description,
      projectType: auditedProjectType,
      ...(parsedOk
        ? { workflowTechStack: workflow!.techStack }
        : {}),
      workflowPlannerUsed: true,
      workflowParsed: parsedOk,
    });

    const parentTask = await this.taskRepository.updateTaskStatus(
      parent.id,
      TaskStatus.WAITING_PLAN_APPROVAL,
    );

    await this.taskRedis.setTaskStatus(parentTask.id, REDIS_STATUS_PENDING);
    for (const sub of subTasks) {
      await this.taskRedis.setTaskStatus(sub.id, REDIS_STATUS_PENDING);
    }

    await this.taskRedis.appendExecutionLog(parentTask.id, {
      step: 'plan_generated',
      time: new Date().toISOString(),
      meta: {
        subTaskCount: subTasks.length,
        workflowParsed: parsedOk,
        fallbackPlan: !parsedOk,
      },
    });

    return {
      parentTask,
      subTasks,
      splitHint: parsedOk
        ? undefined
        : 'LLM 返回无法解析为合法 Workflow，已使用内置两任务回退；可检查日志 workflow_parsed_failed。',
    };
  }
}
