import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const base = process.env.WMS_E2E_WRITE_URL;

test('warehouse workflows on a disposable database', {
  skip: !base && 'WMS_E2E_WRITE_URL must point to a disposable seeded WMS instance',
  timeout: 60000,
}, async (context) => {
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Warehouse acceptance tests require a loopback instance');
  const root = url.href.replace(/\/+$/, '');
  const run = randomUUID().slice(0, 12);
  const warehouse = '/warehouses/MAIN';
  const sku = 'ABC-123';
  let token;

  async function request(path, body, expectedStatus) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(root + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    const message = `${method} ${path} returned ${response.status}: ${String(payload.message ?? '').slice(0, 250)}`;
    if (expectedStatus === undefined) assert.ok(response.ok, message);
    else assert.equal(response.status, expectedStatus, message);
    return payload.data ?? payload;
  }
  const own = (path, body, expectedStatus) => request(warehouse + path, body, expectedStatus);

  const worker = await request('/auth/login', {
    email: 'demo-skladnik@aardvarkland.local', password: 'Demo-Local-42!',
  });
  assert.ok(worker.accessToken);
  token = worker.accessToken;
  await own('/inventory/quants/adjust', { quantityDelta: 1 }, 403);

  const admin = await request('/auth/login', {
    email: 'admin@example.com', password: 'Local-Seed-42!',
  });
  assert.ok(admin.accessToken);
  token = admin.accessToken;

  await context.test('documented collection and health endpoints accept a seeded warehouse code', async () => {
    const { paths } = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
    const routes = Object.entries(paths)
      .filter(([path, methods]) => path.startsWith('/api/') && methods.get && !path.endsWith('/realtime/events'))
      .filter(([, methods]) => !(methods.get.parameters ?? []).some(param => param.in === 'query' && param.required))
      .map(([path]) => path.slice('/api'.length).replaceAll('{warehouseId}', 'MAIN'))
      .filter(path => !path.includes('{'));
    assert.ok(routes.length > 0);
    const failures = [];
    for (const path of routes) {
      try {
        const response = await fetch(root + path, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(7000),
        });
        await response.arrayBuffer();
        if (!response.ok) failures.push(`GET ${path} returned ${response.status}`);
      } catch (error) {
        failures.push(`GET ${path}: ${error.message}`);
      }
    }
    context.diagnostic(`Checked ${routes.length} OpenAPI GET routes`);
    assert.deepEqual(failures, []);
  });

  await context.test('receive, allocate, pick, pack, label, stage and ship', async () => {
    const inbound = await own('/inbound-shipments', {
      shipmentNumber: `ASN-TEST-${run}`, supplierName: 'Test supplier',
      lines: [{ lineNumber: '1', sku, expectedQuantity: 2 }],
    });
    await own(`/inbound-shipments/${inbound.id}/receive`, {
      lineReference: '1', quantity: 2, locationReference: 'A-01-01',
      completeLine: true, createPutawayTask: false,
    });
    const received = await own(`/inbound-shipments/${inbound.id}`);
    assert.equal(received.lines[0].receivedQuantity, 2);

    const order = await own('/outbound-orders', {
      orderNumber: `SO-TEST-${run}`, recipientName: 'Test recipient',
      lines: [{ lineNumber: '1', sku, orderedQuantity: 2 }],
    });
    const before = new Set((await own('/rf/queue?limit=100')).tasks.map(task => task.id));
    await own(`/outbound-orders/${order.id}/allocate`, {});
    const release = await own(`/outbound-orders/${order.id}/release-picking`, {});
    assert.equal(release.order.status, 'PICKING');

    const queue = await own('/rf/queue?limit=100');
    const picks = queue.tasks.filter(task => task.workflow === 'PICK' && !before.has(task.id));
    assert.equal(picks.reduce((sum, task) => sum + task.quantity, 0), 2);
    for (const task of picks) {
      await own(`/tasks/${task.id}/confirm-pick`, { orderReference: order.id, lineReference: '1', quantity: task.quantity });
    }
    const picked = await own(`/outbound-orders/${order.id}`);
    assert.equal(picked.lines[0].pickedQuantity, 2);

    const shipment = await own('/shipments', {
      shipmentNumber: `SHP-TEST-${run}`, outboundOrderReference: order.id, packingStationReference: 'PACK-01',
    });
    const parcel = await own(`/shipments/${shipment.id}/packages`, {
      packageCode: `BOX-TEST-${run}`, weightGrams: 500,
      contents: [{ sku, outboundOrderLineReference: picked.lines[0].id, quantity: 2 }],
    });
    const parcelId = parcel.id ?? parcel.package?.id;
    assert.ok(parcelId);
    const label = await own(`/shipments/${shipment.id}/labels`, { packageReference: parcelId, labelFormat: 'ZPL' });
    assert.ok(label.id, 'A label must be generated for the test parcel');
    await own(`/shipments/${shipment.id}/stage`, {});
    const shipped = await own(`/shipments/${shipment.id}/ship`, {});
    assert.equal(shipped.status, 'SHIPPED');
    assert.equal((await own(`/outbound-orders/${order.id}`)).status, 'SHIPPED');
  });

  await context.test('move and correct stock, then count and approve a variance', async () => {
    const countedSku = `COUNT-SKU-${run}`;
    const product = await request('/products', { code: `TEST-PRODUCT-${run}`, name: 'Inventory test product' });
    await request('/products/skus', { productReference: product.id, code: countedSku, name: 'Inventory test SKU' });
    const receipt = await own('/inventory/quants/receive', {
      skuReference: countedSku, locationReference: 'A-01-01', quantity: 5, status: 'AVAILABLE',
    });
    const sourceId = receipt.quant.id;
    assert.equal((await own(`/inventory/quants/${sourceId}`)).quantity, 5);

    const moved = await own('/inventory/quants/move', {
      quantReference: sourceId, toLocationReference: 'PACK-01', quantity: 2, status: 'AVAILABLE',
    });
    const destinationId = moved.quant.id;
    assert.equal((await own(`/inventory/quants/${sourceId}`)).quantity, 3);
    assert.equal((await own(`/inventory/quants/${destinationId}`)).quantity, 2);
    await own('/inventory/quants/adjust', {
      quantReference: destinationId, quantityDelta: 1, reasonCode: 'MANUAL_CORRECTION', reason: 'Test correction',
    });
    assert.equal((await own(`/inventory/quants/${destinationId}`)).quantity, 3);

    const plan = await own('/cycle-counts', {
      code: `COUNT-TEST-${run}`, scopeType: 'SKU', scopeReference: countedSku,
    });
    await own('/cycle-counts', { scopeType: 'SKU', scopeReference: ' ' }, 400);
    const overlapping = await own('/cycle-counts', {
      code: `COUNT-OVERLAP-${run}`, scopeType: 'SKU', scopeReference: countedSku,
    });
    const released = await own(`/cycle-counts/${plan.code}/release`, {});
    assert.equal(released.plan.status, 'RELEASED');
    assert.equal(released.tasksCreated, 2);
    await own(`/cycle-counts/${overlapping.id}/release`, {}, 409);
    assert.deepEqual(await own(`/cycle-counts/${overlapping.id}/tasks`), []);
    const tasks = await own(`/cycle-counts/${plan.id}/tasks`);
    const sourceTask = tasks.find(task => task.stockQuantId === sourceId);
    const destinationTask = tasks.find(task => task.stockQuantId === destinationId);
    assert.ok(sourceTask && destinationTask);
    await own('/inventory/quants/move', {
      quantReference: sourceId, toLocationReference: 'PACK-01', quantity: 1, status: 'AVAILABLE',
    }, 409);
    await own('/inventory/quants/receive', {
      skuReference: countedSku, locationReference: 'A-01-01', quantity: 1, status: 'AVAILABLE',
    }, 409);
    const submitPath = `/cycle-counts/tasks/${destinationTask.id}/submit`;
    for (const countedQuantity of [undefined, null, '', ' ', false, [], -1, 1.5, 2147483648]) {
      await own(submitPath, { countedQuantity }, 400);
    }
    assert.equal((await own(`/cycle-counts/${plan.id}/tasks`)).find(task => task.id === destinationTask.id).status, 'OPEN');
    const submissions = await Promise.allSettled([
      own(submitPath, { countedQuantity: 4 }),
      own(submitPath, { countedQuantity: '4' }),
    ]);
    const accepted = submissions.filter(result => result.status === 'fulfilled');
    const rejected = submissions.filter(result => result.status === 'rejected');
    assert.equal(accepted.length, 1, JSON.stringify(submissions));
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /returned 409/);
    const counted = accepted[0].value;
    assert.equal(counted.varianceQuantity, 1);
    assert.equal((await own(`/inventory/quants/${destinationId}`)).quantity, 3);
    const approvalPath = `/cycle-counts/tasks/${destinationTask.id}/approve`;
    const approvals = await Promise.allSettled([own(approvalPath, {}), own(approvalPath, {})]);
    const successes = approvals.filter(result => result.status === 'fulfilled');
    const conflicts = approvals.filter(result => result.status === 'rejected');
    assert.equal(successes.length, 1, JSON.stringify(approvals));
    assert.equal(successes[0].value.adjustmentCreated, true);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].reason.message, /returned 409/);
    assert.equal((await own(`/inventory/quants/${destinationId}`)).quantity, 4);
    try {
      token = worker.accessToken;
      const rfPath = '/rf/sessions';
      const instruction = await own(rfPath, { taskReference: sourceTask.warehouseTaskId });
      assert.equal(instruction.task.quantity, null);
      const scan = `${rfPath}/${instruction.sessionId}/scan`;
      await own(scan, { scannedValue: 'A-01-01' });
      const countInstruction = await own(scan, { scannedValue: countedSku });
      assert.equal(countInstruction.step.key, 'CONFIRM_QUANTITY');
      assert.equal(countInstruction.step.expected.value, null);
      await own(scan, { scannedValue: '2147483648' }, 409);
      const completed = await own(scan, { scannedValue: '3' });
      assert.equal(completed.status, 'COMPLETED');
    } finally {
      token = admin.accessToken;
    }
    const finalApproval = await own(`/cycle-counts/tasks/${sourceTask.id}/approve`, {});
    assert.equal(finalApproval.adjustmentCreated, false);
    assert.equal(finalApproval.planCompleted, true);
  });
});
