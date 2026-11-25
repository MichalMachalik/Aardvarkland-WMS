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

  async function request(path, body, expectedStatus, idempotencyKey = randomUUID()) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(root + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
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
  const own = (path, body, expectedStatus, idempotencyKey) => request(warehouse + path, body, expectedStatus, idempotencyKey);

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
      orderNumber: `SO-TEST-${run}`, recipientName: 'Test recipient', carrier: 'EXPRESS_CARRIER',
      lines: [{ lineNumber: '1', sku, orderedQuantity: 2 }],
    });
    await own(`/outbound-orders/${order.id}/allocate`, {});
    const release = await own(`/outbound-orders/${order.id}/release-picking`, {});
    assert.equal(release.order.status, 'PICKING');

    const picks = (await own(`/tasks?type=PICK&sku=${encodeURIComponent(sku)}`))
      .filter(task => task.outboundOrderId === order.id);
    assert.equal(picks.reduce((sum, task) => sum + task.quantity, 0), 2);
    for (const task of picks) {
      await own(`/tasks/${task.id}/confirm-pick`, { orderReference: order.id, lineReference: '1', quantity: task.quantity });
    }
    const picked = await own(`/outbound-orders/${order.id}`);
    assert.equal(picked.lines[0].pickedQuantity, 2);

    const shipment = await own('/shipments', {
      shipmentNumber: `SHP-TEST-${run}`, outboundOrderReference: order.id, packingStationReference: 'PACK-01',
    });
    const packagesPath = `/shipments/${shipment.id}/packages`;
    const content = { sku, outboundOrderLineReference: picked.lines[0].id };
    for (const quantity of [false, '', 0, 1.5, 2147483648]) {
      await own(packagesPath, { contents: [{ ...content, quantity }] }, 400);
    }
    await own(packagesPath, { contents: [{ ...content, quantity: 3 }] }, 409);
    assert.deepEqual(await own(packagesPath), []);
    const parcel = await own(packagesPath, {
      packageCode: `BOX-TEST-${run}`, weightGrams: 500,
      contents: [{ ...content, quantity: 2 }],
    });
    const parcelId = parcel.id ?? parcel.package?.id;
    assert.ok(parcelId);
    const [beforeLabel] = await own(packagesPath);
    assert.equal(beforeLabel.labelReady, false);
    assert.deepEqual(beforeLabel.contents, [{ sku, outboundOrderLineId: picked.lines[0].id, quantity: 2 }]);
    await own(`/shipments/${shipment.id}/stage`, {});
    const shipPath = `/shipments/${shipment.id}/ship`;
    await own(shipPath, {}, 409);
    const labelPath = `/shipments/${shipment.id}/labels`;
    const labelBody = { packageReference: parcelId, labelFormat: 'ZPL' };
    const labels = await Promise.all([own(labelPath, labelBody), own(labelPath, labelBody)]);
    assert.ok(labels[0].id, 'A label must be generated for the test parcel');
    assert.equal(labels[1].id, labels[0].id);
    const document = await own(`${labelPath}/${labels[0].id}/document`);
    assert.equal(document.format, 'ZPL');
    assert.match(document.content, /^\^XA[\s\S]*\^XZ$/);
    assert.ok(document.content.includes(labels[0].trackingNumber));
    assert.equal((await own(packagesPath))[0].label.status, 'GENERATED');
    const shipping = await Promise.allSettled([own(shipPath, {}), own(shipPath, {})]);
    const confirmed = shipping.filter(result => result.status === 'fulfilled');
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].value.status, 'SHIPPED');
    assert.match(shipping.find(result => result.status === 'rejected')?.reason?.message ?? '', /returned 409/);
    assert.equal((await own(`/outbound-orders/${order.id}`)).status, 'SHIPPED');
    assert.equal((await own(packagesPath))[0].label.status, 'GENERATED');
  });

  await context.test('inbound receipts stay consistent across retries, concurrent writes and active stock freezes', async () => {
    const testSku = `RECEIVE-SKU-${run}`;
    const product = await request('/products', { code: `RECEIVE-PRODUCT-${run}`, name: 'Receiving test product' });
    await request('/products/skus', { productReference: product.id, code: testSku, name: 'Receiving test SKU' });
    const collection = '/inbound-shipments';
    const create = (label, amounts) => own(collection, {
      shipmentNumber: `RECEIVE-${label}-${run}`,
      lines: amounts.map((expectedQuantity, index) => ({ lineNumber: String(index + 1), sku: testSku, expectedQuantity })),
    });
    const first = await create('PARTIAL', [4]);
    const second = await create('PARALLEL', [1, 1]);
    const frozen = await create('FROZEN', [1]);
    const receivePath = shipment => `${collection}/${shipment.id}/receive`;
    const state = shipment => own(`${collection}/${shipment.id}`);
    const baseReceipt = { lineReference: '1', locationReference: 'A-01-01', createPutawayTask: false };
    for (const quantity of [null, '', false, [], -1, 1.5, 2147483648]) {
      await own(receivePath(first), { ...baseReceipt, quantity }, 400);
    }
    await own(receivePath(first), { ...baseReceipt, quantity: 0 }, 409);
    await own(receivePath(first), { ...baseReceipt, quantity: 1, damagedQuantity: false }, 400);
    await own(receivePath(first), { ...baseReceipt, quantity: 2147483647, damagedQuantity: 1, allowOverReceive: true }, 409);
    assert.equal((await state(first)).lines[0].receivedQuantity, 0);

    const key = randomUUID();
    const receipt = { ...baseReceipt, quantity: 2, damagedQuantity: 1 };
    const [left, right] = await Promise.all([
      own(receivePath(first), receipt, 201, key),
      own(receivePath(first), receipt, 201, key),
    ]);
    assert.deepEqual(left.movements.map(movement => movement.id), right.movements.map(movement => movement.id));
    assert.equal(left.receivedQuantity, 2);
    assert.equal(left.damagedQuantity, 1);
    assert.equal((await state(first)).lines[0].receivedQuantity, 3);
    await own(receivePath(first), { ...receipt, quantity: 1 }, 409, key);
    await own(receivePath(second), receipt, 409, key);
    assert.equal((await state(second)).lines[0].receivedQuantity, 0);

    const competing = await Promise.allSettled([
      own(receivePath(first), { ...baseReceipt, quantity: 1 }),
      own(receivePath(first), { ...baseReceipt, quantity: 1 }),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(competing.find(result => result.status === 'rejected')?.reason?.message ?? '', /returned 409/);
    assert.equal((await state(first)).lines[0].receivedQuantity, 4);

    await Promise.all([
      own(receivePath(second), { ...baseReceipt, quantity: '1' }),
      own(receivePath(second), { ...baseReceipt, lineReference: '2', quantity: 1 }),
    ]);
    const completed = await state(second);
    assert.equal(completed.status, 'RECEIVED');
    assert.deepEqual(completed.lines.map(line => line.receivedQuantity), [1, 1]);
    assert.equal((await own(`/inventory/quants/${left.quant.id}`)).quantity, 5);

    const plan = await own('/cycle-counts', { code: `RECEIVE-COUNT-${run}`, scopeType: 'SKU', scopeReference: testSku });
    await own(`/cycle-counts/${plan.id}/release`, {});
    const frozenKey = randomUUID();
    await own(receivePath(frozen), { ...baseReceipt, quantity: 1 }, 409, frozenKey);
    assert.equal((await state(frozen)).lines[0].receivedQuantity, 0);
    const [count] = await own(`/cycle-counts/${plan.id}/tasks`);
    await own(`/cycle-counts/tasks/${count.id}/submit`, { countedQuantity: count.expectedQuantity });
    await own(`/cycle-counts/tasks/${count.id}/approve`, {});
    await own(receivePath(frozen), { ...baseReceipt, quantity: 1 }, 201, frozenKey);
    assert.equal((await own(`/inventory/quants/${left.quant.id}`)).quantity, 6);
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
