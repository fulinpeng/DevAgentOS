import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisInfraModule } from './infrastructure/redis/redis.module';
import { CoordinatorModule } from './modules/coordinator/coordinator.module';
import { RoleModule } from './modules/role/role.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisInfraModule,
    WorkflowModule,
    RoleModule,
    CoordinatorModule,
  ],
})
export class AppModule {}
