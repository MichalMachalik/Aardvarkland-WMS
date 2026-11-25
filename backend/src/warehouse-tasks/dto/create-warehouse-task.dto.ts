import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { WarehouseTaskStatus, WarehouseTaskType } from '../warehouse-tasks.types';

export class CreateWarehouseTaskDto {
  @ApiProperty({ enum: WarehouseTaskType, example: WarehouseTaskType.PICK })
  @IsEnum(WarehouseTaskType)
  type!: WarehouseTaskType;

  @ApiPropertyOptional({ enum: WarehouseTaskStatus, example: WarehouseTaskStatus.OPEN })
  @IsOptional()
  @IsEnum(WarehouseTaskStatus)
  status?: WarehouseTaskStatus;

  @ApiPropertyOptional({ example: 'operator@example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  assignedUserReference?: string;

  @ApiPropertyOptional({ example: 'A-01-01' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  fromLocationReference?: string;

  @ApiPropertyOptional({ example: 'PACK-01' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  toLocationReference?: string;

  @ApiPropertyOptional({ example: 'SKU-100001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @ApiPropertyOptional({ example: 12, minimum: 0, maximum: 2_147_483_647, description: 'Zero is valid for count tasks.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quantity?: number;

  @ApiPropertyOptional({ example: 'HU-100001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  handlingUnitReference?: string;

  @ApiPropertyOptional({ example: { priority: 'normal' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
