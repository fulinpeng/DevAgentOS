import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowLlmService } from '../workflow/infrastructure/llm.service';
import {
  type RefinementPayload,
  parseRefinementLlmOutput,
  refinePayloadFromValue,
} from './domain/task-refinement-parse';
import {
  TASK_REFINEMENT_SYSTEM_PROMPT,
  buildTaskRefinementUserPrompt,
} from './infrastructure/task-refinement.prompt';

function taskSnapshotForPrompt(task: {
  id: string;
  name: string;
  role: string | null;
  status: string;
  parentId: string | null;
  sortOrder: number;
  parameters: Prisma.JsonValue;
}): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    role: task.role,
    status: task.status,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    parameters: task.parameters ?? null,
  };
}

function mergeParametersIntoTask(
  current: Prisma.JsonValue | null,
  payload: RefinementPayload,
): Prisma.InputJsonValue {
  const base =
    current !== null &&
    typeof current === 'object' &&
    !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const { role: _dropRole, name: _dropName, ...restParams } = payload.parameters;
  return {
    ...base,
    ...restParams,
    description: payload.description,
    steps: payload.steps,
  } as Prisma.InputJsonValue;
}

@Injectable()
export class TaskRefinementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowLlm: WorkflowLlmService,
  ) {}

  /**
   * 基于当前任务与指令生成新版本草稿（isActive=false）。
   */
  async refine(taskId: string, instruction: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    const taskJson = JSON.stringify(
      taskSnapshotForPrompt(task),
      null,
      2,
    );
    const userPrompt = buildTaskRefinementUserPrompt(taskJson, instruction);
    const raw = await this.workflowLlm.callLLM(
      TASK_REFINEMENT_SYSTEM_PROMPT,
      userPrompt,
    );
    const parsed = parseRefinementLlmOutput(raw);
    if (!parsed) {
      throw new BadRequestException(
        'LLM 输出无法解析为合法 JSON，或缺少 description / parameters / steps',
      );
    }

    const agg = await this.prisma.taskVersion.aggregate({
      where: { taskId },
      _max: { version: true },
    });
    const nextVersion = (agg._max.version ?? 0) + 1;

    const data = parsed as unknown as Prisma.InputJsonValue;
    return this.prisma.taskVersion.create({
      data: {
        taskId,
        version: nextVersion,
        data,
        isActive: false,
      },
    });
  }

  /**
   * 激活指定版本：同任务其他版本置为非激活，并将 data 合并写入 Task.parameters（不改 name / role 列）。
   */
  async activateVersion(versionId: string) {
    const ver = await this.prisma.taskVersion.findUnique({
      where: { id: versionId },
    });
    if (!ver) {
      throw new NotFoundException(`TaskVersion ${versionId} not found`);
    }

    const payload = refinePayloadFromValue(ver.data);
    if (!payload) {
      throw new BadRequestException('该版本 data 结构无效，无法激活');
    }

    const task = await this.prisma.task.findUnique({
      where: { id: ver.taskId },
    });
    if (!task) {
      throw new NotFoundException(`Task ${ver.taskId} not found`);
    }

    const merged = mergeParametersIntoTask(task.parameters, payload);

    await this.prisma.$transaction([
      this.prisma.taskVersion.updateMany({
        where: { taskId: ver.taskId, id: { not: versionId } },
        data: { isActive: false },
      }),
      this.prisma.taskVersion.update({
        where: { id: versionId },
        data: { isActive: true },
      }),
      this.prisma.task.update({
        where: { id: ver.taskId },
        data: { parameters: merged },
      }),
    ]);

    return this.prisma.taskVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
  }
}
