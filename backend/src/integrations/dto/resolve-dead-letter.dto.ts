import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

import { IntegrationDeadLetterStatus } from '../integration-enterprise.types';

export class ResolveDeadLetterDto {
  @ApiProperty({ enum: [IntegrationDeadLetterStatus.RESOLVED, IntegrationDeadLetterStatus.IGNORED] })
  @IsIn([IntegrationDeadLetterStatus.RESOLVED, IntegrationDeadLetterStatus.IGNORED])
  status!: 'RESOLVED' | 'IGNORED';

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
