import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TaskRedis } from './../src/modules/workflow/infrastructure/task.redis';

describe('Workflow (e2e)', () => {
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
  });

  it('POST /task/create splits features and sets Redis pending', () => {
    return request(app.getHttpServer())
      .post('/task/create')
      .send({
        name: 'build a web page',
        parameters: { features: ['login', 'dashboard'] },
      })
      .expect(201)
      .expect((res) => {
        const { parentTask, subTasks } = res.body;
        expect(parentTask.name).toBe('build a web page');
        expect(parentTask.role).toBeNull();
        expect(parentTask.parentId).toBeNull();
        expect(subTasks).toHaveLength(2);
        expect(subTasks[0]).toMatchObject({
          name: 'build login',
          role: 'frontend',
          parentId: parentTask.id,
        });
        expect(subTasks[1]).toMatchObject({
          name: 'build dashboard',
          role: 'frontend',
          parentId: parentTask.id,
        });
        expect(redisStore.get(`task:${parentTask.id}`)).toBe('pending');
        expect(redisStore.get(`task:${subTasks[0].id}`)).toBe('pending');
        expect(redisStore.get(`task:${subTasks[1].id}`)).toBe('pending');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
