import { PrismaService } from '../database';

export function captureDailyStorageOccupancy(prisma: PrismaService): Promise<number> {
  // The capture marker and all its stock rows share one database statement and snapshot.
  return prisma.$executeRaw`
    WITH captures AS (
      INSERT INTO storage_occupancy_captures (warehouse_id, client_id, snapshot_date)
      SELECT cw.warehouse_id, cw.client_id, (statement_timestamp() AT TIME ZONE 'UTC')::date
      FROM client_warehouses cw
      JOIN warehouses w ON w.id = cw.warehouse_id
      ORDER BY cw.warehouse_id, cw.client_id
      ON CONFLICT (warehouse_id, client_id, snapshot_date) DO NOTHING
      RETURNING warehouse_id, client_id, snapshot_date
    )
    INSERT INTO storage_occupancy_snapshots
      (id, warehouse_id, client_id, snapshot_date, sku_id, location_id, stock_quant_id, quantity, metadata)
    SELECT gen_random_uuid(), q.warehouse_id, c.client_id, c.snapshot_date,
           q.sku_id, q.location_id, q.id, q.quantity,
           jsonb_build_object('skuCode', s.code, 'locationCode', loc.code)
    FROM stock_quants q
    LEFT JOIN client_resource_links l
      ON q.owner_client_id IS NULL AND l.warehouse_id = q.warehouse_id
      AND l.resource_type = 'STOCK_QUANT' AND l.resource_id = q.id::text
    JOIN captures c ON c.warehouse_id = q.warehouse_id AND c.client_id = COALESCE(q.owner_client_id, l.client_id)
    JOIN skus s ON s.id = q.sku_id
    JOIN warehouse_locations loc ON loc.id = q.location_id
    WHERE q.quantity > 0
    ON CONFLICT (warehouse_id, client_id, sku_id, location_id, stock_quant_id, snapshot_date) DO NOTHING
  `;
}
