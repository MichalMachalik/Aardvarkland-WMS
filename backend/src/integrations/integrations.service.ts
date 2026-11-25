import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuthenticatedUser } from '../access-control/types';
import { lockPostgresRowById, PrismaService, withTransactionRetry } from '../database';
import { Prisma } from '../generated/prisma/client';
import { CreateIntegrationEndpointDto } from './dto/create-integration-endpoint.dto';
import { UpdateIntegrationEndpointDto } from './dto/update-integration-endpoint.dto';
import { maskIntegrationConfig, restoreMaskedIntegrationConfig } from './integration-config.helpers';
import { IntegrationEndpointResponse, IntegrationStatus } from './integrations.types';

interface IntegrationEndpointRecord {
  id: string;
  code: string;
  name: string;
  type: string;
  baseUrl: string;
  authType: string;
  status: IntegrationStatus;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
}

type IntegrationEndpointWhereInput = {
  id?: string;
  code?: string;
  OR?: Array<{ id?: string; code?: string }>;
};

type IntegrationEndpointJsonInput = Prisma.InputJsonValue | typeof Prisma.DbNull;

interface IntegrationEndpointUpdateInput {
  code?: string;
  name?: string;
  type?: string;
  baseUrl?: string;
  authType?: string;
  status?: IntegrationStatus;
  config?: IntegrationEndpointJsonInput;
}

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(): Promise<IntegrationEndpointResponse[]> {
    const endpoints = await this.prisma.integrationEndpoint.findMany({
      orderBy: { code: 'asc' },
    });

    return endpoints.map(toIntegrationEndpointResponse);
  }

  async create(
    dto: CreateIntegrationEndpointDto,
    actor: AuthenticatedUser,
  ): Promise<IntegrationEndpointResponse> {
    try {
      const endpoint = await withTransactionRetry(() => this.prisma.$transaction(async tx => {
        const config = restoreMaskedIntegrationConfig(dto.config, null);
        const saved = await tx.integrationEndpoint.create({
          data: {
            code: normalizeRequiredLabel(dto.code, 'Code').toUpperCase(),
            name: normalizeRequiredLabel(dto.name, 'Name'),
            type: normalizeRequiredLabel(dto.type, 'Type').toUpperCase(),
            baseUrl: dto.baseUrl.trim(),
            authType: normalizeRequiredLabel(dto.authType ?? 'NONE', 'Authentication type', 1).toUpperCase(),
            status: dto.status ?? 'INACTIVE',
            ...(config === undefined ? {} : { config: toJsonInput(config) }),
          },
        });
        await this.writeIntegrationAudit(tx, actor, 'integration_endpoint.created', saved);
        return saved;
      }));

      return toIntegrationEndpointResponse(endpoint);
    } catch (error: unknown) {
      if (hasPrismaCode(error, 'P2002')) {
        throw new ConflictException('Integration endpoint code already exists');
      }

      throw error;
    }
  }

  async update(
    endpointReference: string,
    dto: UpdateIntegrationEndpointDto,
    actor: AuthenticatedUser,
  ): Promise<IntegrationEndpointResponse> {
    try {
      const endpoint = await withTransactionRetry(() => this.prisma.$transaction(async tx => {
        const candidate = await tx.integrationEndpoint.findFirst({
          where: endpointReferenceWhere(endpointReference),
          select: { id: true },
        });
        if (!candidate) throw new NotFoundException('Integration endpoint was not found');
        await lockPostgresRowById(tx, 'integration_endpoints', candidate.id);
        const existing = await tx.integrationEndpoint.findUnique({ where: { id: candidate.id } });
        if (!existing) throw new NotFoundException('Integration endpoint was not found');
        const data = toUpdateInput(dto, existing);
        if (!Object.keys(data).length) {
          throw new BadRequestException('No integration endpoint changes were provided');
        }
        const saved = await tx.integrationEndpoint.update({ where: { id: existing.id }, data });
        await this.writeIntegrationAudit(tx, actor, 'integration_endpoint.updated', saved);
        return saved;
      }));

      return toIntegrationEndpointResponse(endpoint);
    } catch (error: unknown) {
      if (hasPrismaCode(error, 'P2002')) {
        throw new ConflictException('Integration endpoint code already exists');
      }

      throw error;
    }
  }

  private async writeIntegrationAudit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    action: string,
    endpoint: IntegrationEndpointRecord,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorUserId: actor.id,
        warehouseId: null,
        action,
        resourceType: 'integration_endpoint',
        resourceId: endpoint.id,
        metadata: {
          code: endpoint.code,
          type: endpoint.type,
          status: endpoint.status,
        },
      },
    });
  }
}

function toUpdateInput(dto: UpdateIntegrationEndpointDto, existing: IntegrationEndpointRecord): IntegrationEndpointUpdateInput {
  const baseUrl = dto.baseUrl?.trim();
  const sameOrigin = !baseUrl || new URL(baseUrl).origin === URL.parse(existing.baseUrl)?.origin;
  return {
    ...(dto.code == null ? {} : { code: normalizeRequiredLabel(dto.code, 'Code').toUpperCase() }),
    ...(dto.name == null ? {} : { name: normalizeRequiredLabel(dto.name, 'Name') }),
    ...(dto.type == null ? {} : { type: normalizeRequiredLabel(dto.type, 'Type').toUpperCase() }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(dto.authType == null ? {} : { authType: normalizeRequiredLabel(dto.authType, 'Authentication type', 1).toUpperCase() }),
    ...(dto.status == null ? {} : { status: dto.status }),
    ...(dto.config === undefined ? {} : { config: toJsonInput(restoreMaskedIntegrationConfig(dto.config, sameOrigin ? existing.config : null)) }),
  };
}

function toIntegrationEndpointResponse(
  endpoint: IntegrationEndpointRecord,
): IntegrationEndpointResponse {
  return {
    id: endpoint.id,
    code: endpoint.code,
    name: endpoint.name,
    type: endpoint.type,
    baseUrl: endpoint.baseUrl,
    authType: endpoint.authType,
    status: endpoint.status,
    config: maskIntegrationConfig(endpoint.config),
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

function endpointReferenceWhere(endpointReference: string): IntegrationEndpointWhereInput {
  if (isUuid(endpointReference)) {
    return {
      OR: [{ id: endpointReference }, { code: normalizeCode(endpointReference) }],
    };
  }

  return { code: normalizeCode(endpointReference) };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeRequiredLabel(value: string, field: string, minLength = 2): string {
  const trimmed = value.trim();
  if (trimmed.length < minLength) throw new BadRequestException(`${field} is too short`);
  return trimmed;
}

function toJsonInput(
  value: unknown,
): IntegrationEndpointJsonInput | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return Prisma.DbNull;
  }

  return value as Prisma.InputJsonValue;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
