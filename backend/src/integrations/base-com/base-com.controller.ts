import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

import { CurrentUser } from '../../access-control/decorators/current-user.decorator';
import { RequirePermissions } from '../../access-control/decorators/require-permissions.decorator';
import { RequireWarehousePermissions } from '../../access-control/decorators/require-warehouse-permissions.decorator';
import { AuthenticatedUser } from '../../access-control/types';
import { BaseComService } from './base-com.service';

class BaseComOrderDto {
  @ApiProperty({ example: 1042, minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  orderId!: number;
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('warehouses/:warehouseId/integrations/base-com')
export class BaseComController {
  constructor(private readonly connector: BaseComService) {}

  @Get()
  @RequirePermissions('integration.manage')
  @RequireWarehousePermissions('outbound.manage')
  @ApiOperation({ summary: 'Check whether the Base.com connector and dispatch status are configured' })
  status() {
    return this.connector.status();
  }

  @Post('orders/import')
  @HttpCode(200)
  @RequirePermissions('integration.manage')
  @RequireWarehousePermissions('outbound.manage')
  @ApiOperation({ summary: 'Import a confirmed Base.com order by ID into the selected warehouse' })
  importOrder(
    @Param('warehouseId') warehouseId: string,
    @Body() dto: BaseComOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.connector.importOrder(warehouseId, dto.orderId, actor);
  }

  @Post('orders/sync-dispatch')
  @HttpCode(200)
  @RequirePermissions('integration.manage')
  @RequireWarehousePermissions('outbound.manage')
  @ApiOperation({ summary: 'Send the configured status to Base.com for an imported order shipped in WMS' })
  syncDispatch(
    @Param('warehouseId') warehouseId: string,
    @Body() dto: BaseComOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.connector.syncDispatch(warehouseId, dto.orderId, actor);
  }
}
