const DATABASE_NAME = 'aardvarkland-wms-rf';
const DATABASE_VERSION = 1;
const STORE_NAME = 'offline-scans';
const LEGACY_STORAGE_KEY = 'wms-rf-offline-queue-v2';
const FALLBACK_STORAGE_KEY = 'wms-rf-offline-queue-v3';
const FALLBACK_RECORD_PREFIX = 'wms-rf-offline-queue-v4';
const QUEUE_LOCK = 'wms-rf-offline-queue';

export interface StoredRfOfflineScan {
  idempotencyKey: string;
  warehouseId: string;
  sessionReference?: string;
  taskReference?: string;
  stepKey?: string;
  scannedValue: string;
  quantity?: number;
  recordedAt: string;
  metadata: Record<string, unknown>;
  replayFailed?: boolean;
}

type UpdateQueue = (scans: StoredRfOfflineScan[]) => StoredRfOfflineScan[];
type QueueChange = { scan: StoredRfOfflineScan } | { confirmed: string[]; failed: string[] };

// Persist each user-acknowledged scan before indicating success in the scanner UI.
const warehouseOperations = new Map<string, Promise<void>>();

function serializeWarehouse<T>(warehouseId: string, work: () => Promise<T>): Promise<T> {
  // The queue and its legacy keys are shared by every tab on the same origin.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(QUEUE_LOCK, work);
  }
  const previous = warehouseOperations.get(warehouseId) ?? Promise.resolve();
  const operation = previous.then(work, work);
  warehouseOperations.set(warehouseId, operation.then(() => undefined, () => undefined));
  return operation;
}

export function loadRfOfflineQueue(warehouseId: string): Promise<StoredRfOfflineScan[]> {
  const normalizedWarehouse = normalizeWarehouse(warehouseId);
  return serializeWarehouse(normalizedWarehouse, () => accessRfOfflineQueue(normalizedWarehouse));
}

async function accessRfOfflineQueue(warehouseId: string, change?: QueueChange): Promise<StoredRfOfflineScan[]> {
  const storage = window.localStorage;
  const prefix = `${FALLBACK_RECORD_PREFIX}:${encodeURIComponent(warehouseId)}:`;
  const activeKey = `${prefix}active`;
  const legacy = loadFallbackQueue(storage, warehouseId);
  let useFallback = legacy !== null || storage.getItem(activeKey) !== null;
  let primary: StoredRfOfflineScan[] = [];
  let primaryCommitted = false;

  try {
    const database = await openDatabase();
    try {
      await migrateLegacyQueue(database, warehouseId);
      primary = await transactWarehouseQueue(database, warehouseId, change && !useFallback ? stored => {
        primary = stored;
        useFallback = storage.getItem(activeKey) !== null;
        return useFallback ? stored : applyChange(stored, change);
      } : undefined);
      // If another tab activated the fallback after our commit, this change is
      // already durable in IndexedDB. The combined view still includes it.
      primaryCommitted = !useFallback;
      if (primaryCommitted && storage.getItem(activeKey) === null) return primary;
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'RF_OFFLINE_DATABASE_CORRUPT') throw error;
  }

  // Keep fallback records as a separate source after IndexedDB recovers.
  // Copying and deleting them across stores would race another tab's updates.
  storage.setItem(activeKey, '1');
  if (change && !primaryCommitted) writeFallbackChange(storage, prefix, change);
  return readFallbackRecords(storage, prefix, warehouseId, mergeScans(primary, legacy ?? []));
}

export function appendRfOfflineScan(
  warehouseId: string,
  scan: StoredRfOfflineScan,
): Promise<StoredRfOfflineScan[]> {
  const normalizedWarehouse = normalizeWarehouse(warehouseId);
  return serializeWarehouse(normalizedWarehouse, () =>
    accessRfOfflineQueue(normalizedWarehouse, { scan: { ...scan, warehouseId: normalizedWarehouse } }));
}

export function applyRfOfflineResults(
  warehouseId: string,
  confirmedIdempotencyKeys: string[],
  failedIdempotencyKeys: string[] = [],
): Promise<StoredRfOfflineScan[]> {
  const normalizedWarehouse = normalizeWarehouse(warehouseId);
  return serializeWarehouse(normalizedWarehouse, () =>
    accessRfOfflineQueue(normalizedWarehouse, { confirmed: confirmedIdempotencyKeys, failed: failedIdempotencyKeys }));
}

function applyChange(stored: StoredRfOfflineScan[], change: QueueChange): StoredRfOfflineScan[] {
  if ('scan' in change) return mergeScans(stored, [change.scan]);

  const confirmed = new Set(change.confirmed);
  const failed = new Set(change.failed);
  return sortAndLimit(stored.filter(scan => !confirmed.has(scan.idempotencyKey))
    .map(scan => failed.has(scan.idempotencyKey) ? { ...scan, replayFailed: true } : scan));
}

function mergeScans(...groups: StoredRfOfflineScan[][]): StoredRfOfflineScan[] {
  const merged = new Map<string, StoredRfOfflineScan>();
  for (const group of groups) for (const scan of group) merged.set(scan.idempotencyKey, scan);
  return sortAndLimit([...merged.values()]);
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'idempotencyKey' });
        store.createIndex('warehouseId', 'warehouseId', { unique: false });
        store.createIndex('recordedAt', 'recordedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
  });
}

function transactWarehouseQueue(
  database: IDBDatabase,
  warehouseId: string,
  update?: UpdateQueue,
): Promise<StoredRfOfflineScan[]> {
  return new Promise((resolve, reject) => {
    // Keep the read and write together so another tab cannot replace a stale snapshot.
    const transaction = database.transaction(STORE_NAME, update ? 'readwrite' : 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index('warehouseId').getAll(warehouseId);
    let next: StoredRfOfflineScan[] = [];
    let updateError: unknown;

    request.onsuccess = () => {
      try {
        const current = normalizeScans(request.result);
        if (current.length !== request.result.length) throw new Error('RF_OFFLINE_DATABASE_CORRUPT');
        if (!update) {
          next = sortAndLimit(current);
          return;
        }
        const prior = new Map(current.map(scan => [scan.idempotencyKey, scan]));
        next = update(current);
        for (const scan of next) {
          if (prior.get(scan.idempotencyKey) !== scan) store.put(scan);
          prior.delete(scan.idempotencyKey);
        }
        for (const key of prior.keys()) store.delete(key);
      } catch (error) {
        updateError = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onabort = () => reject(updateError ?? transaction.error ?? new Error('Offline queue transaction was aborted'));
  });
}

async function migrateLegacyQueue(database: IDBDatabase, warehouseId: string): Promise<void> {
  if (typeof window === 'undefined') return;

  let legacy: unknown;
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    legacy = JSON.parse(raw);
  } catch {
    return;
  }

  const scans = normalizeScans(legacy).map((scan) => ({ ...scan, warehouseId }));
  if (scans.length > 0) {
    await transactWarehouseQueue(database, warehouseId, current => mergeScans(current, scans));
  }

  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // IndexedDB migration already succeeded; stale fallback cleanup is best effort.
  }
}

function loadFallbackQueue(storage: Storage, warehouseId: string): StoredRfOfflineScan[] | null {
  try {
    const raw = storage.getItem(`${FALLBACK_STORAGE_KEY}:${warehouseId}`);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('RF_OFFLINE_FALLBACK_CORRUPT');
    const normalized = normalizeScans(parsed).map((scan) => ({ ...scan, warehouseId }));
    if (normalized.length !== parsed.length) throw new Error('RF_OFFLINE_FALLBACK_CORRUPT');
    return sortAndLimit(normalized);
  } catch {
    throw new Error('RF_OFFLINE_FALLBACK_UNREADABLE');
  }
}

function writeFallbackChange(storage: Storage, prefix: string, change: QueueChange): void {
  if ('scan' in change) {
    const [scan] = normalizeScans([change.scan]);
    if (!scan) throw new Error('RF_OFFLINE_SCAN_INVALID');
    storage.setItem(fallbackRecordKey(prefix, 'scan', scan.idempotencyKey), JSON.stringify(scan));
    return;
  }
  const confirmed = new Set(change.confirmed);
  for (const id of change.failed) {
    if (!confirmed.has(id)) storage.setItem(fallbackRecordKey(prefix, 'failed', id), '1');
  }
  for (const id of confirmed) {
    const key = fallbackRecordKey(prefix, 'scan', id);
    if (storage.getItem(key) === null) {
      // An older scan can still be present in IndexedDB or the legacy snapshot.
      storage.setItem(fallbackRecordKey(prefix, 'confirmed', id), '1');
    } else {
      storage.removeItem(key);
    }
    storage.removeItem(fallbackRecordKey(prefix, 'failed', id));
  }
}

function readFallbackRecords(
  storage: Storage, prefix: string, warehouseId: string, stored: StoredRfOfflineScan[],
): StoredRfOfflineScan[] {
  const records: StoredRfOfflineScan[] = [];
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(`${prefix}scan:`)) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const [scan] = normalizeScans([JSON.parse(value)]);
    if (!scan || scan.warehouseId !== warehouseId || fallbackRecordKey(prefix, 'scan', scan.idempotencyKey) !== key) {
      throw new Error('RF_OFFLINE_FALLBACK_CORRUPT');
    }
    records.push(scan);
  }
  return mergeScans(stored, records)
    .filter(scan => storage.getItem(fallbackRecordKey(prefix, 'confirmed', scan.idempotencyKey)) === null)
    .map(scan => storage.getItem(fallbackRecordKey(prefix, 'failed', scan.idempotencyKey)) === null
      ? scan : { ...scan, replayFailed: true });
}

function normalizeScans(value: unknown): StoredRfOfflineScan[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const scan = entry as Record<string, unknown>;
    const idempotencyKey = stringValue(scan['idempotencyKey']);
    const scannedValue = stringValue(scan['scannedValue']);
    const recordedAt = stringValue(scan['recordedAt']);
    if (!idempotencyKey || !scannedValue || !recordedAt) return [];

    return [{
      idempotencyKey,
      warehouseId: normalizeWarehouse(stringValue(scan['warehouseId']) || 'MAIN'),
      sessionReference: optionalString(scan['sessionReference']),
      taskReference: optionalString(scan['taskReference']),
      stepKey: optionalString(scan['stepKey']),
      scannedValue,
      quantity: numberValue(scan['quantity']),
      recordedAt,
      metadata: objectValue(scan['metadata']),
      replayFailed: scan['replayFailed'] === true || undefined,
    }];
  });
}

function sortAndLimit(scans: StoredRfOfflineScan[]): StoredRfOfflineScan[] {
  // Never discard an unacknowledged operation. Storage failure is explicit.
  return [...scans].sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
}

function normalizeWarehouse(value: string): string {
  return value.trim().toUpperCase() || 'MAIN';
}

function fallbackRecordKey(prefix: string, kind: 'scan' | 'confirmed' | 'failed', id: string): string {
  return `${prefix}${kind}:${encodeURIComponent(id)}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
