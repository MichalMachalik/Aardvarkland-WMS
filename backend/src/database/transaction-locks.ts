import { ConflictException } from '@nestjs/common';

export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const SAFE_TABLE_NAMES = new Set([
  'skus',
  'stock_quants',
  'reservations',
  'outbound_orders',
  'warehouse_tasks',
  'warehouse_orders',
  'replenishment_rules',
  'cycle_count_plans',
  'inbound_shipments',
  'shipments',
  'return_orders',
  'pick_waves',
  'pick_carts',
  'billing_events',
  'billing_invoices',
  'scanner_sessions',
]);
const SAFE_ADVISORY_LOCK_NAMESPACES = new Set([
  'stock_quant_identity',
  'idempotency_key',
  'outbox_delivery',
  'base_com_order',
]);

export function canRunRawSql(client: unknown): client is RawSqlClient {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as Partial<RawSqlClient>).$queryRawUnsafe === 'function'
  );
}

export async function lockPostgresRowById(
  client: unknown,
  tableName: string,
  id: string,
): Promise<void> {
  if (!SAFE_TABLE_NAMES.has(tableName)) {
    throw new ConflictException(`Unsafe lock target: ${tableName}`);
  }

  if (!canRunRawSql(client)) {
    return;
  }

  await client.$queryRawUnsafe(`SELECT id FROM ${tableName} WHERE id = $1::uuid FOR UPDATE`, id);
}

export async function lockPostgresRowsById(client: unknown, tableName: string, ids: string[]): Promise<void> {
  if (!SAFE_TABLE_NAMES.has(tableName)) {
    throw new ConflictException(`Unsafe lock target: ${tableName}`);
  }
  if (!ids.length || !canRunRawSql(client)) return;

  await client.$queryRawUnsafe(`SELECT id FROM ${tableName} WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids);
}

export async function lockPostgresAdvisoryTransaction(
  client: unknown,
  namespace: string,
  key: string,
): Promise<void> {
  if (!SAFE_ADVISORY_LOCK_NAMESPACES.has(namespace)) {
    throw new ConflictException(`Unsafe advisory lock namespace: ${namespace}`);
  }

  if (!canRunRawSql(client)) {
    return;
  }

  await client.$queryRawUnsafe(
    'WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))) SELECT 1::int AS locked FROM locked',
    namespace,
    key,
  );
}
