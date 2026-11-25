import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AuthenticatedUser } from '../../access-control/types';
import { lockPostgresAdvisoryTransaction, PrismaService, withTransactionRetry } from '../../database';
import { Prisma } from '../../generated/prisma/client';
import { OutboundService } from '../../outbound';
import { OutboundStatus } from '../../outbound/outbound.types';
import { asRecord, BASE_COM_REQUEST_TIMEOUT_MS, BaseComClient, baseComInteger } from './base-com.client';

const SYSTEM_CODE = 'BASE_COM';
const RESOURCE_TYPE = 'OUTBOUND_ORDER';
const MAX_LINE_QUANTITY = 2_147_483_647;

@Injectable()
export class BaseComService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly baseCom: BaseComClient,
  ) {}

  status() {
    return {
      configured: this.baseCom.configured,
      dispatchSyncConfigured: this.baseCom.configured && this.baseCom.shippedStatusId !== null,
    };
  }

  async importOrder(warehouseReference: string, orderId: number, actor: AuthenticatedUser) {
    const warehouseId = requireWarehouseId(warehouseReference, actor);
    const externalId = String(orderId);
    const existing = await this.findImportedOrder(warehouseId, externalId);
    if (existing) return { created: false, baseComOrderId: orderId, order: existing };

    const remote = await this.baseCom.getOrder(orderId);
    const lines = mapOrderLines(remote.products);

    try {
      return await withTransactionRetry(() => this.prisma.$transaction(async (tx) => {
        await lockPostgresAdvisoryTransaction(tx, 'base_com_order', externalId);
        const imported = await this.findImportedOrder(warehouseId, externalId, tx);
        if (imported) return { created: false, baseComOrderId: orderId, order: imported };

        await requireActiveSkus(tx, lines);
        await tx.externalSystem.createMany({
          data: [{ code: SYSTEM_CODE, name: 'Base.com', systemType: SYSTEM_CODE }],
          skipDuplicates: true,
        });
        const system = await tx.externalSystem.findUniqueOrThrow({ where: { code: SYSTEM_CODE } });
        if (system.systemType !== SYSTEM_CODE || system.status !== 'ACTIVE') {
          throw new ConflictException('The Base.com external system is inactive or has a different connector type.');
        }

        const order = await this.outbound.create(warehouseId, {
          orderNumber: `BASE-${externalId}`,
          ownerClientReference: system.ownerClientId ?? undefined,
          lines,
          metadata: { source: 'base.com', channel: 'Base.com', baseComOrderId: orderId },
        }, actor, tx);

        await tx.externalIdMapping.create({
          data: {
            externalSystemId: system.id,
            warehouseId,
            ownerClientId: system.ownerClientId,
            resourceType: RESOURCE_TYPE,
            resourceId: order.id,
            externalId,
          },
        });
        return { created: true, baseComOrderId: orderId, order };
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This Base.com order already has a WMS mapping.');
      }
      throw error;
    }
  }

  async syncDispatch(warehouseReference: string, orderId: number, actor: AuthenticatedUser) {
    const warehouseId = requireWarehouseId(warehouseReference, actor);
    const statusId = this.baseCom.shippedStatusId;
    if (!this.baseCom.configured || statusId === null) {
      throw new ServiceUnavailableException('Configure the Base.com token and shipped status before syncing dispatch.');
    }

    const externalId = String(orderId);
    // Serialize updates for this order so concurrent callers do not trigger the same status change twice.
    return this.prisma.$transaction(async (tx) => {
      await lockPostgresAdvisoryTransaction(tx, 'base_com_order', externalId);
      const order = await this.findImportedOrder(warehouseId, externalId, tx);
      if (!order) throw new NotFoundException('Import this Base.com order into the selected WMS warehouse first.');
      if (order.status !== OutboundStatus.SHIPPED || !order.shippedAt) {
        throw new UnprocessableEntityException('Dispatch the order in WMS before sending its status to Base.com.');
      }

      const remote = await this.baseCom.getOrder(orderId);
      const updated = remote.statusId !== statusId;
      if (updated) {
        await this.baseCom.setOrderStatus(orderId, statusId);
        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            warehouseId,
            action: 'base_com.dispatch_synced',
            resourceType: 'outbound_order',
            resourceId: order.id,
            metadata: { baseComOrderId: orderId, baseComStatusId: statusId },
          },
        });
      }
      return { updated, baseComOrderId: orderId, orderNumber: order.orderNumber, statusId };
    }, { timeout: BASE_COM_REQUEST_TIMEOUT_MS * 2 + 5_000 });
  }

  private async findImportedOrder(warehouseId: string, externalId: string, transaction?: Prisma.TransactionClient) {
    const db = transaction ?? this.prisma;
    const system = await db.externalSystem.findUnique({ where: { code: SYSTEM_CODE } });
    if (!system) return null;
    if (system.systemType !== SYSTEM_CODE || system.status !== 'ACTIVE') {
      throw new ConflictException('The Base.com external system is inactive or has a different connector type.');
    }

    const mapping = await db.externalIdMapping.findUnique({
      where: { externalSystemId_resourceType_externalId: {
        externalSystemId: system.id,
        resourceType: RESOURCE_TYPE,
        externalId,
      } },
    });
    if (!mapping) return null;
    if (mapping.warehouseId !== warehouseId) {
      throw new ConflictException('This Base.com order is already assigned to another warehouse.');
    }
    return this.outbound.findOne(warehouseId, mapping.resourceId, transaction);
  }
}

function requireWarehouseId(warehouseReference: string, actor: AuthenticatedUser): string {
  const warehouse = actor.warehouses.find(({ warehouseId, warehouseCode }) =>
    warehouseId === warehouseReference || warehouseCode === warehouseReference,
  );
  if (!warehouse) throw new ForbiddenException('The selected warehouse is not assigned to this user.');
  return warehouse.warehouseId;
}

function mapOrderLines(products: unknown) {
  if (!Array.isArray(products) || products.length === 0) {
    throw new UnprocessableEntityException('The Base.com order has no items to import.');
  }
  return products.map((product: unknown, index) => {
    const line = asRecord(product);
    const skuValue = line?.['sku'];
    const sku = typeof skuValue === 'string' ? skuValue.trim().toUpperCase() : '';
    const quantity = baseComInteger(line?.['quantity']);
    if (!sku || sku.length > 120 || quantity === null || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      throw new UnprocessableEntityException(`Base.com order line ${index + 1} needs a SKU and a valid positive quantity.`);
    }
    return { lineNumber: String(index + 1), sku, orderedQuantity: quantity };
  });
}

async function requireActiveSkus(tx: Prisma.TransactionClient, lines: ReturnType<typeof mapOrderLines>): Promise<void> {
  const codes = [...new Set(lines.map(({ sku }) => sku))];
  const active = await tx.sku.findMany({ where: { code: { in: codes }, status: 'ACTIVE' }, select: { code: true } });
  const activeCodes = new Set(active.map(({ code }) => code));
  const missingLines = lines.filter(({ sku }) => !activeCodes.has(sku));
  if (missingLines.length) {
    const lineNumbers = missingLines.slice(0, 5).map(({ lineNumber }) => lineNumber).join(', ');
    throw new UnprocessableEntityException(`Create or activate the matching WMS SKU for Base.com order line(s) ${lineNumbers}.`);
  }
}
