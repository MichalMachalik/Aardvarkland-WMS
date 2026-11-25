import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthenticatedUser } from '../access-control/types';
import { normalizeOffsetPagination } from '../common';
import { lockPostgresRowById, PrismaService, withTransactionRetry } from '../database';
import { Prisma } from '../generated/prisma/client';
import {
  assertNoBlockingStockFreeze,
  findBlockingStockFreeze,
} from '../inventory/stock-freeze.helpers';
import { lockStockQuantIdentity } from '../inventory/stock-quant-identity.helpers';
import { calculateReplenishmentQuantity, getAvailableQuantity } from './replenishment.helpers';
import { ConfirmReplenishmentDto } from './dto/confirm-replenishment.dto';
import { CreateReplenishmentRuleDto } from './dto/create-replenishment-rule.dto';
import { EvaluateReplenishmentDto } from './dto/evaluate-replenishment.dto';
import { ListReplenishmentDemandsQueryDto } from './dto/list-replenishment-demands-query.dto';
import {
  ReplenishmentConfirmationResponse,
  ReplenishmentDemandResponse,
  ReplenishmentDemandStatus,
  ReplenishmentEvaluationResponse,
  ReplenishmentRuleResponse,
  ReplenishmentRuleStatus,
  ReplenishmentStrategy,
} from './replenishment.types';

@Injectable()
export class ReplenishmentService {
  constructor(private readonly prisma: PrismaService) {}

  async listRules(warehouseReference: string): Promise<ReplenishmentRuleResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const rules = await this.client.replenishmentRule.findMany({
      where: { warehouseId: warehouse.id },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { code: 'asc' }],
    });

    return rules.map(toRuleResponse);
  }

  async createRule(
    warehouseReference: string,
    dto: CreateReplenishmentRuleDto,
    actor: AuthenticatedUser,
  ): Promise<ReplenishmentRuleResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const sku = await this.resolveSku(dto.sku);
    const pickLocation = await this.resolveLocation(warehouse.id, dto.pickLocationReference);

    if (dto.targetQuantity < dto.minQuantity || dto.targetQuantity > dto.maxQuantity) {
      throw new ConflictException('Replenishment target must be between the minimum and maximum quantities');
    }

    const code = normalizeCode(dto.code ?? `${sku.code}-${pickLocation.code}-MINMAX`);
    try {
      return await this.transaction(async (tx) => {
        const rule = await tx.replenishmentRule.create({
          data: {
            warehouseId: warehouse.id,
            code,
            status: ReplenishmentRuleStatus.ACTIVE,
            strategy: dto.strategy ?? ReplenishmentStrategy.MIN_MAX,
            skuId: sku.id,
            pickLocationId: pickLocation.id,
            sourceZone: normalizeNullableString(dto.sourceZone)?.toUpperCase() ?? null,
            minQuantity: dto.minQuantity,
            maxQuantity: dto.maxQuantity,
            targetQuantity: dto.targetQuantity,
            priority: dto.priority ?? 100,
            metadata: dto.metadata ?? undefined,
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            warehouseId: warehouse.id,
            action: 'replenishment.rule_created',
            resourceType: 'replenishment_rule',
            resourceId: rule.id,
            metadata: { code: rule.code, skuId: sku.id, pickLocationId: pickLocation.id },
          },
        });
        return toRuleResponse(rule);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A replenishment rule with this code already exists in the warehouse');
      }
      throw error;
    }
  }

  async evaluate(
    warehouseReference: string,
    dto: EvaluateReplenishmentDto,
    actor: AuthenticatedUser,
  ): Promise<ReplenishmentEvaluationResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);

    return this.transaction(async (tx: ReplenishmentTransactionClient) => {
      const rules = await tx.replenishmentRule.findMany({
        where: {
          warehouseId: warehouse.id,
          status: ReplenishmentRuleStatus.ACTIVE,
          ...(dto.ruleReference ? referenceWhere(dto.ruleReference) : {}),
        },
        orderBy: [{ priority: 'asc' }, { code: 'asc' }],
      });

      if (dto.ruleReference && rules.length === 0) {
        throw new NotFoundException('Active replenishment rule was not found');
      }

      let demandsCreated = 0;
      let tasksCreated = 0;
      const skippedRules: Array<{ ruleId: string; reason: string }> = [];
      const demands: ReplenishmentDemandResponse[] = [];

      for (const rule of rules) {
        await lockPostgresRowById(tx, 'replenishment_rules', rule.id);
        const openDemand = await tx.replenishmentDemand.findFirst({
          where: {
            ruleId: rule.id,
            status: {
              in: [ReplenishmentDemandStatus.OPEN, ReplenishmentDemandStatus.TASK_CREATED],
            },
          },
        });

        if (openDemand) {
          const previousTask = openDemand.warehouseTaskId
            ? await tx.warehouseTask.findFirst({
                where: { id: openDemand.warehouseTaskId, warehouseId: warehouse.id },
              })
            : null;
          if (previousTask?.status !== 'CANCELLED' && previousTask?.status !== 'FAILED') {
            skippedRules.push({ ruleId: rule.id, reason: 'OPEN_DEMAND_EXISTS' });
            continue;
          }
          await tx.replenishmentDemand.update({
            where: { id: openDemand.id },
            data: { status: ReplenishmentDemandStatus.CANCELLED },
          });
        }

        const pickQuants = await tx.stockQuant.findMany({
          where: {
            warehouseId: warehouse.id,
            skuId: rule.skuId,
            locationId: rule.pickLocationId,
            status: 'AVAILABLE',
          },
        });
        const availablePickQuantity = pickQuants.reduce(
          (sum, quant) => sum + getAvailableQuantity(quant.quantity, quant.reservedQuantity),
          0,
        );
        const requiredQuantity = calculateReplenishmentQuantity({
          availablePickQuantity,
          minQuantity: rule.minQuantity,
          maxQuantity: rule.maxQuantity,
          targetQuantity: rule.targetQuantity,
        });

        if (requiredQuantity <= 0) {
          skippedRules.push({ ruleId: rule.id, reason: 'PICK_FACE_ABOVE_MIN' });
          continue;
        }

        const pickFaceFreeze = await findBlockingStockFreeze(tx, {
          warehouseId: warehouse.id,
          locationId: rule.pickLocationId,
          skuId: rule.skuId,
          operation: 'evaluate replenishment',
        });

        if (pickFaceFreeze) {
          skippedRules.push({ ruleId: rule.id, reason: 'PICK_FACE_FROZEN' });
          continue;
        }

        const sourceQuant = await this.findSourceQuant(tx, warehouse.id, rule, requiredQuantity);

        if (!sourceQuant) {
          skippedRules.push({ ruleId: rule.id, reason: 'NO_SOURCE_STOCK' });
          continue;
        }

        const sourceFreeze = await findBlockingStockFreeze(tx, {
          warehouseId: warehouse.id,
          stockQuantId: sourceQuant.id,
          locationId: sourceQuant.locationId,
          skuId: sourceQuant.skuId,
          operation: 'evaluate replenishment',
        });

        if (sourceFreeze) {
          skippedRules.push({ ruleId: rule.id, reason: 'SOURCE_STOCK_FROZEN' });
          continue;
        }

        const task = await tx.warehouseTask.create({
          data: {
            warehouseId: warehouse.id,
            ownerClientId: sourceQuant.ownerClientId,
            type: 'REPLENISH',
            status: 'OPEN',
            skuId: rule.skuId,
            fromLocationId: sourceQuant.locationId,
            toLocationId: rule.pickLocationId,
            quantity: Math.min(
              requiredQuantity,
              getAvailableQuantity(sourceQuant.quantity, sourceQuant.reservedQuantity),
            ),
            priority: rule.priority,
            metadata: {
              replenishmentRuleId: rule.id,
              sourceStockQuantId: sourceQuant.id,
              evaluationMetadata: dto.metadata ?? null,
            },
          },
        });
        const demand = await tx.replenishmentDemand.create({
          data: {
            warehouseId: warehouse.id,
            ruleId: rule.id,
            skuId: rule.skuId,
            pickLocationId: rule.pickLocationId,
            sourceLocationId: sourceQuant.locationId,
            stockQuantId: sourceQuant.id,
            warehouseTaskId: task.id,
            status: ReplenishmentDemandStatus.TASK_CREATED,
            requiredQuantity,
            availablePickQuantity,
            priority: rule.priority,
            metadata: { evaluationMetadata: dto.metadata ?? null },
          },
        });

        demandsCreated += 1;
        tasksCreated += 1;
        demands.push(toDemandResponse(demand));
      }

      await tx.auditLog.create({
        data: {
          actorUserId: actor.id,
          warehouseId: warehouse.id,
          action: 'replenishment.evaluated',
          resourceType: 'warehouse',
          resourceId: warehouse.id,
          metadata: { rulesEvaluated: rules.length, demandsCreated, tasksCreated, skippedRules },
        },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'REPLENISHMENT_EVALUATED',
          aggregateType: 'warehouse',
          aggregateId: warehouse.id,
          payload: { rulesEvaluated: rules.length, demandsCreated, tasksCreated, skippedRules },
        },
      });

      return { rulesEvaluated: rules.length, demandsCreated, tasksCreated, skippedRules, demands };
    });
  }

  async listDemands(
    warehouseReference: string,
    query: ListReplenishmentDemandsQueryDto = {},
  ): Promise<ReplenishmentDemandResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const sku = query.skuReference ? await this.resolveSku(query.skuReference) : null;
    const pagination = normalizeOffsetPagination(query, { defaultTake: 100, maxTake: 200 });
    const demands = await this.client.replenishmentDemand.findMany({
      where: {
        warehouseId: warehouse.id,
        ...(query.status ? { status: normalizeCode(query.status) } : {}),
        ...(sku ? { skuId: sku.id } : {}),
      },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'desc' }],
      take: pagination.take,
      skip: pagination.skip,
    });

    return demands.map(toDemandResponse);
  }

  async confirmTask(
    warehouseReference: string,
    taskReference: string,
    dto: ConfirmReplenishmentDto,
    actor: AuthenticatedUser,
  ): Promise<ReplenishmentConfirmationResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    if (!isUuid(taskReference)) {
      throw new NotFoundException('Replenishment demand was not found');
    }

    return this.transaction(async (tx: ReplenishmentTransactionClient) => {
      const candidate = await tx.replenishmentDemand.findFirst({
        where: {
          warehouseId: warehouse.id,
          OR: [{ id: taskReference }, { warehouseTaskId: taskReference }],
        },
      });

      if (!candidate) {
        throw new NotFoundException('Replenishment demand was not found');
      }

      if (!candidate.warehouseTaskId) {
        throw new ConflictException('Replenishment demand is missing its task');
      }
      await lockPostgresRowById(tx, 'warehouse_tasks', candidate.warehouseTaskId);

      const demand = await tx.replenishmentDemand.findFirst({
        where: { id: candidate.id, warehouseId: warehouse.id },
      });
      const task = await tx.warehouseTask.findFirst({
        where: { id: candidate.warehouseTaskId, warehouseId: warehouse.id },
      });
      if (!demand || !task) {
        throw new NotFoundException('Replenishment demand or task was not found');
      }
      if (demand.status !== ReplenishmentDemandStatus.TASK_CREATED ||
          task.type !== 'REPLENISH' || !['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status)) {
        throw new ConflictException('Replenishment task cannot be confirmed in its current state');
      }
      if (!demand.stockQuantId || !demand.sourceLocationId) {
        throw new ConflictException('Replenishment demand is missing source stock');
      }

      await lockPostgresRowById(tx, 'stock_quants', demand.stockQuantId);
      const sourceQuant = await tx.stockQuant.findFirst({ where: { id: demand.stockQuantId, warehouseId: warehouse.id } });

      if (!sourceQuant) {
        throw new NotFoundException('Source stock quant was not found');
      }
      if (sourceQuant.skuId !== demand.skuId || sourceQuant.locationId !== demand.sourceLocationId ||
          sourceQuant.status !== 'AVAILABLE' || sourceQuant.handlingUnitId ||
          sourceQuant.locationId === demand.pickLocationId) {
        throw new ConflictException('Source stock is no longer eligible for this replenishment task');
      }

      await assertNoBlockingStockFreeze(tx, {
        warehouseId: warehouse.id,
        stockQuantId: sourceQuant.id,
        locationId: sourceQuant.locationId,
        skuId: sourceQuant.skuId,
        operation: 'confirm replenishment source move',
      });
      await assertNoBlockingStockFreeze(tx, {
        warehouseId: warehouse.id,
        locationId: demand.pickLocationId,
        skuId: demand.skuId,
        operation: 'confirm replenishment destination move',
      });

      const movedQuantity =
        dto.quantity ??
        Math.min(
          demand.requiredQuantity,
          getAvailableQuantity(sourceQuant.quantity, sourceQuant.reservedQuantity),
        );

      if (
        movedQuantity <= 0 ||
        movedQuantity > demand.requiredQuantity ||
        movedQuantity > getAvailableQuantity(sourceQuant.quantity, sourceQuant.reservedQuantity)
      ) {
        throw new ConflictException('Invalid replenishment move quantity');
      }

      await tx.stockQuant.update({
        where: { id: sourceQuant.id },
        data: { quantity: { decrement: movedQuantity }, version: { increment: 1 } },
      });
      const destinationIdentity = {
        warehouseId: warehouse.id,
        skuId: demand.skuId,
        locationId: demand.pickLocationId,
        status: 'AVAILABLE',
        ownerClientId: sourceQuant.ownerClientId,
        lotId: sourceQuant.lotId,
        batch: sourceQuant.batch,
        handlingUnitId: null,
        expiryDate: sourceQuant.expiryDate,
      };
      await lockStockQuantIdentity(tx, { ...destinationIdentity, expiry: sourceQuant.expiryDate });
      const existing = await tx.stockQuant.findFirst({ where: destinationIdentity });
      const destinationQuant = existing
        ? await tx.stockQuant.update({
            where: { id: existing.id },
            data: { quantity: { increment: movedQuantity }, version: { increment: 1 } },
          })
        : await tx.stockQuant.create({
            data: {
              ...destinationIdentity,
              quantity: movedQuantity,
              reservedQuantity: 0,
              metadata: { source: 'replenishment', demandId: demand.id },
            },
          });

      const movement = await tx.stockMovement.create({
        data: {
          warehouseId: warehouse.id,
          ownerClientId: sourceQuant.ownerClientId,
          skuId: demand.skuId,
          stockQuantId: destinationQuant.id,
          taskId: task.id,
          actorUserId: actor.id,
          type: 'MOVE',
          quantity: movedQuantity,
          fromLocationId: demand.sourceLocationId,
          toLocationId: demand.pickLocationId,
          referenceType: 'replenishment_demand',
          referenceId: demand.id,
          metadata: {
            source: 'replenishment',
            demandId: demand.id,
            sourceStockQuantId: sourceQuant.id,
            confirmMetadata: dto.metadata ?? null,
          },
        },
      });
      await tx.warehouseTask.update({
        where: { id: task.id },
        data: {
          status: 'DONE',
          quantity: movedQuantity,
          completedAt: new Date(),
          version: { increment: 1 },
        },
      });
      const updatedDemand = await tx.replenishmentDemand.update({
        where: { id: demand.id },
        data: {
          status: ReplenishmentDemandStatus.COMPLETED,
          metadata: mergeMetadata(demand.metadata, { confirmMetadata: dto.metadata ?? null }),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: actor.id,
          warehouseId: warehouse.id,
          action: 'replenishment.confirmed',
          resourceType: 'replenishment_demand',
          resourceId: demand.id,
          metadata: { movedQuantity, movementId: movement.id },
        },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'REPLENISHMENT_COMPLETED',
          aggregateType: 'replenishment_demand',
          aggregateId: demand.id,
          payload: { warehouseId: warehouse.id, movedQuantity, movementId: movement.id },
        },
      });

      return { demand: toDemandResponse(updatedDemand), movedQuantity, movementId: movement.id };
    });
  }

  private async findSourceQuant(
    tx: ReplenishmentTransactionClient,
    warehouseId: string,
    rule: ReplenishmentRuleRecord,
    requiredQuantity: number,
  ): Promise<StockQuantRecord | null> {
    const quants = await tx.stockQuant.findMany({
      where: {
        warehouseId,
        skuId: rule.skuId,
        status: 'AVAILABLE',
        handlingUnitId: null,
        locationId: { not: rule.pickLocationId },
        ...(rule.sourceZone ? { location: { is: { zone: rule.sourceZone } } } : {}),
      },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });

    return (
      quants.find(
        (quant) => getAvailableQuantity(quant.quantity, quant.reservedQuantity) >= requiredQuantity,
      ) ??
      quants.find((quant) => getAvailableQuantity(quant.quantity, quant.reservedQuantity) > 0) ??
      null
    );
  }

  private async resolveWarehouse(reference: string): Promise<WarehouseRecord> {
    const warehouse = await this.client.warehouse.findFirst({ where: referenceWhere(reference) });

    if (!warehouse) {
      throw new NotFoundException('Warehouse was not found');
    }

    return warehouse;
  }

  private async resolveSku(reference: string): Promise<SkuRecord> {
    const normalized = reference.trim();
    const sku = await this.client.sku.findFirst({
      where: {
        OR: [
          ...(isUuid(normalized) ? [{ id: normalized }] : []),
          { code: normalizeCode(normalized) },
          { barcode: normalized },
        ],
      },
    });

    if (!sku) {
      throw new NotFoundException('SKU was not found');
    }

    return sku;
  }

  private async resolveLocation(warehouseId: string, reference: string): Promise<LocationRecord> {
    const normalized = reference.trim();
    const location = await this.client.warehouseLocation.findFirst({
      where: {
        warehouseId,
        OR: [
          ...(isUuid(normalized) ? [{ id: normalized }] : []),
          { code: normalizeCode(normalized) },
          { barcode: normalizeCode(normalized) },
        ],
      },
    });

    if (!location) {
      throw new NotFoundException('Warehouse location was not found');
    }

    return location;
  }

  private transaction<T>(
    fn: (client: ReplenishmentTransactionClient) => Promise<T>,
  ): Promise<T> {
    return withTransactionRetry(() => this.client.$transaction(fn));
  }

  private get client(): ReplenishmentPrismaClient {
    return this.prisma as unknown as ReplenishmentPrismaClient;
  }
}

function toRuleResponse(rule: ReplenishmentRuleRecord): ReplenishmentRuleResponse {
  return {
    id: rule.id,
    warehouseId: rule.warehouseId,
    code: rule.code,
    status: rule.status as ReplenishmentRuleStatus,
    strategy: rule.strategy as ReplenishmentStrategy,
    skuId: rule.skuId,
    pickLocationId: rule.pickLocationId,
    sourceZone: rule.sourceZone ?? null,
    minQuantity: rule.minQuantity,
    maxQuantity: rule.maxQuantity,
    targetQuantity: rule.targetQuantity,
    priority: rule.priority,
    metadata: rule.metadata ?? null,
  };
}

function toDemandResponse(demand: ReplenishmentDemandRecord): ReplenishmentDemandResponse {
  return {
    id: demand.id,
    warehouseId: demand.warehouseId,
    ruleId: demand.ruleId,
    skuId: demand.skuId,
    pickLocationId: demand.pickLocationId,
    sourceLocationId: demand.sourceLocationId ?? null,
    stockQuantId: demand.stockQuantId ?? null,
    warehouseTaskId: demand.warehouseTaskId ?? null,
    status: demand.status as ReplenishmentDemandStatus,
    requiredQuantity: demand.requiredQuantity,
    availablePickQuantity: demand.availablePickQuantity,
    priority: demand.priority,
    metadata: demand.metadata ?? null,
  };
}

function referenceWhere(reference: string): Record<string, unknown> {
  const normalized = reference.trim();
  return isUuid(normalized)
    ? { OR: [{ id: normalized }, { code: normalizeCode(normalized) }] }
    : { code: normalizeCode(normalized) };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mergeMetadata(metadata: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...toRecord(metadata), ...extra };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface ReplenishmentPrismaClient extends ReplenishmentTransactionClient {
  $transaction<T>(fn: (client: ReplenishmentTransactionClient) => Promise<T>): Promise<T>;
}

interface ReplenishmentTransactionClient {
  $queryRawUnsafe?<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  warehouse: { findFirst(args: Record<string, unknown>): Promise<WarehouseRecord | null> };
  warehouseLocation: { findFirst(args: Record<string, unknown>): Promise<LocationRecord | null> };
  sku: { findFirst(args: Record<string, unknown>): Promise<SkuRecord | null> };
  replenishmentRule: {
    create(args: Record<string, unknown>): Promise<ReplenishmentRuleRecord>;
    findMany(args: Record<string, unknown>): Promise<ReplenishmentRuleRecord[]>;
  };
  replenishmentDemand: {
    create(args: Record<string, unknown>): Promise<ReplenishmentDemandRecord>;
    findFirst(args: Record<string, unknown>): Promise<ReplenishmentDemandRecord | null>;
    findMany(args: Record<string, unknown>): Promise<ReplenishmentDemandRecord[]>;
    update(args: Record<string, unknown>): Promise<ReplenishmentDemandRecord>;
  };
  stockQuant: {
    create(args: Record<string, unknown>): Promise<StockQuantRecord>;
    findFirst(args: Record<string, unknown>): Promise<StockQuantRecord | null>;
    findMany(args: Record<string, unknown>): Promise<StockQuantRecord[]>;
    update(args: Record<string, unknown>): Promise<StockQuantRecord>;
  };
  warehouseTask: {
    create(args: Record<string, unknown>): Promise<{ id: string }>;
    findFirst(args: Record<string, unknown>): Promise<{ id: string; status: string; type: string } | null>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
  stockMovement: { create(args: Record<string, unknown>): Promise<{ id: string }> };
  auditLog: { create(args: Record<string, unknown>): Promise<unknown> };
  outboxEvent: { create(args: Record<string, unknown>): Promise<unknown> };
}

interface WarehouseRecord {
  id: string;
  code: string;
}

interface LocationRecord {
  id: string;
  code: string;
}

interface SkuRecord {
  id: string;
  code: string;
}

interface StockQuantRecord {
  id: string;
  warehouseId: string;
  locationId: string;
  skuId: string;
  quantity: number;
  reservedQuantity: number;
  status: string;
  ownerClientId: string | null;
  lotId: string | null;
  batch: string | null;
  expiryDate: Date | null;
  handlingUnitId: string | null;
}

interface ReplenishmentRuleRecord {
  id: string;
  warehouseId: string;
  code: string;
  status: string;
  strategy: string;
  skuId: string;
  pickLocationId: string;
  sourceZone: string | null;
  minQuantity: number;
  maxQuantity: number;
  targetQuantity: number;
  priority: number;
  metadata: unknown;
}

interface ReplenishmentDemandRecord {
  id: string;
  warehouseId: string;
  ruleId: string;
  skuId: string;
  pickLocationId: string;
  sourceLocationId: string | null;
  stockQuantId: string | null;
  warehouseTaskId: string | null;
  status: string;
  requiredQuantity: number;
  availablePickQuantity: number;
  priority: number;
  metadata: unknown;
}
