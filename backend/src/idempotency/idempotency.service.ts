import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import {
  evaluateIdempotencyRecord,
  normalizeIdempotencyKey,
  NormalizedIdempotencyKey,
} from './idempotency.helpers';
import {
  IdempotencyCheckResponse,
  IdempotencyCheckStatus,
  IdempotencyRecordResponse,
  IdempotencyRecordStatus,
  IdempotencyRequestInput,
  StoreIdempotencyRecordInput,
} from './idempotency.types';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async check(input: IdempotencyRequestInput): Promise<IdempotencyCheckResponse> {
    const key = normalizeIdempotencyKey(input);
    const existing = await this.findExisting(key);
    const evaluation = evaluateIdempotencyRecord(existing, key.requestHash);

    return {
      status: evaluation.status,
      record: existing ? toIdempotencyRecordResponse(existing) : null,
      ...(evaluation.status === IdempotencyCheckStatus.REPLAY
        ? { responseBody: evaluation.responseBody }
        : {}),
    };
  }

  async store(input: StoreIdempotencyRecordInput): Promise<IdempotencyRecordResponse> {
    const key = normalizeIdempotencyKey(input);
    const status = input.status ?? (input.responseBody === undefined
      ? IdempotencyRecordStatus.IN_PROGRESS : IdempotencyRecordStatus.COMPLETED);
    const existing = await this.findExisting(key);

    if (existing) {
      return this.storeExistingRecord(existing, key, input, status);
    }

    try {
      const record = await this.client.idempotencyRecord.create({
        data: {
          sourceSystem: key.sourceSystem,
          externalId: key.externalId,
          idempotencyKey: key.idempotencyKey,
          requestHash: key.requestHash,
          responseBody: input.responseBody ?? null,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          status,
        },
      });

      return toIdempotencyRecordResponse(record);
    } catch (error: unknown) {
      if (!hasPrismaCode(error, 'P2002')) {
        throw error;
      }

      const duplicate = await this.findExisting(key);

      if (!duplicate) {
        throw error;
      }

      return this.storeExistingRecord(duplicate, key, input, status);
    }
  }

  private get client(): IdempotencyPrismaClient {
    return this.prisma as unknown as IdempotencyPrismaClient;
  }

  private async findExisting(key: NormalizedIdempotencyKey): Promise<IdempotencyRecord | null> {
    return this.client.idempotencyRecord.findFirst({
      where: {
        sourceSystem: key.sourceSystem,
        idempotencyKey: key.idempotencyKey,
      },
    });
  }

  private async storeExistingRecord(
    record: IdempotencyRecord,
    key: NormalizedIdempotencyKey,
    input: StoreIdempotencyRecordInput,
    status: IdempotencyRecordStatus,
  ): Promise<IdempotencyRecordResponse> {
    if (record.requestHash !== key.requestHash) {
      throw new ConflictException('Idempotency key was reused with a different request hash');
    }
    if (record.status === IdempotencyRecordStatus.COMPLETED || record.status === status) {
      return toIdempotencyRecordResponse(record);
    }
    if (record.status === IdempotencyRecordStatus.FAILED) {
      throw new ConflictException('The idempotency request already failed');
    }
    await this.client.idempotencyRecord.updateMany({
      where: { id: record.id, status: IdempotencyRecordStatus.IN_PROGRESS, requestHash: key.requestHash },
      data: {
        status,
        ...(input.responseBody === undefined ? {} : { responseBody: input.responseBody }),
        ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
        ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      },
    });
    const updated = await this.findExisting(key);
    if (!updated || updated.id !== record.id || updated.requestHash !== key.requestHash) {
      throw new ConflictException('The idempotency record changed during completion');
    }
    if (updated.status !== status && updated.status !== IdempotencyRecordStatus.COMPLETED) {
      throw new ConflictException('The idempotency request already failed');
    }
    return toIdempotencyRecordResponse(updated);
  }
}

function toIdempotencyRecordResponse(record: IdempotencyRecord): IdempotencyRecordResponse {
  return {
    id: record.id,
    sourceSystem: record.sourceSystem,
    externalId: record.externalId,
    idempotencyKey: record.idempotencyKey,
    requestHash: record.requestHash,
    responseBody: record.responseBody,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

interface IdempotencyPrismaClient {
  idempotencyRecord: IdempotencyRecordDelegate;
}

interface IdempotencyRecordDelegate {
  findFirst(args: { where: IdempotencyRecordWhereInput }): Promise<IdempotencyRecord | null>;
  create(args: { data: IdempotencyRecordCreateInput }): Promise<IdempotencyRecord>;
  updateMany(args: {
    where: { id: string; status: IdempotencyRecordStatus; requestHash: string };
    data: Partial<Pick<IdempotencyRecordCreateInput, 'status' | 'responseBody' | 'resourceType' | 'resourceId'>>;
  }): Promise<{ count: number }>;
}

interface IdempotencyRecordWhereInput {
  sourceSystem: string;
  idempotencyKey: string;
  externalId?: string | null;
}

interface IdempotencyRecordCreateInput {
  sourceSystem: string;
  externalId: string | null;
  idempotencyKey: string;
  requestHash: string;
  responseBody: unknown;
  resourceType: string | null;
  resourceId: string | null;
  status: IdempotencyRecordStatus;
}

interface IdempotencyRecord {
  id: string;
  sourceSystem: string;
  externalId: string | null;
  idempotencyKey: string;
  requestHash: string;
  responseBody: unknown;
  resourceType: string | null;
  resourceId: string | null;
  status: IdempotencyRecordStatus;
  createdAt: Date;
  updatedAt: Date;
}
