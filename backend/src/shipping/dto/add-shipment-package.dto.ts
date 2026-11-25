import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const maxPackageNumber = 2_147_483_647;

function readWholeNumber({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
}

export class PackageContentInputDto {
  @ApiPropertyOptional({ example: 'line-id' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  outboundOrderLineReference?: string;

  @ApiPropertyOptional({ example: 'ABC-123' })
  @IsString()
  @MaxLength(120)
  sku!: string;

  @ApiPropertyOptional({ example: 2, minimum: 1, maximum: maxPackageNumber })
  @Transform(readWholeNumber)
  @IsInt()
  @Min(1)
  @Max(maxPackageNumber)
  quantity!: number;

  @ApiPropertyOptional({ example: { serials: [] } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class AddShipmentPackageDto {
  @ApiPropertyOptional({ example: 'SHP-100001-PKG-001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  packageCode?: string;

  @ApiPropertyOptional({ example: 'CARTON' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  packageType?: string;

  @ApiPropertyOptional({ example: 1200, minimum: 0, maximum: maxPackageNumber })
  @IsOptional()
  @Transform(readWholeNumber)
  @IsInt()
  @Min(0)
  @Max(maxPackageNumber)
  weightGrams?: number;

  @ApiPropertyOptional({ example: 40, minimum: 0, maximum: maxPackageNumber })
  @IsOptional()
  @Transform(readWholeNumber)
  @IsInt()
  @Min(0)
  @Max(maxPackageNumber)
  lengthCm?: number;

  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: maxPackageNumber })
  @IsOptional()
  @Transform(readWholeNumber)
  @IsInt()
  @Min(0)
  @Max(maxPackageNumber)
  widthCm?: number;

  @ApiPropertyOptional({ example: 20, minimum: 0, maximum: maxPackageNumber })
  @IsOptional()
  @Transform(readWholeNumber)
  @IsInt()
  @Min(0)
  @Max(maxPackageNumber)
  heightCm?: number;

  @ApiPropertyOptional({ type: [PackageContentInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PackageContentInputDto)
  contents?: PackageContentInputDto[];


  @ApiPropertyOptional({ description: '3PL owner client code/id. When set, created resources are owned by this client.', example: 'CLIENT_A' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerClientReference?: string;

  @ApiPropertyOptional({ example: { stationScaleWeight: 1200 } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'storage-package-shipment-1716200000000' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  idempotencyKey?: string;
}
