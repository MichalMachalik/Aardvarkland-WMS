import { Module } from '@nestjs/common';

import { ClientsModule } from '../clients';
import { DatabaseModule } from '../database';
import { InventoryModule } from '../inventory/inventory.module';
import { WarehouseTasksController } from './warehouse-tasks.controller';
import { WarehouseTasksService } from './warehouse-tasks.service';

@Module({
  imports: [DatabaseModule, ClientsModule, InventoryModule],
  controllers: [WarehouseTasksController],
  providers: [WarehouseTasksService],
})
export class WarehouseTasksModule {}
