import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { OutboundModule } from '../outbound';
import { BaseComClient } from './base-com/base-com.client';
import { BaseComController } from './base-com/base-com.controller';
import { BaseComService } from './base-com/base-com.service';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { IntegrationEnterpriseController } from './integration-enterprise.controller';
import { IntegrationEnterpriseService } from './integration-enterprise.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [DatabaseModule, OutboundModule],
  controllers: [IntegrationsController, IntegrationEnterpriseController, BaseComController],
  providers: [IntegrationsService, IntegrationDispatchService, IntegrationEnterpriseService, BaseComClient, BaseComService],
  exports: [IntegrationsService, IntegrationDispatchService, IntegrationEnterpriseService],
})
export class IntegrationsModule {}
