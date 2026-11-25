import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as responseValues from '../src/core/api/response-values.ts';

const source = await readFile(new URL('../src/core/api/scanner-view.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  require(specifier) {
    assert.equal(specifier, './response-values');
    return responseValues;
  },
});
const { mapScanners } = exports;

test('current scanner telemetry keeps a zero ahead of older metadata', () => {
  const lastActivityAt = '2026-11-01T12:30:00.000Z';
  const [scanner] = mapScanners([{
    id: 'scanner-id', code: 'RF-01', name: 'Receiving scanner', status: 'ACTIVE',
    batteryLevel: 0, signalStrength: 100, lastActivityAt,
    metadata: { batteryLevel: 55, signalStrength: 40, lastActivityAt: '2026-11-01T12:00:00.000Z' },
  }]);
  assert.equal(scanner.id, 'scanner-id');
  assert.equal(scanner.batteryLevel, 0);
  assert.equal(scanner.signalStrength, 100);
  assert.equal(scanner.lastActivityAt, lastActivityAt);
});

test('legacy scanner responses display available measurements and ignore invalid telemetry', () => {
  const timestamp = '2026-11-01T12:00:00.000Z';
  const scanners = mapScanners({ data: [
    {}, { code: ' ' },
    { code: 'RF-LEGACY', lastActivityAt: 'invalid', metadata: {
      batteryLevel: 29, signalStrength: '12', lastActivityAt: timestamp, assignedWorkerId: 'operator-fixture',
    } },
    { code: 'RF-SPARE', batteryLevel: 105, signalStrength: 15.5, lastSeenAt: timestamp },
    { code: 'RF-NEW' },
  ] });
  assert.equal(scanners.length, 3);
  const [legacy, spare, fresh] = scanners;
  assert.equal(legacy.id, 'RF-LEGACY');
  assert.equal(legacy.name, 'RF-LEGACY');
  assert.equal(legacy.batteryLevel, 29);
  assert.equal(legacy.signalStrength, null);
  assert.equal(legacy.lastActivityAt, timestamp);
  assert.equal(legacy.assignedWorkerId, 'operator-fixture');
  assert.equal(spare.batteryLevel, null);
  assert.equal(spare.signalStrength, null);
  assert.equal(spare.lastActivityAt, timestamp);
  assert.equal(fresh.lastActivityAt, null);
});
