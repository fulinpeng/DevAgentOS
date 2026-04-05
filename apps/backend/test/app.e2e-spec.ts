import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
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
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const prisma = app.get(PrismaService);
    await prisma.task.deleteMany();
  });

  it('POST /task/create：库表 3 条、父子关系、Redis pending', async () => {
    const res = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: { features: ['login', 'dashboard'] },
      })
      .expect(201);

    const { parentTask, subTasks } = res.body;
    const prisma = app.get(PrismaService);
    const tasks = await prisma.task.findMany();

    expect(tasks).toHaveLength(3);

    const parent = tasks.find((t) => t.parentId === null);
    expect(parent).toBeDefined();
    expect(parent!.name).toBe('build a web page');
    expect(parent!.role).toBeNull();

    const children = tasks.filter((t) => t.parentId === parent!.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual([
      'build dashboard',
      'build login',
    ]);
    children.forEach((c) => {
      expect(c.role).toBe('frontend');
      expect(c.parentId).toBe(parent!.id);
    });

    expect(subTasks[0].name).toBe('build login');
    expect(subTasks[1].name).toBe('build dashboard');

    expect(redisStore.get(`task:${parentTask.id}`)).toBe('pending');
    expect(redisStore.get(`task:${subTasks[0].id}`)).toBe('pending');
    expect(redisStore.get(`task:${subTasks[1].id}`)).toBe('pending');
  });

  it('POST /role/execute：状态与 Redis，执行日志包含关键 step', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: { features: ['login', 'dashboard'] },
      })
      .expect(201);

    const subId = createRes.body.subTasks[0].id as string;

    const execRes = await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(200);

    expect(execRes.body.workerResult).toEqual({
      success: true,
      result: {},
    });
    expect(execRes.body.task.status).toBe('COMPLETED');
    expect(redisStore.get(`task:${subId}`)).toBe('completed');

    const steps = getLogsForTask(subId).map((e) => e.step);
    expect(steps).toContain('role_execution_start');
    expect(steps).toContain('worker_called');
    expect(steps).toContain('completed');
  });

  it('COMPLETED 再次执行 → 200 幂等', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'x',
        parameters: { features: ['a'] },
      })
      .expect(201);

    const subId = createRes.body.subTasks[0].id as string;
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
        parameters: { features: ['a'] },
      })
      .expect(201);

    const subId = createRes.body.subTasks[0].id as string;
    const prisma = app.get(PrismaService);
    await prisma.task.update({
      where: { id: subId },
      data: { status: TaskStatus.RUNNING },
    });

    await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(409);
  });

  it('POST /coordinator/run/:parentId 顺序执行子任务并完成主任务', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: { features: ['login', 'dashboard'] },
      })
      .expect(201);

    const parentId = createRes.body.parentTask.id as string;

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
