import { Module } from '@nestjs/common';

import { ClientsModule } from '../clients';
import { DatabaseModule } from '../database';
import { LabelsModule } from '../labels/labels.module';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  imports: [DatabaseModule, ClientsModule, LabelsModule],
  controllers: [ShippingController],
  providers: [ShippingService],
})
export class ShippingModule {}
