import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class PrintShipmentLabelDto {
  @ApiProperty({ example: 'PACK-01' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  printerCode!: string;

  @ApiPropertyOptional({ example: 'shipment-label-print-1' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  idempotencyKey?: string;
}
