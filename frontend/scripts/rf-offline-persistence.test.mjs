import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/scanning/rfOfflineQueue.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function memoryStorage(denyWrites = false) {
  return Object.create({
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; },
    setItem(key, value) {
      if (denyWrites) throw new Error('QuotaExceededError');
      this[key] = String(value);
    },
    removeItem(key) { delete this[key]; },
  });
}

function harness({ storage = memoryStorage(), locks } = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, window: { localStorage: storage }, navigator: { locks }, Map, Date, Promise,
  });
  return { api: exports, storage };
}
function scan(n) {
  return {
    idempotencyKey: 'key-' + n, warehouseId: 'MAIN',
    scannedValue: 'SKU-' + n, recordedAt: new Date(2026, 9, 27, 0, 0, n).toISOString(),
    metadata: {},
  };
}

test('501 offline scans persist and recover without silently dropping the oldest', async () => {
  const { api, storage } = harness();
  storage.setItem('wms-rf-offline-queue-v3:MAIN', JSON.stringify(Array.from({ length: 501 }, (_, i) => scan(i))));
  const loaded = await api.loadRfOfflineQueue('MAIN');
  assert.equal(loaded.length, 501);
  assert.ok(loaded.some((item) => item.idempotencyKey === 'key-0'));
  await api.appendRfOfflineScan('MAIN', scan(501));
  assert.equal((await api.loadRfOfflineQueue('MAIN')).length, 502);
  await api.applyRfOfflineResults('MAIN', ['key-500'], ['key-0']);
  const remaining = await api.loadRfOfflineQueue('MAIN');
  assert.equal(remaining.length, 501);
  assert.ok(remaining.some((item) => item.idempotencyKey === 'key-501'));
  assert.equal(remaining.find(item => item.idempotencyKey === 'key-0').replayFailed, true);
});

test('no local storage can accept writes: user must receive a persistence error', async () => {
  const { api } = harness({ storage: memoryStorage(true) });
  await assert.rejects(api.appendRfOfflineScan('MAIN', scan(1)), /QuotaExceededError/);
});

test('tabs share a storage lock for offline writes and acknowledgments', async () => {
  const storage = memoryStorage();
  const pending = new Map();
  const locks = {
    request(name, action) {
      const previous = pending.get(name) ?? Promise.resolve();
      const operation = previous.then(action, action);
      pending.set(name, operation);
      return operation;
    },
  };
  const { api: firstTab } = harness({ storage, locks });
  const { api: secondTab } = harness({ storage, locks });
  assert.equal((await firstTab.loadRfOfflineQueue('MAIN')).length, 0);
  await Promise.all([
    firstTab.appendRfOfflineScan('MAIN', scan(1)),
    secondTab.appendRfOfflineScan('MAIN', scan(2)),
  ]);
  const keys = async () => Array.from(await firstTab.loadRfOfflineQueue('MAIN'), entry => entry.idempotencyKey).sort();
  assert.deepEqual(await keys(), ['key-1', 'key-2']);
  await Promise.all([
    secondTab.applyRfOfflineResults('MAIN', ['key-1']),
    firstTab.appendRfOfflineScan('MAIN', scan(3)),
  ]);
  assert.deepEqual(await keys(), ['key-2', 'key-3']);
});
