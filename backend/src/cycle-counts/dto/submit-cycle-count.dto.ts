import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

import { MAX_COUNT_QUANTITY } from '../cycle-counts.helpers';

export class SubmitCycleCountDto {
  @ApiProperty({ example: 47, minimum: 0, maximum: MAX_COUNT_QUANTITY })
  @Transform(({ value }) => typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value)
  @IsInt()
  @Min(0)
  @Max(MAX_COUNT_QUANTITY)
  countedQuantity!: number;

  @ApiPropertyOptional({ example: { scannerSessionId: '...' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
