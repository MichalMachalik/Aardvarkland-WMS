import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthenticatedUser } from '../access-control';
import { normalizeOffsetPagination } from '../common';
import { lockPostgresRowById, PrismaService, withTransactionRetry } from '../database';
import { evaluateWorkflowTransition } from '../workflow';
import { Prisma, Sku, Warehouse, WarehouseLocation } from '../generated/prisma/client';
import { CancelWarehouseOrderDto } from './dto/cancel-warehouse-order.dto';
import { CompleteWarehouseOrderDto } from './dto/complete-warehouse-order.dto';
import { CreateWarehouseOrderDto } from './dto/create-warehouse-order.dto';
import { ListWarehouseOrdersQueryDto } from './dto/list-warehouse-orders-query.dto';
import {
  WarehouseOrderLineResponse,
  WarehouseOrderLineStatus,
  WarehouseOrderResponse,
  WarehouseOrderStatus,
  WarehouseOrderTaskLinkResponse,
  WarehouseOrderType,
} from './warehouse-orders.types';

interface WarehouseOrderRow {
  id: string;
  warehouse_id: string;
  owner_client_id: string | null;
  order_number: string;
  order_type: string;
  status: string;
  priority: number;
  source_type: string | null;
  source_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  due_at: Date | string | null;
  released_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WarehouseOrderLineRow {
  id: string;
  warehouse_id: string;
  owner_client_id: string | null;
  warehouse_order_id: string;
  line_number: string;
  sku_id: string | null;
  lot_id: string | null;
  requested_quantity: number;
  allocated_quantity: number;
  completed_quantity: number;
  serial_required: boolean;
  status: string;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WarehouseOrderTaskLinkRow {
  id: string;
  warehouse_order_id: string;
  warehouse_order_line_id: string | null;
  warehouse_task_id: string;
  created_at: Date | string;
}

interface ResolvedOrderLine {
  lineNumber: string;
  skuId: string | null;
  lotId: string | null;
  requestedQuantity: number;
  serialRequired: boolean;
  metadata: Record<string, unknown>;
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

interface LineTaskProgress {
  pending: boolean;
  recorded: boolean;
  quantity: number;
}

@Injectable()
export class WarehouseOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(warehouseReference: string, query: ListWarehouseOrdersQueryDto): Promise<WarehouseOrderResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const conditions = ['warehouse_id = $1::uuid'];
    const values: unknown[] = [warehouse.id];
    const page = normalizeOffsetPagination(query, { defaultTake: 100, maxTake: 250 });

    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}::"WarehouseOrderStatus"`);
    }
    if (query.orderType) {
      values.push(query.orderType);
      conditions.push(`order_type = $${values.length}::"WarehouseOrderType"`);
    }
    if (query.ownerClientId) {
      if (!isUuid(query.ownerClientId)) throw new BadRequestException('Warehouse order owner must be a client ID');
      values.push(query.ownerClientId);
      conditions.push(`owner_client_id = $${values.length}::uuid`);
    }

    const rows = await this.prisma.$queryRawUnsafe<WarehouseOrderRow[]>(
      `${ORDER_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY priority ASC, created_at DESC LIMIT $${values.length + 1}::int OFFSET $${values.length + 2}::int`,
      ...values,
      page.take,
      page.skip,
    );
    const responses: WarehouseOrderResponse[] = [];
    for (const row of rows) {
      responses.push(await this.hydrateOrder(row));
    }
    return responses;
  }

  async getOrder(warehouseReference: string, orderReference: string): Promise<WarehouseOrderResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const order = await this.resolveOrder(warehouse.id, orderReference);
    return this.hydrateOrder(order);
  }

  async createOrder(
    warehouseReference: string,
    dto: CreateWarehouseOrderDto,
    actor: AuthenticatedUser,
  ): Promise<WarehouseOrderResponse> {
    if (dto.lines.length === 0) {
      throw new ConflictException('Warehouse order must contain at least one line');
    }

    const warehouse = await this.resolveWarehouse(warehouseReference);
    const ownerClientId = normalizeNullableString(dto.ownerClientId);
    if (ownerClientId) {
      if (!isUuid(ownerClientId)) throw new BadRequestException('Warehouse order owner must be a client ID');
      const owner = await this.prisma.wmsClient.findUnique({ where: { id: ownerClientId }, select: { id: true } });
      if (!owner) throw new NotFoundException('Warehouse order owner was not found');
    }
    const fromLocation = dto.fromLocationReference ? await this.resolveLocation(warehouse.id, dto.fromLocationReference) : null;
    const toLocation = dto.toLocationReference ? await this.resolveLocation(warehouse.id, dto.toLocationReference) : null;
    const lines = await this.resolveLines(warehouse.id, dto.lines);
    if (dto.orderType === WarehouseOrderType.MOVE &&
        (!fromLocation || !toLocation || fromLocation.id === toLocation.id || lines.some(line => !line.skuId))) {
      throw new ConflictException('A movement order requires distinct locations and a SKU on each line');
    }
    const orderNumber = normalizeNullableString(dto.orderNumber)?.toUpperCase() ?? generateOrderNumber();

    return this.transaction(async (client) => {
      const [order] = await client.$queryRawUnsafe<WarehouseOrderRow[]>(
        `
          INSERT INTO warehouse_orders
            (warehouse_id, owner_client_id, order_number, order_type, status, priority, source_type, source_id,
             from_location_id, to_location_id, due_at, metadata, created_at, updated_at)
          VALUES
            ($1::uuid, $2::uuid, $3, $4::"WarehouseOrderType", 'DRAFT', $5, $6, $7, $8::uuid, $9::uuid, $10, $11::jsonb, NOW(), NOW())
          ON CONFLICT (warehouse_id, order_number) DO NOTHING
          RETURNING ${ORDER_COLUMNS}
        `,
        warehouse.id,
        ownerClientId,
        orderNumber,
        dto.orderType,
        dto.priority ?? 100,
        normalizeNullableString(dto.sourceType),
        normalizeNullableString(dto.sourceId),
        fromLocation?.id ?? null,
        toLocation?.id ?? null,
        dto.dueAt ? new Date(dto.dueAt) : null,
        JSON.stringify(dto.metadata ?? {}),
      );
      if (!order) throw new ConflictException('Warehouse order number already exists in this warehouse');

      for (const line of lines) {
        await client.$executeRawUnsafe(
          `
            INSERT INTO warehouse_order_lines
              (warehouse_id, owner_client_id, warehouse_order_id, line_number, sku_id, lot_id,
               requested_quantity, allocated_quantity, completed_quantity, serial_required, status, metadata, created_at, updated_at)
            VALUES
              ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, 0, 0, $8, 'OPEN', $9::jsonb, NOW(), NOW())
          `,
          warehouse.id,
          ownerClientId,
          order.id,
          line.lineNumber,
          line.skuId,
          line.lotId,
          line.requestedQuantity,
          line.serialRequired,
          JSON.stringify(line.metadata),
        );
      }

      await this.writeAudit(client, actor, warehouse.id, 'warehouse_order.created', order.id, { orderNumber });
      return this.hydrateOrder(order, client);
    });
  }

  async releaseOrder(
    warehouseReference: string,
    orderReference: string,
    actor: AuthenticatedUser,
  ): Promise<WarehouseOrderResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    return this.transaction(async (client) => {
      const order = await this.lockOrder(client, warehouse.id, orderReference);
      this.assertWarehouseOrderTransition(
        order,
        'RELEASE',
        actor,
        order.status === WarehouseOrderStatus.EXCEPTION ? 'EXCEPTION_RECOVERED' : undefined,
      );
      const lines = await this.readOrderLines(order.id, client);
      const progress = await this.readTaskProgress(client, order);
      await client.$executeRawUnsafe(
        `UPDATE warehouse_orders SET status = 'RELEASED', released_at = COALESCE(released_at, NOW()), updated_at = NOW() WHERE id = $1::uuid`,
        order.id,
      );

      for (const line of lines) {
        if (line.status === WarehouseOrderLineStatus.DONE || progress.has(line.id)) continue;
        const taskRows = await client.$queryRawUnsafe<{ id: string }[]>(
          `
            INSERT INTO warehouse_tasks
              (warehouse_id, owner_client_id, type, status, sku_id, from_location_id, to_location_id, quantity,
               priority, external_reference, metadata, due_at, created_at, updated_at)
            VALUES
              ($1::uuid, $2::uuid, $3::"WarehouseTaskType", 'OPEN', $4::uuid, $5::uuid, $6::uuid, $7,
               $8, $9, $10::jsonb, $11, NOW(), NOW())
            RETURNING id
          `,
          order.warehouse_id,
          line.owner_client_id ?? order.owner_client_id,
          mapOrderTypeToTaskType(order.order_type as WarehouseOrderType),
          line.sku_id,
          order.from_location_id,
          order.to_location_id,
          line.requested_quantity,
          order.priority,
          `${order.order_number}:${line.line_number}`,
          JSON.stringify({ warehouseOrderId: order.id, warehouseOrderLineId: line.id, orderNumber: order.order_number, lotId: line.lot_id }),
          order.due_at,
        );
        const task = assertSingle(taskRows, 'Warehouse task was not created');
        await client.$executeRawUnsafe(
          `
            INSERT INTO warehouse_order_tasks
              (warehouse_id, owner_client_id, warehouse_order_id, warehouse_order_line_id, warehouse_task_id, created_at)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, NOW())
            ON CONFLICT (warehouse_order_id, warehouse_task_id) DO NOTHING
          `,
          order.warehouse_id,
          line.owner_client_id ?? order.owner_client_id,
          order.id,
          line.id,
          task.id,
        );
        await client.$executeRawUnsafe(
          `UPDATE warehouse_order_lines SET status = 'IN_PROGRESS', allocated_quantity = requested_quantity, updated_at = NOW() WHERE id = $1::uuid`,
          line.id,
        );
      }
      await this.writeAudit(client, actor, warehouse.id, 'warehouse_order.released', order.id, { orderNumber: order.order_number });
      return this.readOrderById(order.id, client);
    });
  }

  async completeOrder(
    warehouseReference: string,
    orderReference: string,
    dto: CompleteWarehouseOrderDto,
    actor: AuthenticatedUser,
  ): Promise<WarehouseOrderResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    return this.transaction(async (client) => {
      const order = await this.lockOrder(client, warehouse.id, orderReference);
      this.assertWarehouseOrderTransition(order, 'COMPLETE', actor);
      const lines = await this.readOrderLines(order.id, client);
      const progress = await this.readTaskProgress(client, order);
      const countOnly = isCountOrder(order);
      if (progress.get(null)?.pending) throw new ConflictException('Warehouse order still has unfinished tasks');

      for (const line of lines) {
        const result = progress.get(line.id);
        if (!result?.recorded || result.pending || (!countOnly && result.quantity !== line.requested_quantity)) {
          throw new ConflictException(`Warehouse order line ${line.line_number} has unfinished work`);
        }
        await client.warehouseOrderLine.update({
          where: { id: line.id },
          data: { status: WarehouseOrderLineStatus.DONE, completedQuantity: result.quantity },
        });
      }
      await client.$executeRawUnsafe(
        `UPDATE warehouse_orders SET status = 'COMPLETED', completed_at = NOW(), metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1::uuid`,
        order.id,
        JSON.stringify(dto.metadata ?? {}),
      );
      await this.writeAudit(client, actor, warehouse.id, 'warehouse_order.completed', order.id, dto.metadata ?? {});
      return this.readOrderById(order.id, client);
    });
  }

  async cancelOrder(
    warehouseReference: string,
    orderReference: string,
    dto: CancelWarehouseOrderDto,
    actor: AuthenticatedUser,
  ): Promise<WarehouseOrderResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const reason = normalizeNullableString(dto.reason);
    return this.transaction(async (client) => {
      const order = await this.lockOrder(client, warehouse.id, orderReference);
      this.assertWarehouseOrderTransition(order, 'CANCEL', actor, reason);
      await client.$executeRawUnsafe(
        `UPDATE warehouse_orders SET status = 'CANCELLED', cancelled_at = NOW(), metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1::uuid`,
        order.id,
        JSON.stringify({ ...(dto.metadata ?? {}), cancellationReason: reason }),
      );
      await client.$executeRawUnsafe(
        `
          UPDATE warehouse_tasks wt
          SET status = 'CANCELLED', failure_reason = $2, completed_at = COALESCE(completed_at, NOW()),
              version = version + 1, updated_at = NOW()
          FROM warehouse_order_tasks wot
          WHERE wot.warehouse_task_id = wt.id AND wot.warehouse_order_id = $1::uuid AND wt.status NOT IN ('DONE', 'CANCELLED')
        `,
        order.id,
        reason,
      );
      const lines = await this.readOrderLines(order.id, client);
      const progress = await this.readTaskProgress(client, order);
      for (const line of lines) {
        if (line.status === WarehouseOrderLineStatus.DONE) continue;
        const result = progress.get(line.id);
        const completed = result?.recorded && (isCountOrder(order) || result.quantity === line.requested_quantity);
        await client.warehouseOrderLine.update({
          where: { id: line.id },
          data: {
            status: completed ? WarehouseOrderLineStatus.DONE : WarehouseOrderLineStatus.CANCELLED,
            completedQuantity: result?.quantity ?? line.completed_quantity,
          },
        });
      }
      await this.writeAudit(client, actor, warehouse.id, 'warehouse_order.cancelled', order.id, { reason });
      return this.readOrderById(order.id, client);
    });
  }

  private transaction<T>(run: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTransactionRetry(() => this.prisma.$transaction(run));
  }

  private async lockOrder(
    client: Prisma.TransactionClient, warehouseId: string, orderReference: string,
  ): Promise<WarehouseOrderRow> {
    const candidate = await this.resolveOrder(warehouseId, orderReference, client);
    await lockPostgresRowById(client, 'warehouse_orders', candidate.id);
    return this.resolveOrder(warehouseId, candidate.id, client);
  }

  private async readTaskProgress(client: Prisma.TransactionClient, order: WarehouseOrderRow) {
    const links = await client.warehouseOrderTask.findMany({
      where: { warehouseOrderId: order.id, warehouseTask: { status: { notIn: ['FAILED', 'CANCELLED'] } } },
      select: {
        warehouseOrderLineId: true,
        warehouseTask: { select: {
          status: true,
          quantity: true,
          stockMovements: { where: { type: 'MOVE' }, select: { quantity: true } },
        } },
      },
    });
    const progress = new Map<string | null, LineTaskProgress>();
    for (const link of links) {
      const line = progress.get(link.warehouseOrderLineId) ?? { pending: false, recorded: false, quantity: 0 };
      const task = link.warehouseTask;
      const moved = order.order_type === WarehouseOrderType.MOVE
        ? task.stockMovements.reduce((total, movement) => total + movement.quantity, 0)
        : null;
      if (task.status === 'DONE' && task.quantity !== null && (moved === null || moved === task.quantity)) {
        line.recorded = true;
        line.quantity += task.quantity;
      } else {
        line.pending = true;
      }
      progress.set(link.warehouseOrderLineId, line);
    }
    return progress;
  }

  private assertWarehouseOrderTransition(
    order: WarehouseOrderRow,
    action: 'RELEASE' | 'COMPLETE' | 'CANCEL' | 'START' | 'PARTIAL_COMPLETE' | 'RAISE_EXCEPTION',
    actor: AuthenticatedUser,
    reasonCode?: string | null,
  ): void {
    const permissions = actor.warehouses.find(access => access.warehouseId === order.warehouse_id)?.permissionCodes;
    const evaluation = evaluateWorkflowTransition({
      entity: 'WAREHOUSE_ORDER',
      currentStatus: order.status,
      action,
      reasonCode,
      actorPermissions: permissions?.includes('*') ? undefined : permissions,
    });

    if (!evaluation.allowed) {
      const message = evaluation.issues.map((issue) => issue.message).join(' ') || `Warehouse order action ${action} is not allowed from ${order.status}.`;
      throw new ConflictException(message);
    }
  }

  private async resolveWarehouse(warehouseReference: string): Promise<Warehouse> {
    const warehouse = await this.prisma.warehouse.findFirst({ where: warehouseReferenceWhere(warehouseReference) });
    if (!warehouse) throw new NotFoundException('Warehouse was not found');
    return warehouse;
  }

  private async resolveLocation(warehouseId: string, reference: string): Promise<WarehouseLocation> {
    const location = await this.prisma.warehouseLocation.findFirst({ where: locationReferenceWhere(warehouseId, reference) });
    if (!location) throw new NotFoundException('Warehouse location was not found');
    return location;
  }

  private async resolveSku(reference: string): Promise<Sku> {
    const sku = await this.prisma.sku.findFirst({ where: skuReferenceWhere(reference) });
    if (!sku) throw new NotFoundException('SKU was not found');
    return sku;
  }

  private async resolveLot(warehouseId: string, reference: string): Promise<{ id: string; sku_id: string }> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; sku_id: string }[]>(
      `SELECT id, sku_id FROM sku_lots WHERE warehouse_id = $1::uuid AND (id::text = $2 OR lot_code = $3) LIMIT 1`,
      warehouseId,
      reference,
      normalizeCode(reference),
    );
    const lot = rows[0];
    if (!lot) throw new NotFoundException('Lot was not found');
    return lot;
  }

  private async resolveOrder(warehouseId: string, reference: string, client: RawClient = this.prisma): Promise<WarehouseOrderRow> {
    const rows = await client.$queryRawUnsafe<WarehouseOrderRow[]>(
      `${ORDER_SELECT} WHERE warehouse_id = $1::uuid AND (id::text = $2 OR order_number = $3) LIMIT 1`,
      warehouseId,
      reference,
      normalizeCode(reference),
    );
    const order = rows[0];
    if (!order) throw new NotFoundException('Warehouse order was not found');
    return order;
  }

  private async resolveLines(warehouseId: string, lines: CreateWarehouseOrderDto['lines']): Promise<ResolvedOrderLine[]> {
    const resolved: ResolvedOrderLine[] = [];
    const lineNumbers = new Set<string>();
    for (const line of lines) {
      const lineNumber = line.lineNumber.trim();
      if (!lineNumber || lineNumbers.has(lineNumber)) {
        throw new ConflictException('Warehouse order requires distinct, nonempty line numbers');
      }
      lineNumbers.add(lineNumber);
      const sku = line.skuReference ? await this.resolveSku(line.skuReference) : null;
      const lot = line.lotReference ? await this.resolveLot(warehouseId, line.lotReference) : null;
      if (sku && lot && sku.id !== lot.sku_id) {
        throw new ConflictException(`Lot does not belong to the SKU on warehouse order line ${lineNumber}`);
      }
      resolved.push({
        lineNumber,
        skuId: sku?.id ?? lot?.sku_id ?? null,
        lotId: lot?.id ?? null,
        requestedQuantity: line.requestedQuantity ?? 1,
        serialRequired: line.serialRequired ?? false,
        metadata: line.metadata ?? {},
      });
    }
    return resolved;
  }

  private async readOrderById(orderId: string, client: RawClient): Promise<WarehouseOrderResponse> {
    const rows = await client.$queryRawUnsafe<WarehouseOrderRow[]>(`${ORDER_SELECT} WHERE id = $1::uuid`, orderId);
    const order = assertSingle(rows, 'Warehouse order was not found');
    return this.hydrateOrder(order, client);
  }

  private async hydrateOrder(order: WarehouseOrderRow, client: RawClient = this.prisma): Promise<WarehouseOrderResponse> {
    const lines = await this.readOrderLines(order.id, client);
    const taskLinks = await client.$queryRawUnsafe<WarehouseOrderTaskLinkRow[]>(
      `${TASK_LINK_SELECT} WHERE warehouse_order_id = $1::uuid ORDER BY created_at ASC`,
      order.id,
    );

    return {
      id: order.id,
      warehouseId: order.warehouse_id,
      ownerClientId: order.owner_client_id,
      orderNumber: order.order_number,
      orderType: order.order_type as WarehouseOrderType,
      status: order.status as WarehouseOrderStatus,
      priority: Number(order.priority),
      sourceType: order.source_type,
      sourceId: order.source_id,
      fromLocationId: order.from_location_id,
      toLocationId: order.to_location_id,
      dueAt: nullableDate(order.due_at),
      releasedAt: nullableDate(order.released_at),
      completedAt: nullableDate(order.completed_at),
      cancelledAt: nullableDate(order.cancelled_at),
      metadata: order.metadata,
      lines: lines.map(toLineResponse),
      taskLinks: taskLinks.map(toTaskLinkResponse),
      createdAt: toDate(order.created_at),
      updatedAt: toDate(order.updated_at),
    };
  }

  private async readOrderLines(orderId: string, client: RawClient): Promise<WarehouseOrderLineRow[]> {
    return client.$queryRawUnsafe<WarehouseOrderLineRow[]>(
      `${LINE_SELECT} WHERE warehouse_order_id = $1::uuid ORDER BY line_number ASC`,
      orderId,
    );
  }

  private async writeAudit(
    client: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    warehouseId: string,
    action: string,
    resourceId: string,
    metadata: unknown,
  ): Promise<void> {
    await client.auditLog.create({
      data: {
        actorUserId: actor.id,
        warehouseId,
        action,
        resourceType: 'warehouse_order',
        resourceId,
        metadata: JSON.parse(JSON.stringify(metadata ?? {})),
      },
    });
  }
}

const ORDER_COLUMNS = `id, warehouse_id, owner_client_id, order_number, order_type, status, priority, source_type, source_id, from_location_id, to_location_id, due_at, released_at, completed_at, cancelled_at, metadata, created_at, updated_at`;
const ORDER_SELECT = `SELECT ${ORDER_COLUMNS} FROM warehouse_orders`;
const LINE_COLUMNS = `id, warehouse_id, owner_client_id, warehouse_order_id, line_number, sku_id, lot_id, requested_quantity, allocated_quantity, completed_quantity, serial_required, status, metadata, created_at, updated_at`;
const LINE_SELECT = `SELECT ${LINE_COLUMNS} FROM warehouse_order_lines`;
const TASK_LINK_COLUMNS = `id, warehouse_order_id, warehouse_order_line_id, warehouse_task_id, created_at`;
const TASK_LINK_SELECT = `SELECT ${TASK_LINK_COLUMNS} FROM warehouse_order_tasks`;

function toLineResponse(row: WarehouseOrderLineRow): WarehouseOrderLineResponse {
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    ownerClientId: row.owner_client_id,
    warehouseOrderId: row.warehouse_order_id,
    lineNumber: row.line_number,
    skuId: row.sku_id,
    lotId: row.lot_id,
    requestedQuantity: Number(row.requested_quantity),
    allocatedQuantity: Number(row.allocated_quantity),
    completedQuantity: Number(row.completed_quantity),
    serialRequired: row.serial_required,
    status: row.status as WarehouseOrderLineStatus,
    metadata: row.metadata,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toTaskLinkResponse(row: WarehouseOrderTaskLinkRow): WarehouseOrderTaskLinkResponse {
  return {
    id: row.id,
    warehouseOrderId: row.warehouse_order_id,
    warehouseOrderLineId: row.warehouse_order_line_id,
    warehouseTaskId: row.warehouse_task_id,
    createdAt: toDate(row.created_at),
  };
}

function mapOrderTypeToTaskType(orderType: WarehouseOrderType): string {
  switch (orderType) {
    case WarehouseOrderType.ADJUSTMENT:
      return 'COUNT';
    case WarehouseOrderType.COUNT:
      return 'COUNT';
    case WarehouseOrderType.LOAD:
      return 'LOAD';
    case WarehouseOrderType.PICK:
      return 'PICK';
    case WarehouseOrderType.PUTAWAY:
      return 'PUTAWAY';
    case WarehouseOrderType.REPLENISH:
      return 'REPLENISH';
    case WarehouseOrderType.MOVE:
    default:
      return 'MOVE';
  }
}

function isCountOrder(order: WarehouseOrderRow): boolean {
  return order.order_type === WarehouseOrderType.COUNT || order.order_type === WarehouseOrderType.ADJUSTMENT;
}

function warehouseReferenceWhere(reference: string): Prisma.WarehouseWhereInput {
  return isUuid(reference) ? { OR: [{ id: reference }, { code: normalizeCode(reference) }] } : { code: normalizeCode(reference) };
}

function skuReferenceWhere(reference: string): Prisma.SkuWhereInput {
  return isUuid(reference) ? { OR: [{ id: reference }, { code: normalizeCode(reference) }, { barcode: reference.trim() }] } : { OR: [{ code: normalizeCode(reference) }, { barcode: reference.trim() }] };
}

function locationReferenceWhere(warehouseId: string, reference: string): Prisma.WarehouseLocationWhereInput {
  return isUuid(reference)
    ? { warehouseId, OR: [{ id: reference }, { code: normalizeCode(reference) }] }
    : { warehouseId, code: normalizeCode(reference) };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function generateOrderNumber(): string {
  return `WO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return toDate(value);
}

function assertSingle<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new NotFoundException(message);
  return row;
}
