import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TaskRedis } from './../src/infrastructure/redis/task.redis';
import { PrismaService } from './../src/prisma/prisma.service';

describe('Workflow + Role (e2e)', () => {
  let app: INestApplication<App>;
  const redisStore = new Map<string, string>();

  beforeEach(async () => {
    redisStore.clear();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TaskRedis)
      .useValue({
        setTaskStatus: async (id: string, status: string) => {
          redisStore.set(`task:${id}`, status);
        },
        getTaskStatus: async (id: string) =>
          redisStore.get(`task:${id}`) ?? null,
        onModuleDestroy: async () => {},
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

  it('POST /role/execute/:taskId：pending→running→completed，Redis 同步，Worker 返回', async () => {
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

    const prisma = app.get(PrismaService);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: subId } });
    expect(row.status).toBe('COMPLETED');

    expect(redisStore.get(`task:${subId}`)).toBe('completed');
  });

  it('非 PENDING 任务执行应 400', async () => {
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

    await request(app.getHttpServer())
      .post(`/role/execute/${subId}`)
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
