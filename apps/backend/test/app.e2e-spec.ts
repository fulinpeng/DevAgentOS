import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { WorkflowLlmService } from './../src/modules/workflow/infrastructure/llm.service';
import type { TaskExecutionLogEntry } from './../src/infrastructure/redis/task.redis';
import { TaskRedis } from './../src/infrastructure/redis/task.redis';
import { PrismaService } from './../src/prisma/prisma.service';
import { TaskStatus } from '@prisma/client';

function createTaskRedisMock(redisStore: Map<string, string>) {
  const locks = new Set<string>();
  const logLists = new Map<string, TaskExecutionLogEntry[]>();

  return {
    mock: {
      setTaskStatus: async (id: string, status: string) => {
        redisStore.set(`task:${id}`, status);
      },
      getTaskStatus: async (id: string) =>
        redisStore.get(`task:${id}`) ?? null,
      acquireExecutionLock: async (id: string) => {
        if (locks.has(id)) {
          return false;
        }
        locks.add(id);
        return true;
      },
      releaseExecutionLock: async (id: string) => {
        locks.delete(id);
      },
      appendExecutionLog: async (
        id: string,
        entry: TaskExecutionLogEntry,
      ) => {
        const list = logLists.get(id) ?? [];
        list.push(entry);
        logLists.set(id, list);
      },
      getExecutionLogs: async (id: string) => logLists.get(id) ?? [],
      onModuleDestroy: async () => {},
    },
    getLogs: (id: string) => logLists.get(id) ?? [],
  };
}

describe('Workflow + Role + Coordinator (e2e)', () => {
  let app: INestApplication<App>;
  let redisStore: Map<string, string>;
  let getLogsForTask: (id: string) => TaskExecutionLogEntry[];

  beforeEach(async () => {
    redisStore = new Map();
    const { mock, getLogs } = createTaskRedisMock(redisStore);
    getLogsForTask = getLogs;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TaskRedis)
      .useValue(mock)
      .overrideProvider(WorkflowLlmService)
      .useValue({
        tryCallSplitTaskJson: async () => null as string | null,
        callLLM: async () => '{"action":"noop","args":{}}',
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const prisma = app.get(PrismaService);
    await prisma.task.deleteMany();
  });

  async function generateAndApprovePlan(parentId: string) {
    await request(app.getHttpServer())
      .post(`/workflow/generate/${parentId}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/task/approve-plan/${parentId}`)
      .expect(200);
  }

  it('POST /task/create：仅主任务 CREATED，无子任务', async () => {
    const res = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const { parentTask, subTasks } = res.body;
    expect(subTasks).toHaveLength(0);
    expect(parentTask.status).toBe('CREATED');

    const prisma = app.get(PrismaService);
    const count = await prisma.task.count();
    expect(count).toBe(1);
  });

  it('PATCH /task/:id：CREATED 主任务可补全 parameters', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({ name: 'draft only' })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;

    const patch = await request(app.getHttpServer())
      .patch(`/task/${parentId}`)
      .send({
        name: 'draft only',
        parameters: { features: ['a', 'b'], outputDir: 'apps/frontend/src' },
      })
      .expect(200);

    expect(patch.body.task.status).toBe('CREATED');
    const params = patch.body.task.parameters as {
      features: string[];
      outputDir: string;
    };
    expect(params.features).toEqual(['a', 'b']);
    expect(params.outputDir).toBe('apps/frontend/src');
  });

  it('POST /workflow/generate + approve-plan：生成子任务且主任务 PLAN_APPROVED', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;

    const gen = await request(app.getHttpServer())
      .post(`/workflow/generate/${parentId}`)
      .expect(200);

    expect(gen.body.parentTask.status).toBe('WAITING_PLAN_APPROVAL');
    expect(gen.body.subTasks).toHaveLength(2);

    const appr = await request(app.getHttpServer())
      .post(`/task/approve-plan/${parentId}`)
      .expect(200);

    expect(appr.body.parent.status).toBe('PLAN_APPROVED');
  });

  it('POST /role/execute：状态与 Redis，执行日志包含关键 step', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const prisma = app.get(PrismaService);
    const sub = await prisma.task.findFirstOrThrow({
      where: { parentId },
      orderBy: { sortOrder: 'asc' },
    });
    const subId = sub.id;

    const execRes = await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    expect(execRes.body.workerResult.success).toBe(true);
    expect(execRes.body.workerResult.result).toMatchObject({
      action: 'noop',
    });
    expect(execRes.body.task.status).toBe('COMPLETED');
    expect(redisStore.get(`task:${subId}`)).toBe('completed');

    const steps = getLogsForTask(subId).map((e) => e.step);
    expect(steps).toContain('risk_evaluated');
    expect(steps).toContain('role_execution_start');
    expect(steps).toContain('tool_called');
    expect(steps).toContain('worker_called');
    expect(steps).toContain('completed');
  });

  it('COMPLETED 再次执行 → 200 幂等', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'x',
        parameters: { features: ['a'], outputDir: 'apps/frontend/src' },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const prisma = app.get(PrismaService);
    const sub = await prisma.task.findFirstOrThrow({
      where: { parentId },
    });
    const subId = sub.id;

    await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    const again = await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    expect(again.body.idempotent).toBe(true);
    expect(again.body.task.status).toBe('COMPLETED');
  });

  it('RUNNING 状态再次执行 → 409', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'x',
        parameters: { features: ['a'], outputDir: 'apps/frontend/src' },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const prisma = app.get(PrismaService);
    const sub = await prisma.task.findFirstOrThrow({
      where: { parentId },
    });
    const subId = sub.id;

    await prisma.task.update({
      where: { id: subId },
      data: { status: TaskStatus.RUNNING },
    });

    await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(409);
  });

  it('子任务标记为 LLM 来源时：执行先入 WAITING_APPROVAL，审批后完成', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const prisma = app.get(PrismaService);
    const sub = await prisma.task.findFirstOrThrow({
      where: { parentId },
      orderBy: { sortOrder: 'asc' },
    });
    const subId = sub.id;

    await prisma.task.update({
      where: { id: subId },
      data: {
        parameters: {
          source: 'llm',
          feature: 'login',
          parentName: 'build a web page',
        },
      },
    });

    const execRes = await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    expect(execRes.body.pausedForApproval).toBe(true);
    expect(execRes.body.task.status).toBe('WAITING_APPROVAL');

    const pending = await request(app.getHttpServer())
      .get('/task/pending-approval')
      .expect(200);

    expect(
      (pending.body as { id: string }[]).some((r) => r.id === subId),
    ).toBe(true);

    const stepsWait = getLogsForTask(subId).map((e) => e.step);
    expect(stepsWait).toContain('risk_evaluated');
    expect(stepsWait).toContain('approval_requested');

    const appr = await request(app.getHttpServer())
      .post(`/task/approve/${subId}`)
      .expect(200);

    expect(appr.body.task.status).toBe('COMPLETED');
    expect(redisStore.get(`task:${subId}`)).toBe('completed');

    const stepsDone = getLogsForTask(subId).map((e) => e.step);
    expect(stepsDone).toContain('approved');
    expect(stepsDone).toContain('completed');
  });

  it('POST /task/reject/:id：WAITING_APPROVAL → FAILED', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const prisma = app.get(PrismaService);
    const sub = await prisma.task.findFirstOrThrow({
      where: { parentId },
      orderBy: { sortOrder: 'asc' },
    });
    const subId = sub.id;

    await prisma.task.update({
      where: { id: subId },
      data: {
        parameters: { source: 'llm', feature: 'login' },
      },
    });

    await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    const rej = await request(app.getHttpServer())
      .post(`/task/reject/${subId}`)
      .expect(200);

    expect(rej.body.task.status).toBe('FAILED');
    expect(redisStore.get(`task:${subId}`)).toBe('failed');

    const steps = getLogsForTask(subId).map((e) => e.step);
    expect(steps).toContain('rejected');
  });

  it('POST /coordinator/run：须先 PLAN_APPROVED，顺序执行子任务并完成主任务', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: {
          features: ['login', 'dashboard'],
          outputDir: 'apps/frontend/src',
        },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;
    await generateAndApprovePlan(parentId);

    const runRes = await request(app.getHttpServer())
      .post(`/coordinator/run/${parentId}`)
      .expect(200);

    expect(runRes.body.executedTaskIds).toHaveLength(2);

    const prisma = app.get(PrismaService);
    const parent = await prisma.task.findUniqueOrThrow({
      where: { id: parentId },
    });
    expect(parent.status).toBe('COMPLETED');
    expect(redisStore.get(`task:${parentId}`)).toBe('completed');

    const children = await prisma.task.findMany({
      where: { parentId },
    });
    expect(children.every((c) => c.status === 'COMPLETED')).toBe(true);
  });

  afterEach(async () => {
    await app.close();
  });
});
