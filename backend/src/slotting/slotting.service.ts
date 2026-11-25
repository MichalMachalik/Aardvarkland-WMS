import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthenticatedUser } from '../access-control/types';
import { normalizeOffsetPagination } from '../common';
import { PrismaService, withTransactionRetry } from '../database';
import { lockPostgresAdvisoryTransaction, lockPostgresRowById } from '../database/transaction-locks';
import { Prisma, WarehouseLocationType } from '../generated/prisma/client';
import { CreateSlottingRuleDto } from './dto/create-slotting-rule.dto';
import { EvaluateSlottingDto } from './dto/evaluate-slotting.dto';
import { ListSlottingRecommendationsQueryDto } from './dto/list-slotting-recommendations-query.dto';
import { ListSlottingVelocitiesQueryDto } from './dto/list-slotting-velocities-query.dto';
import { UpsertSkuVelocityDto } from './dto/upsert-sku-velocity.dto';
import {
  buildSlottingRecommendations,
  calculateVelocityScore,
  canMutateSlottingRecommendation,
  classifyVelocity,
  clampSlottingLimit,
  normalizeSlottingCode,
  SlottingLocationCandidate,
  SlottingRecommendationDraft,
  SlottingStockCandidate,
  SlottingVelocityCandidate,
  summarizeSlottingCandidates,
} from './slotting.helpers';
import {
  SlottingEvaluationResponse,
  SlottingRecommendationResponse,
  SlottingRecommendationStatus,
  SlottingRuleResponse,
  SlottingRuleStatus,
  SkuVelocityResponse,
} from './slotting.types';

@Injectable()
export class SlottingService {
  constructor(private readonly prisma: PrismaService) {}

  async listRules(warehouseReference: string): Promise<SlottingRuleResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const rules = await this.client.slottingRule.findMany({
      where: { warehouseId: warehouse.id },
      orderBy: [{ status: 'asc' }, { code: 'asc' }],
    });
    return rules.map(toRuleResponse);
  }

  async createRule(
    warehouseReference: string,
    dto: CreateSlottingRuleDto,
    actor: AuthenticatedUser,
  ): Promise<SlottingRuleResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    if (
      dto.minVelocityScore !== undefined &&
      dto.maxVelocityScore !== undefined &&
      dto.minVelocityScore > dto.maxVelocityScore
    ) {
      throw new ConflictException('minVelocityScore cannot be greater than maxVelocityScore.');
    }

    const code = normalizeSlottingCode(dto.code ?? `SLOTTING-${randomUUID()}`);
    if (!code) throw new BadRequestException('Slotting rule code must not be blank.');
    const rawType = normalizeNullableCode(dto.targetLocationType);
    const targetLocationType = rawType === 'PICK' ? WarehouseLocationType.PICKING : rawType;
    if (targetLocationType && !Object.values(WarehouseLocationType).some(type => type === targetLocationType)) {
      throw new BadRequestException('Invalid target location type.');
    }
    try {
      return await this.transaction(async tx => {
        const rule = await tx.slottingRule.create({
          data: {
            warehouseId: warehouse.id,
            code,
            status: SlottingRuleStatus.ACTIVE,
            zone: normalizeNullableCode(dto.zone),
            minVelocityScore: dto.minVelocityScore ?? null,
            maxVelocityScore: dto.maxVelocityScore ?? null,
            targetLocationType,
            maxPickSequence: dto.maxPickSequence ?? null,
            minPickFaceQuantity: dto.minPickFaceQuantity ?? null,
            metadata: dto.metadata ?? undefined,
          },
        });
        await this.writeAudit(tx, actor.id, warehouse.id, 'slotting.rule_created', 'slotting_rule', rule.id, {
          code: rule.code, zone: rule.zone,
        });
        await this.writeOutbox(tx, 'SLOTTING_RULE_CREATED', 'slotting_rule', rule.id, {
          warehouseId: warehouse.id, code: rule.code,
        });
        return toRuleResponse(rule);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A slotting rule with this code already exists in the warehouse.');
      }
      throw error;
    }
  }

  async listVelocities(
    warehouseReference: string,
    query: ListSlottingVelocitiesQueryDto = {},
  ): Promise<SkuVelocityResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const pagination = normalizeOffsetPagination(query, { defaultTake: 100, maxTake: 200 });
    const velocities = await this.client.skuVelocity.findMany({
      where: compactRecord({
        warehouseId: warehouse.id,
        abcClass: query.abcClass ? normalizeCode(query.abcClass) : undefined,
        skuCode: query.sku
          ? { contains: normalizeCode(query.sku), mode: 'insensitive' }
          : undefined,
      }),
      orderBy: [{ velocityScore: 'desc' }, { skuCode: 'asc' }],
      take: pagination.take,
      skip: pagination.skip,
    });
    return velocities.map(toVelocityResponse);
  }

  async upsertVelocity(
    warehouseReference: string,
    dto: UpsertSkuVelocityDto,
    actor: AuthenticatedUser,
  ): Promise<SkuVelocityResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const sku = await this.resolveSku(dto.sku);
    return this.transaction(async tx => {
      const key = { warehouseId: warehouse.id, skuCode: sku.code };
      await lockPostgresAdvisoryTransaction(tx, 'slotting_velocity', JSON.stringify([warehouse.id, sku.code]));
      const current = await tx.skuVelocity.findFirst({ where: key });
      const counters = {
        picksLast30Days: dto.picksLast30Days ?? current?.picksLast30Days ?? 0,
        unitsPickedLast30Days: dto.unitsPickedLast30Days ?? current?.unitsPickedLast30Days ?? 0,
        replenishmentsLast30Days: dto.replenishmentsLast30Days ?? current?.replenishmentsLast30Days ?? 0,
      };
      const recalculate = dto.picksLast30Days != null || dto.unitsPickedLast30Days != null || dto.replenishmentsLast30Days != null;
      const velocityScore = dto.velocityScore ?? (recalculate || !current ? calculateVelocityScore(counters) : current.velocityScore);
      const abcClass = classifyVelocity(velocityScore);
      const data = { skuId: sku.id, ...counters, velocityScore, abcClass, metadata: dto.metadata ?? undefined, lastCalculatedAt: new Date() };
      const velocity = await tx.skuVelocity.upsert({
        where: { warehouseId_skuCode: key },
        create: { ...key, ...data },
        update: data,
      });
      await this.writeAudit(tx, actor.id, warehouse.id, 'slotting.velocity_upserted', 'sku_velocity', velocity.id, {
        skuCode: sku.code, velocityScore, abcClass,
      });
      await this.writeOutbox(tx, 'SKU_VELOCITY_UPDATED', 'sku_velocity', velocity.id, {
        warehouseId: warehouse.id, skuCode: sku.code, velocityScore, abcClass,
      });
      return toVelocityResponse(velocity);
    });
  }

  async evaluate(
    warehouseReference: string,
    dto: EvaluateSlottingDto,
    actor: AuthenticatedUser,
  ): Promise<SlottingEvaluationResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const dryRun = dto.dryRun ?? false;
    const minVelocityScore = dto.minVelocityScore ?? 60;
    const lowVelocityScore = dto.lowVelocityScore ?? 20;
    if (lowVelocityScore >= minVelocityScore) {
      throw new BadRequestException('Low velocity threshold must be below the high velocity threshold.');
    }
    return this.transaction(async tx => {
      if (!dryRun) await lockPostgresAdvisoryTransaction(tx, 'slotting_evaluation', warehouse.id);
      const [rules, velocities, stock, locations, existing] = await Promise.all([
        tx.slottingRule.findMany({
          where: { warehouseId: warehouse.id, status: SlottingRuleStatus.ACTIVE },
          orderBy: [{ code: 'asc' }],
        }),
        tx.skuVelocity.findMany({
          where: { warehouseId: warehouse.id },
          orderBy: [{ velocityScore: 'desc' }, { skuCode: 'asc' }],
        }),
        tx.stockQuant.findMany({
          where: { warehouseId: warehouse.id, status: 'AVAILABLE', handlingUnitId: null, location: { isActive: true } },
          include: { sku: true, location: true },
        }),
        tx.warehouseLocation.findMany({
          where: { warehouseId: warehouse.id, isActive: true },
          orderBy: [{ pickSequence: 'asc' }, { code: 'asc' }],
        }),
        tx.slottingRecommendation.findMany({
          where: { warehouseId: warehouse.id, status: { in: ['OPEN', 'APPLIED'] } },
        }),
      ]);
      const activeTasks = await tx.warehouseTask.findMany({
        where: {
          warehouseId: warehouse.id,
          id: { in: existing.flatMap(row => {
            const taskId = toRecord(row.metadata)['moveTaskId'];
            return row.status === SlottingRecommendationStatus.APPLIED && typeof taskId === 'string' && isUuid(taskId) ? [taskId] : [];
          }) },
          status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] },
        },
        select: { id: true },
      });
      const activeTaskIds = new Set(activeTasks.map(task => task.id));
      const existingKeys = new Set(existing.filter(row => {
        const taskId = toRecord(row.metadata)['moveTaskId'];
        return row.status === SlottingRecommendationStatus.OPEN || (typeof taskId === 'string' && activeTaskIds.has(taskId));
      }).map(recommendationKey));
      const input = {
        velocities: velocities.map(toVelocityCandidate),
        stock: stock.map(toStockCandidate),
        locations: locations.map(toLocationCandidate),
        rules,
        maxRecommendations: clampSlottingLimit(dto.maxRecommendations, 100),
        minVelocityScore,
        lowVelocityScore,
      };
      const drafts = buildSlottingRecommendations(input);
      const freshDrafts = drafts.filter(draft => !existingKeys.has(recommendationKey(draft)));
      const recommendationsSkipped = drafts.length - freshDrafts.length;
      const created: SlottingRecommendationRecord[] = [];

      if (!dryRun && freshDrafts.length > 0) {
        for (const draft of freshDrafts) {
          const recommendation = await tx.slottingRecommendation.create({
            data: { ...draft, warehouseId: warehouse.id, status: SlottingRecommendationStatus.OPEN },
          });
          created.push(recommendation);
        }
        await this.writeAudit(tx, actor.id, warehouse.id, 'slotting.evaluated', 'warehouse', warehouse.id, {
          recommendationsCreated: created.length, recommendationsSkipped,
        });
        await this.writeOutbox(tx, 'SLOTTING_EVALUATED', 'warehouse', warehouse.id, {
          warehouseId: warehouse.id, recommendationsCreated: created.length,
        });
      }
      return {
        warehouseId: warehouse.id,
        generatedAt: new Date().toISOString(),
        dryRun,
        recommendationsCreated: created.length,
        recommendationsSkipped,
        recommendations: dryRun ? freshDrafts.map(draft => toDraftResponse(warehouse.id, draft)) : created.map(toRecommendationResponse),
        summary: summarizeSlottingCandidates(input),
      };
    });
  }

  async listRecommendations(
    warehouseReference: string,
    query: ListSlottingRecommendationsQueryDto = {},
  ): Promise<SlottingRecommendationResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const pagination = normalizeOffsetPagination(query, { defaultTake: 100, maxTake: 200 });
    const recommendations = await this.client.slottingRecommendation.findMany({
      where: compactRecord({
        warehouseId: warehouse.id,
        status: query.status ? normalizeCode(query.status) : undefined,
        reason: query.reason ? normalizeCode(query.reason) : undefined,
        skuCode: query.sku
          ? { contains: normalizeCode(query.sku), mode: 'insensitive' }
          : undefined,
      }),
      orderBy: [
        { status: 'asc' },
        { priority: 'asc' },
        { velocityScore: 'desc' },
        { createdAt: 'desc' },
      ],
      take: pagination.take,
      skip: pagination.skip,
    });
    return recommendations.map(toRecommendationResponse);
  }

  async applyRecommendation(
    warehouseReference: string,
    recommendationReference: string,
    actor: AuthenticatedUser,
  ): Promise<SlottingRecommendationResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    return this.transaction(async (tx) => {
      await lockPostgresAdvisoryTransaction(tx, 'slotting_evaluation', warehouse.id);
      const recommendation = await this.lockRecommendation(tx, warehouse.id, recommendationReference);
      if (!canMutateSlottingRecommendation(recommendation.status)) {
        throw new ConflictException(
          `Slotting recommendation cannot be applied from status ${recommendation.status}.`,
        );
      }

      const { skuId, fromLocationId, toLocationId } = recommendation;
      if (!skuId || !fromLocationId || !toLocationId || fromLocationId === toLocationId) {
        throw new ConflictException('A slotting move requires a SKU and different source and destination locations.');
      }
      const destination = await tx.warehouseLocation.findFirst({ where: { warehouseId: warehouse.id, id: toLocationId } });
      if (!destination?.isActive) throw new ConflictException('The slotting destination is no longer active.');
      const { plannedQuantity, sourceQuantId } = toRecord(recommendation.metadata);
      const requestedQuantity = typeof plannedQuantity === 'number' && Number.isInteger(plannedQuantity) && plannedQuantity > 0
        ? plannedQuantity : null;
      const sources = await tx.stockQuant.findMany({
        where: {
          warehouseId: warehouse.id, skuId, locationId: fromLocationId, status: 'AVAILABLE',
          handlingUnitId: null, location: { isActive: true },
          ...(typeof sourceQuantId === 'string' && isUuid(sourceQuantId) ? { id: sourceQuantId } : {}),
        },
        include: { sku: true, location: true },
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const source = sources.find(quant => quant.quantity - quant.reservedQuantity >= (requestedQuantity ?? 1));
      if (!source) throw new ConflictException('The source no longer holds enough movable stock for this recommendation.');
      const quantity = requestedQuantity ?? (source.quantity - source.reservedQuantity);
      const ownerClientId = source.ownerClientId ?? null;
      const active = await tx.warehouseTask.findMany({
        where: {
          warehouseId: warehouse.id, skuId, fromLocationId, toLocationId, ownerClientId, type: 'MOVE',
          status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] },
        },
        select: { id: true },
        take: 1,
      });
      if (active.length) throw new ConflictException('An active task already moves this SKU between these locations.');
      const task = await tx.warehouseTask.create({
        data: {
          warehouseId: warehouse.id, ownerClientId, type: 'MOVE', status: 'OPEN',
          skuId, fromLocationId, toLocationId, quantity, priority: recommendation.priority,
          metadata: {
            slottingRecommendationId: recommendation.id,
            reason: recommendation.reason,
            velocityScore: recommendation.velocityScore,
          },
        },
      });
      const moveTaskId = task.id;

      const updated = await tx.slottingRecommendation.update({
        where: { id: recommendation.id },
        data: {
          status: SlottingRecommendationStatus.APPLIED,
          appliedAt: new Date(),
          metadata: mergeMetadata(recommendation.metadata, {
            moveTaskId,
            appliedByUserId: actor.id,
          }),
        },
      });

      await this.writeAudit(tx, actor.id, warehouse.id, 'slotting.recommendation_applied', 'slotting_recommendation',
        recommendation.id, { skuCode: recommendation.skuCode, moveTaskId });
      await this.writeOutbox(tx, 'SLOTTING_RECOMMENDATION_APPLIED', 'slotting_recommendation',
        recommendation.id, { warehouseId: warehouse.id, skuCode: recommendation.skuCode, moveTaskId });

      return toRecommendationResponse(updated);
    });
  }

  async dismissRecommendation(
    warehouseReference: string,
    recommendationReference: string,
    actor: AuthenticatedUser,
  ): Promise<SlottingRecommendationResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    return this.transaction(async tx => {
      const recommendation = await this.lockRecommendation(tx, warehouse.id, recommendationReference);
      if (!canMutateSlottingRecommendation(recommendation.status)) {
        throw new ConflictException(`Slotting recommendation cannot be dismissed from status ${recommendation.status}.`);
      }
      const updated = await tx.slottingRecommendation.update({
        where: { id: recommendation.id },
        data: {
          status: SlottingRecommendationStatus.DISMISSED,
          dismissedAt: new Date(),
          metadata: mergeMetadata(recommendation.metadata, { dismissedByUserId: actor.id }),
        },
      });
      await this.writeAudit(tx, actor.id, warehouse.id, 'slotting.recommendation_dismissed', 'slotting_recommendation',
        recommendation.id, { skuCode: recommendation.skuCode });
      await this.writeOutbox(tx, 'SLOTTING_RECOMMENDATION_DISMISSED', 'slotting_recommendation',
        recommendation.id, { warehouseId: warehouse.id, skuCode: recommendation.skuCode });
      return toRecommendationResponse(updated);
    });
  }

  private async resolveWarehouse(reference: string): Promise<WarehouseRecord> {
    const warehouse = await this.client.warehouse.findFirst({ where: warehouseWhere(reference) });
    if (!warehouse) {
      throw new NotFoundException('Warehouse was not found.');
    }
    return warehouse;
  }

  private async resolveSku(reference: string): Promise<SkuRecord> {
    const normalized = normalizeCode(reference);
    const sku = await this.client.sku.findFirst({
      where: isUuid(reference)
        ? { OR: [{ id: reference }, { code: normalized }, { barcode: reference }] }
        : { OR: [{ code: normalized }, { barcode: reference }] },
    });
    if (!sku) {
      throw new NotFoundException('SKU was not found.');
    }
    return sku;
  }

  private async lockRecommendation(
    client: SlottingTransactionClient,
    warehouseId: string,
    reference: string,
  ): Promise<SlottingRecommendationRecord> {
    const found = await this.resolveRecommendationWithClient(client, warehouseId, reference);
    await lockPostgresRowById(client, 'slotting_recommendations', found.id);
    return this.resolveRecommendationWithClient(client, warehouseId, found.id);
  }

  private async resolveRecommendationWithClient(
    client: SlottingTransactionClient,
    warehouseId: string,
    reference: string,
  ): Promise<SlottingRecommendationRecord> {
    const recommendation = await client.slottingRecommendation.findFirst({
      where: isUuid(reference)
        ? { warehouseId, OR: [{ id: reference }] }
        : { warehouseId, OR: [{ skuCode: normalizeCode(reference) }] },
      orderBy: [{ createdAt: 'desc' }],
    });
    if (!recommendation) {
      throw new NotFoundException('Slotting recommendation was not found.');
    }
    return recommendation;
  }

  private async writeAudit(
    tx: SlottingTransactionClient,
    actorUserId: string,
    warehouseId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: { actorUserId, warehouseId, action, resourceType, resourceId, metadata },
    });
  }

  private async writeOutbox(
    tx: SlottingTransactionClient,
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.outboxEvent.create({ data: { type, aggregateType, aggregateId, payload } });
  }

  private transaction<T>(fn: (tx: SlottingTransactionClient) => Promise<T>): Promise<T> {
    return withTransactionRetry(() => this.client.$transaction(fn));
  }

  private get client(): SlottingPrismaClient {
    return this.prisma as unknown as SlottingPrismaClient;
  }
}

function toRuleResponse(rule: SlottingRuleRecord): SlottingRuleResponse {
  return {
    id: rule.id,
    warehouseId: rule.warehouseId,
    code: rule.code,
    status: rule.status,
    zone: rule.zone,
    minVelocityScore: rule.minVelocityScore,
    maxVelocityScore: rule.maxVelocityScore,
    targetLocationType: rule.targetLocationType,
    maxPickSequence: rule.maxPickSequence,
    minPickFaceQuantity: rule.minPickFaceQuantity,
    metadata: rule.metadata,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function toVelocityResponse(velocity: SkuVelocityRecord): SkuVelocityResponse {
  return {
    id: velocity.id,
    warehouseId: velocity.warehouseId,
    skuId: velocity.skuId,
    skuCode: velocity.skuCode,
    picksLast30Days: velocity.picksLast30Days,
    unitsPickedLast30Days: velocity.unitsPickedLast30Days,
    replenishmentsLast30Days: velocity.replenishmentsLast30Days,
    velocityScore: velocity.velocityScore,
    abcClass: velocity.abcClass,
    metadata: velocity.metadata,
    lastCalculatedAt: velocity.lastCalculatedAt.toISOString(),
    createdAt: velocity.createdAt.toISOString(),
    updatedAt: velocity.updatedAt.toISOString(),
  };
}

function toRecommendationResponse(
  recommendation: SlottingRecommendationRecord,
): SlottingRecommendationResponse {
  return {
    id: recommendation.id,
    warehouseId: recommendation.warehouseId,
    skuId: recommendation.skuId,
    skuCode: recommendation.skuCode,
    fromLocationId: recommendation.fromLocationId,
    toLocationId: recommendation.toLocationId,
    status: recommendation.status,
    reason: recommendation.reason,
    priority: recommendation.priority,
    velocityScore: recommendation.velocityScore,
    expectedTravelSavings: recommendation.expectedTravelSavings,
    message: recommendation.message,
    metadata: publicRecommendationMetadata(recommendation.metadata),
    appliedAt: recommendation.appliedAt?.toISOString() ?? null,
    dismissedAt: recommendation.dismissedAt?.toISOString() ?? null,
    createdAt: recommendation.createdAt.toISOString(),
    updatedAt: recommendation.updatedAt.toISOString(),
  };
}

function toDraftResponse(
  warehouseId: string,
  draft: SlottingRecommendationDraft,
): SlottingRecommendationResponse {
  const now = new Date().toISOString();
  return {
    id: `dry-run:${draft.skuCode}:${draft.reason}:${draft.toLocationId ?? 'none'}`,
    warehouseId,
    skuId: draft.skuId,
    skuCode: draft.skuCode,
    fromLocationId: draft.fromLocationId,
    toLocationId: draft.toLocationId,
    status: SlottingRecommendationStatus.OPEN,
    reason: draft.reason,
    priority: draft.priority,
    velocityScore: draft.velocityScore,
    expectedTravelSavings: draft.expectedTravelSavings,
    message: draft.message,
    metadata: publicRecommendationMetadata(draft.metadata),
    appliedAt: null,
    dismissedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function publicRecommendationMetadata(metadata: unknown): unknown {
  if (!Object.hasOwn(toRecord(metadata), 'sourceQuantId')) return metadata;
  const result = { ...toRecord(metadata) };
  delete result['sourceQuantId'];
  return result;
}

function toVelocityCandidate(velocity: SkuVelocityRecord): SlottingVelocityCandidate {
  return {
    skuId: velocity.skuId,
    skuCode: velocity.skuCode,
    picksLast30Days: velocity.picksLast30Days,
    unitsPickedLast30Days: velocity.unitsPickedLast30Days,
    replenishmentsLast30Days: velocity.replenishmentsLast30Days,
    velocityScore: velocity.velocityScore,
    abcClass: velocity.abcClass,
  };
}

function toLocationCandidate(location: LocationRecord): SlottingLocationCandidate {
  return {
    id: location.id,
    code: location.code,
    type: location.type,
    zone: location.zone,
    pickSequence: location.pickSequence,
    isActive: location.isActive,
  };
}

function toStockCandidate(stock: StockQuantWithRelations): SlottingStockCandidate {
  return {
    id: stock.id,
    ownerClientId: stock.ownerClientId,
    skuId: stock.skuId,
    skuCode: stock.sku.code,
    locationId: stock.locationId,
    locationCode: stock.location.code,
    locationType: stock.location.type,
    zone: stock.location.zone,
    pickSequence: stock.location.pickSequence,
    quantity: stock.quantity,
    reservedQuantity: stock.reservedQuantity,
  };
}

function recommendationKey(recommendation: Pick<SlottingRecommendationRecord, 'skuCode' | 'fromLocationId' | 'toLocationId'>): string {
  return [
    recommendation.skuCode,
    recommendation.fromLocationId ?? '',
    recommendation.toLocationId ?? '',
  ].join('|');
}

function warehouseWhere(reference: string): Record<string, unknown> {
  return isUuid(reference)
    ? { OR: [{ id: reference }, { code: normalizeCode(reference) }] }
    : { code: normalizeCode(reference) };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeNullableCode(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return normalizeCode(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function mergeMetadata(metadata: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...toRecord(metadata), ...extra };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface SlottingPrismaClient extends SlottingTransactionClient {
  $transaction<T>(fn: (client: SlottingTransactionClient) => Promise<T>): Promise<T>;
}

interface SlottingTransactionClient {
  warehouse: { findFirst(args: Record<string, unknown>): Promise<WarehouseRecord | null> };
  warehouseLocation: {
    findFirst(args: Record<string, unknown>): Promise<LocationRecord | null>;
    findMany(args: Record<string, unknown>): Promise<LocationRecord[]>;
  };
  sku: { findFirst(args: Record<string, unknown>): Promise<SkuRecord | null> };
  stockQuant: { findMany(args: Record<string, unknown>): Promise<StockQuantWithRelations[]> };
  slottingRule: {
    create(args: Record<string, unknown>): Promise<SlottingRuleRecord>;
    findMany(args: Record<string, unknown>): Promise<SlottingRuleRecord[]>;
  };
  skuVelocity: {
    findFirst(args: Record<string, unknown>): Promise<SkuVelocityRecord | null>;
    findMany(args: Record<string, unknown>): Promise<SkuVelocityRecord[]>;
    upsert(args: Record<string, unknown>): Promise<SkuVelocityRecord>;
  };
  slottingRecommendation: {
    create(args: Record<string, unknown>): Promise<SlottingRecommendationRecord>;
    findFirst(args: Record<string, unknown>): Promise<SlottingRecommendationRecord | null>;
    findMany(args: Record<string, unknown>): Promise<SlottingRecommendationRecord[]>;
    update(args: Record<string, unknown>): Promise<SlottingRecommendationRecord>;
  };
  warehouseTask: {
    create(args: Record<string, unknown>): Promise<{ id: string }>;
    findMany(args: Record<string, unknown>): Promise<{ id: string }[]>;
  };
  auditLog: { create(args: Record<string, unknown>): Promise<unknown> };
  outboxEvent: { create(args: Record<string, unknown>): Promise<unknown> };
}

interface WarehouseRecord {
  id: string;
  code: string;
}

interface SkuRecord {
  id: string;
  code: string;
  barcode: string | null;
}

interface LocationRecord {
  id: string;
  code: string;
  type: string;
  zone: string | null;
  pickSequence: number;
  isActive: boolean;
}

interface StockQuantWithRelations {
  id: string;
  warehouseId: string;
  ownerClientId: string | null;
  locationId: string;
  skuId: string;
  quantity: number;
  reservedQuantity: number;
  status: string;
  sku: SkuRecord;
  location: LocationRecord;
}

interface SlottingRuleRecord {
  id: string;
  warehouseId: string;
  code: string;
  status: string;
  zone: string | null;
  minVelocityScore: number | null;
  maxVelocityScore: number | null;
  targetLocationType: string | null;
  maxPickSequence: number | null;
  minPickFaceQuantity: number | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface SkuVelocityRecord {
  id: string;
  warehouseId: string;
  skuId: string | null;
  skuCode: string;
  picksLast30Days: number;
  unitsPickedLast30Days: number;
  replenishmentsLast30Days: number;
  velocityScore: number;
  abcClass: string | null;
  metadata: unknown;
  lastCalculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface SlottingRecommendationRecord {
  id: string;
  warehouseId: string;
  skuId: string | null;
  skuCode: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  status: string;
  reason: string;
  priority: number;
  velocityScore: number;
  expectedTravelSavings: number | null;
  message: string | null;
  metadata: unknown;
  appliedAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
