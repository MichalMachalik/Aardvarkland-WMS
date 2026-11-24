import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ResolveExternalIdMappingDto {
  @ApiProperty()
  @IsString()
  @Matches(/\S/)
  externalSystemReference!: string;

  @ApiProperty()
  @IsString()
  @Matches(/\S/)
  resourceType!: string;

  @ApiProperty()
  @IsString()
  @Matches(/\S/)
  externalId!: string;
}
