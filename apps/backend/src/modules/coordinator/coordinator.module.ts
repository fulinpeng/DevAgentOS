import { Module, forwardRef } from '@nestjs/common';
import { RoleModule } from '../role/role.module';
import { CoordinatorService } from './application/coordinator.service';
import { CoordinatorController } from './controller/coordinator.controller';
import { CoordinatorRepository } from './infrastructure/coordinator.repository';

@Module({
  imports: [forwardRef(() => RoleModule)],
  controllers: [CoordinatorController],
  providers: [CoordinatorService, CoordinatorRepository],
  exports: [CoordinatorService],
})
export class CoordinatorModule {}
