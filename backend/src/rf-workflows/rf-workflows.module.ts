import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { PutawayModule } from '../putaway/putaway.module';
import { RfWorkflowsController } from './rf-workflows.controller';
import { RfWorkflowsService } from './rf-workflows.service';

@Module({
  imports: [DatabaseModule, PutawayModule],
  controllers: [RfWorkflowsController],
  providers: [RfWorkflowsService],
})
export class RfWorkflowsModule {}
