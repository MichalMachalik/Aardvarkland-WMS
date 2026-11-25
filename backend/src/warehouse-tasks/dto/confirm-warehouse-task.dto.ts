import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ConfirmWarehouseTaskDto {
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

  @ApiPropertyOptional({
    type: [String],
    description: 'Serial codes for a MOVE task that transfers only part of a stock quant.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  serialNumbers?: string[];

  @ApiPropertyOptional({ example: 'HU-100001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  handlingUnitReference?: string;

  @ApiPropertyOptional({ example: { source: 'scanner' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'storage-confirm-task-1716200000000' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  idempotencyKey?: string;
}
