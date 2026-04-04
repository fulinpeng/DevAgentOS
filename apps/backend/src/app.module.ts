import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WorkflowModule,
  ],
})
export class AppModule {}
