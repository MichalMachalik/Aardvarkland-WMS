import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const warehouse = '/api/warehouses/MAIN';

export async function runWriteScenarios(suite, { asAdmin, asManager, asWorker, bind, request, login, prisma }) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const own = (method, path, ...args) => asAdmin(method, warehouse + path, ...args);
  let scenarios = 0;
  async function scenario(name, run) {
    await suite.test(name, async () => {
      await run();
      scenarios++;
    });
  }

  async function createSku(group) {
    const product = await asAdmin('POST', '/api/products', { code: `TEST-${group}-${suffix}`, name: 'Test product' });
    const sku = await asAdmin('POST', '/api/products/skus', {
      productReference: product.id, code: `SKU-${group}-${suffix}`, name: 'Test SKU',
    });
    return { product, sku };
  }

  await scenario('product and warehouse master data persist and reject invalid input', async () => {
    const { product, sku } = await createSku('CAT');
    await asAdmin('POST', '/api/products', { code: product.code, name: 'Duplicate' }, 409);
    await asAdmin('PATCH', `/api/products/${product.id}`, { name: 'Renamed product' });
    assert.equal((await asAdmin('GET', `/api/products/${product.code}`)).name, 'Renamed product');
    await asAdmin('PATCH', `/api/products/skus/${sku.id}`, { weightGrams: -1 }, 400);
    await asAdmin('PATCH', `/api/skus/${sku.id}`, { weightGrams: 125 });
    assert.equal((await asAdmin('GET', `/api/skus/${sku.code}`)).weightGrams, 125);
    const category = await asAdmin('POST', '/api/product-master/categories', { code: `C-${suffix}`, name: 'Test category' });
    await asAdmin('POST', `/api/product-master/products/${product.code}/categories`, {
      categoryReference: category.code, isPrimary: true,
    });
    const categories = await asAdmin('GET', `/api/product-master/products/${product.id}/categories`);
    assert.equal(categories.length, 1);
    const uom = await asAdmin('POST', '/api/product-master/uoms', { code: `U-${suffix}`, name: 'Test unit' });
    const pack = await asAdmin('POST', '/api/product-master/uoms', { code: `P-${suffix}`, name: 'Test pack' });
    const conversion = { fromUom: pack.code, toUom: uom.code, multiplier: 6 };
    await asAdmin('POST', '/api/product-master/uom-conversions', { ...conversion, multiplier: 0 }, 400);
    assert.equal(Number((await asAdmin('POST', '/api/product-master/uom-conversions', conversion)).multiplier), 6);
    const barcode = `SKU-TEST-${suffix}`;
    await asAdmin('POST', `/api/product-master/skus/${sku.code}/barcodes`, { barcode, isPrimary: true });
    const barcodes = await asAdmin('GET', `/api/product-master/skus/${sku.id}/barcodes`);
    assert.ok(barcodes.some(item => item.barcode === barcode));

    const locationBody = { code: `LOC-${suffix}`, name: 'Test location', type: 'STORAGE', parentReference: 'A-01' };
    const location = await own('POST', '/locations', locationBody);
    await own('POST', '/locations', locationBody, 409);
    await asWorker('PATCH', `${warehouse}/locations/${location.id}`, { name: 'Forbidden' }, 403);
    await own('PATCH', `/locations/${location.id}`, { name: 'Renamed location', capacityUnits: 42 });
    const savedLocation = await own('GET', `/locations/${location.code}`);
    assert.equal(savedLocation.name, 'Renamed location');
    assert.equal(savedLocation.capacity.units, 42);
  });

  await scenario('product master preserves storage, ownership, documents and one default package', async () => {
    const { product, sku } = await createSku('DETAILS');
    const productPath = `/api/product-master/products/${product.code}`;
    const skuPath = `/api/product-master/skus/${sku.code}`;
    const requirements = `${skuPath}/storage-requirements`;
    const stored = await asAdmin('PUT', requirements, {
      temperatureMinCelsius: 2, temperatureMaxCelsius: 8, fragile: true, stackable: false,
    });
    await asAdmin('PUT', requirements, { temperatureMinCelsius: 9, temperatureMaxCelsius: 3 }, 409);
    const storage = await prisma.skuStorageRequirement.findUniqueOrThrow({ where: { skuId: sku.id } });
    assert.equal(storage.id, stored.id);
    assert.equal(Number(storage.temperatureMinCelsius), 2);
    assert.equal(Number(storage.temperatureMaxCelsius), 8);
    assert.equal(storage.fragile, true);
    assert.equal(storage.stackable, false);

    const client = await asAdmin('POST', '/api/clients', { code: `DETAILS-${suffix}`, name: 'Product client fixture' });
    await asAdmin('POST', `${productPath}/clients`, { clientReference: `NO-CLIENT-${suffix}` }, 404);
    const ownership = await asAdmin('POST', `${productPath}/clients`, {
      clientReference: client.code, externalArticleNumber: '  PART-1  ',
    });
    const amended = await asAdmin('POST', `${productPath}/clients`, {
      clientReference: client.id, externalArticleNumber: 'PART-2',
    });
    assert.equal(amended.id, ownership.id);
    assert.equal((await prisma.productClientOwnership.findUniqueOrThrow({ where: { id: ownership.id } })).externalArticleNumber, 'PART-2');

    const docsPath = `${productPath}/documents`;
    const documentBody = {
      documentType: 'OTHER', title: 'Product test sheet', uri: 'https://files.example.invalid/sheet.pdf',
      mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64),
    };
    await asWorker('POST', docsPath, documentBody, 403);
    await asAdmin('POST', docsPath, { ...documentBody, documentType: 'UNKNOWN' }, 400);
    const document = await asAdmin('POST', docsPath, documentBody);
    assert.ok((await asAdmin('GET', docsPath)).some(entry =>
      entry.id === document.id && entry.uri === documentBody.uri && entry.checksumSha256 === documentBody.checksumSha256));

    const packagesPath = `${skuPath}/packaging-levels`;
    const each = { levelCode: 'EACH', uom: 'EA', unitsPerLevel: 1, isDefault: true };
    const box = { levelCode: 'BOX', uom: 'EA', unitsPerLevel: 6, parentLevelCode: 'EACH' };
    const pallet = { levelCode: 'PALLET', uom: 'EA', unitsPerLevel: 36, parentLevelCode: 'BOX' };
    await asAdmin('POST', packagesPath, each);
    await asAdmin('POST', packagesPath, { ...box, parentLevelCode: 'MISSING' }, 409);
    await asAdmin('POST', packagesPath, { ...box, isDefault: true });
    assert.deepEqual((await asAdmin('GET', packagesPath)).filter(level => level.isDefault).map(level => level.levelCode), ['BOX']);
    await asAdmin('POST', packagesPath, { ...each, unitsPerLevel: 7 }, 409);
    await Promise.all([
      asAdmin('POST', packagesPath, { ...pallet, isDefault: true }),
      asAdmin('POST', packagesPath, each),
    ]);
    const levels = await asAdmin('GET', packagesPath);
    assert.deepEqual(levels.map(level => [level.levelCode, level.unitsPerLevel]), [['EACH', 1], ['BOX', 6], ['PALLET', 36]]);
    assert.equal(levels.filter(level => level.isDefault).length, 1);
  });

  await scenario('stock receipts replay exactly once and moving blocked stock preserves the hold', async () => {
    const { sku } = await createSku('STOCK');
    const receipt = { skuReference: sku.code, locationReference: 'A-01-01', quantity: 4 };
    const path = `${warehouse}/inventory/quants/receive`;
    const key = randomUUID();
    await asAdmin('POST', path, receipt, 428, null);
    await asAdmin('POST', path, { ...receipt, quantity: 0 }, 400);
    const received = await asAdmin('POST', path, receipt, 201, key);
    const replay = await asAdmin('POST', path, receipt, 201, key);
    assert.equal(replay.movement.id, received.movement.id);
    await asAdmin('POST', path, { ...receipt, quantity: 5 }, 409, key);
    const quantId = received.quant.id;
    assert.equal((await own('GET', `/inventory/quants/${quantId}`)).quantity, 4);
    const blocked = await own('POST', `/inventory/quants/${quantId}/block`, { quantity: 4, reason: 'Test hold' });
    const blockedId = blocked.quant.id;
    assert.equal((await own('GET', `/inventory/quants/${blockedId}`)).status, 'BLOCKED');
    await own('POST', '/inventory/quants/move', { quantReference: blockedId, toLocationReference: 'PACK-01', quantity: 5 }, 409);
    const moved = await own('POST', '/inventory/quants/move', {
      quantReference: blockedId, toLocationReference: 'PACK-01', quantity: 1, status: 'AVAILABLE',
    });
    const movedStock = await own('GET', `/inventory/quants/${moved.quant.id}`);
    assert.equal(movedStock.status, 'BLOCKED');
    assert.equal(movedStock.availableQuantity, 0);
    const released = await own('POST', `/inventory/quants/${blockedId}/unblock`, { quantity: 3, reason: 'Test release' });
    const saved = await own('GET', `/inventory/quants/${released.quant.id}`);
    assert.equal(saved.status, 'AVAILABLE');
    assert.equal(saved.quantity, 3);
  });

  await scenario('warehouse tasks claim available work and apply terminal transitions once', async () => {
    const zone = `TASK-${suffix}`;
    const location = await own('POST', '/locations', {
      code: zone, zone, name: 'Task fixture location', type: 'STORAGE', parentReference: 'A-01',
    });
    const body = { type: 'PACK', fromLocationReference: location.id };
    const claim = { type: body.type, zone: location.zone };
    const change = (id, action, data = {}, status = 201) => own('POST', `/tasks/${id}/${action}`, data, status);
    await own('POST', '/tasks', { ...body, status: 'DONE' }, 409);
    await own('POST', '/tasks', { ...body, quantity: 0 }, 400);
    await own('POST', '/tasks', { ...body, quantity: 2_147_483_648 }, 400);
    await own('POST', '/tasks/claim-next', claim, 404);

    const first = await own('POST', '/tasks', body);
    const second = await own('POST', '/tasks', body);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM warehouse_tasks WHERE id = ${first.id}::uuid FOR UPDATE`;
      const claimed = await own('POST', '/tasks/claim-next', claim);
      assert.equal(claimed.id, second.id);
      assert.equal(claimed.status, 'ASSIGNED');
      assert.ok(claimed.assignedUserId);
      assert.equal(claimed.version, second.version + 1);
    }, { timeout: 12000 });
    assert.equal((await own('POST', '/tasks/claim-next', claim)).id, first.id);
    await own('POST', '/tasks/claim-next', claim, 404);

    const task = await own('POST', '/tasks', body);
    await change(task.id, 'confirm', {}, 409);
    const assigned = await change(task.id, 'assign');
    assert.ok(assigned.assignedAt);
    const started = await change(task.id, 'start');
    assert.equal(started.assignedAt, assigned.assignedAt);
    assert.ok(started.startedAt);
    await change(task.id, 'fail', { reason: '   ' }, 409);
    await change(task.id, 'confirm', { quantity: 0 }, 400);
    await change(task.id, 'confirm', { quantity: 2_147_483_648 }, 400);

    await Promise.all([
      change(task.id, 'confirm', { quantity: 1 }, [201, 409]),
      change(task.id, 'cancel', { reason: 'Concurrent cancellation' }, [201, 409]),
    ]);
    const saved = await own('GET', `/tasks/${task.id}`);
    assert.ok(['DONE', 'CANCELLED'].includes(saved.status));
    assert.equal(saved.version, started.version + 1);
    if (saved.status === 'DONE') assert.equal(saved.quantity, 1);
    const terminalAudits = await prisma.auditLog.findMany({
      where: { resourceId: task.id, action: { in: ['warehouse_task.confirmed', 'warehouse_task.cancelled'] } },
    });
    assert.equal(terminalAudits.length, 1);
    assert.equal(terminalAudits[0].metadata.status, saved.status);
    await change(task.id, 'start', {}, 409);

    assert.equal((await change(first.id, 'start')).status, 'IN_PROGRESS');
    const failed = await change(first.id, 'fail', { reason: '  Fixture stock unavailable  ' });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failureReason, 'Fixture stock unavailable');
    assert.ok(failed.completedAt);
    assert.equal((await change(first.id, 'cancel')).status, 'CANCELLED');
    const countTask = await own('POST', '/tasks', { ...body, type: 'COUNT', quantity: 0 });
    assert.equal(countTask.quantity, 0);
    assert.equal((await change(countTask.id, 'start')).status, 'IN_PROGRESS');
    const confirmed = await change(countTask.id, 'confirm', { quantity: 0 });
    assert.equal(confirmed.status, 'DONE');
    assert.equal(confirmed.quantity, 0);
    assert.ok(confirmed.completedAt);
  });

  await scenario('warehouse orders release once and close with the quantities recorded by their tasks', async () => {
    const { sku } = await createSku('WAREHOUSE-ORDER');
    const orders = '/warehouse-orders';
    const input = {
      orderNumber: `COUNT-${suffix}`, orderType: 'COUNT',
      fromLocationReference: 'A-01-01',
      dueAt: '2027-01-10T09:00:00.000Z',
      lines: [
        { lineNumber: '1', skuReference: sku.code, requestedQuantity: 2 },
        { lineNumber: '2', skuReference: sku.id, requestedQuantity: 2 },
      ],
    };
    const work = (method, path, body, status) => asWorker(method, warehouse + path, body, status);
    await work('POST', orders, { ...input, lines: [] }, 409);
    await work('POST', orders, { ...input, lines: [input.lines[0], { ...input.lines[1], lineNumber: '1 ' }] }, 409);
    const draft = await work('POST', orders, input);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.dueAt, input.dueAt);
    assert.equal(draft.lines.length, 2);
    assert.equal(draft.taskLinks.length, 0);
    await work('POST', orders, input, 409);
    const path = `${orders}/${draft.id}`;
    await work('POST', path + '/complete', {}, 409);
    const releases = await Promise.all([
      work('POST', path + '/release', undefined, [201, 409]),
      work('POST', `${orders}/${draft.orderNumber}/release`, undefined, [201, 409]),
    ]);
    assert.equal(releases.filter(item => item.status === 'RELEASED').length, 1);
    const released = await own('GET', path);
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.taskLinks.length, 2);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: draft.id, action: 'warehouse_order.released' } }), 1);

    const linked = released.lines.map(line => released.taskLinks.find(link => link.warehouseOrderLineId === line.id).warehouseTaskId);
    await work('POST', path + '/complete', {}, 409);
    assert.deepEqual(await Promise.all(linked.map(id => own('GET', `/tasks/${id}`).then(task => task.status))), ['OPEN', 'OPEN']);
    for (const [index, id] of linked.entries()) {
      await work('POST', `/tasks/${id}/start`, {});
      await work('POST', `/tasks/${id}/confirm`, {}, 409);
      await work('POST', `/tasks/${id}/confirm`, { quantity: index === 0 ? 0 : 3 });
      if (index === 0) await work('POST', path + '/complete', {}, 409);
    }
    const closed = await work('POST', path + '/complete', { metadata: { fixture: true } });
    assert.equal(closed.status, 'COMPLETED');
    assert.ok(closed.completedAt);
    assert.deepEqual(closed.lines.map(line => line.completedQuantity), [0, 3]);
    await work('PATCH', path + '/cancel', { reason: 'Already counted' }, 409);

    const second = await work('POST', orders, { ...input, orderNumber: `CANCEL-${suffix}` });
    const secondPath = `${orders}/${second.id}`;
    const secondReleased = await work('POST', secondPath + '/release');
    const doneId = secondReleased.taskLinks.find(link => link.warehouseOrderLineId === secondReleased.lines[0].id).warehouseTaskId;
    const openId = secondReleased.taskLinks.find(link => link.warehouseOrderLineId === secondReleased.lines[1].id).warehouseTaskId;
    await work('POST', `/tasks/${doneId}/start`, {});
    await work('POST', `/tasks/${doneId}/confirm`, { quantity: 1 });
    await work('PATCH', secondPath + '/cancel', { reason: '   ' }, 409);
    const cancelled = await work('PATCH', secondPath + '/cancel', { reason: 'Cancel remaining count' });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.deepEqual(cancelled.lines.map(line => [line.status, line.completedQuantity]), [['DONE', 1], ['CANCELLED', 0]]);
    assert.equal((await own('GET', `/tasks/${doneId}`)).status, 'DONE');
    assert.equal((await own('GET', `/tasks/${openId}`)).status, 'CANCELLED');
    await work('POST', secondPath + '/release', undefined, 409);
  });

  await scenario('desktop and RF movement tasks write the confirmed stock transfer exactly once', async () => {
    const { sku } = await createSku('PLANNED-MOVE');
    const { sku: otherSku } = await createSku('OTHER-MOVE-SKU');
    const lot = await own('POST', '/traceability/lots', {
      skuReference: sku.code, lotCode: `MOVE-LOT-${suffix}`, batch: 'PLANNED',
    });
    const target = await own('POST', '/locations', {
      code: `MOVE-${suffix}`, name: 'Planned stock target', type: 'STORAGE', parentReference: 'A-01',
    });
    const orderBody = {
      orderType: 'MOVE', orderNumber: `MOVE-${suffix}`,
      fromLocationReference: 'A-01-01', toLocationReference: target.code,
      lines: [{ lineNumber: '1', lotReference: lot.id, requestedQuantity: 3 }],
    };
    await own('POST', '/warehouse-orders', { ...orderBody, toLocationReference: 'A-01-01' }, 409);
    await own('POST', '/warehouse-orders', {
      ...orderBody, lines: [{ ...orderBody.lines[0], skuReference: otherSku.id }],
    }, 409);
    const order = await own('POST', '/warehouse-orders', orderBody);
    const path = `/warehouse-orders/${order.id}`;
    const { taskLinks: [link] } = await own('POST', path + '/release');
    const taskPath = `/tasks/${link.warehouseTaskId}`;
    const work = (path, body, status = 201) => asWorker('POST', warehouse + path, body, status);
    await work(taskPath + '/start', {});
    await work(taskPath + '/confirm', {}, 409);
    await own('POST', path + '/complete', {}, 409);
    await prisma.warehouseTask.update({
      where: { id: link.warehouseTaskId }, data: { status: 'DONE', completedAt: new Date() },
    });
    await own('POST', path + '/complete', {}, 409);
    await prisma.warehouseTask.update({
      where: { id: link.warehouseTaskId }, data: { status: 'IN_PROGRESS', completedAt: null },
    });

    const { quant: unplanned } = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.id, locationReference: 'A-01-01', quantity: 8, batch: 'UNPLANNED',
    });
    await work(taskPath + '/confirm', {}, 409);
    const inbound = await own('POST', '/inbound-shipments', {
      shipmentNumber: `MOVE-ASN-${suffix}`, supplierName: 'Movement test supplier',
      lines: [{ lineNumber: '1', sku: sku.code, expectedQuantity: 8 }],
    });
    const { quant: source } = await own('POST', `/inbound-shipments/${inbound.id}/receive`, {
      lineReference: '1', quantity: 8, locationReference: 'A-01-01', lotReference: lot.lotCode,
      batch: 'PLANNED', createPutawayTask: false,
    });
    await work(taskPath + '/confirm', { toLocationReference: 'PACK-01' }, 409);
    await work(taskPath + '/confirm', { quantity: 2 }, 409);
    const receipts = await Promise.all([
      work(taskPath + '/confirm', {}, [201, 409]), work(taskPath + '/confirm', {}, [201, 409]),
    ]);
    assert.equal(receipts.filter(receipt => receipt.status === 'DONE').length, 1);
    const [movement] = await prisma.stockMovement.findMany({ where: { taskId: link.warehouseTaskId } });
    assert.equal(movement.quantity, 3);
    const destination = await own('GET', `/inventory/quants/${movement.stockQuantId}`);
    assert.equal(destination.location.id, target.id);
    assert.equal(destination.batch, 'PLANNED');
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: destination.id } })).lotId, lot.id);
    assert.equal(destination.quantity, 3);
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 5);
    assert.equal(await prisma.stockMovement.count({ where: { taskId: link.warehouseTaskId } }), 1);
    const completed = await own('POST', path + '/complete', {});
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.lines[0].completedQuantity, 3);

    const rfOrder = await own('POST', '/warehouse-orders', {
      ...orderBody, orderNumber: `RF-MOVE-${suffix}`, lines: [{ ...orderBody.lines[0], requestedQuantity: 2 }],
    });
    const rfPath = `/warehouse-orders/${rfOrder.id}`;
    const rfReleased = await own('POST', rfPath + '/release');
    const task = { id: rfReleased.taskLinks[0].warehouseTaskId };
    const { sessionId } = await work(`/rf/tasks/${task.id}/start`, {});
    const scan = (body, status) => work(`/rf/sessions/${sessionId}/scan`, body, status);
    assert.equal((await scan({ scannedValue: 'A-01-01' })).step.expected.type, 'SKU');
    assert.equal((await scan({ scannedValue: sku.code })).step.expected.type, 'QUANTITY');
    await scan({ scannedValue: '1' }, 409);
    const destinationStep = await scan({ scannedValue: '2' });
    assert.equal(destinationStep.step.expected.value, target.code);
    assert.equal(await prisma.stockMovement.count({ where: { taskId: task.id } }), 0);
    const queued = {
      idempotencyKey: `MOVE-FINISH-${suffix}`, sessionReference: sessionId, taskReference: task.id,
      stepKey: destinationStep.step.key, scannedValue: target.code,
    };
    const sync = () => work('/rf/offline/sync', { scans: [queued] });
    const replays = await Promise.all([sync(), sync()]);
    assert.deepEqual(replays.map(result => result.items[0].status).sort(), ['DUPLICATE', 'SYNCED']);
    const [rfMovement] = await prisma.stockMovement.findMany({ where: { taskId: task.id } });
    assert.equal(rfMovement.quantity, 2);
    assert.equal(await prisma.stockMovement.count({ where: { taskId: task.id } }), 1);
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 3);
    assert.equal((await own('GET', `/inventory/quants/${unplanned.id}`)).quantity, 8);
    assert.equal((await own('GET', `/inventory/quants/${destination.id}`)).quantity, 5);
    assert.equal((await own('POST', rfPath + '/complete', {})).lines[0].completedQuantity, 2);
  });

  await scenario('putaway moves the planned stock exactly once and rejects mismatched confirmations', async () => {
    const { sku } = await createSku('PUTAWAY');
    const { sku: otherSku } = await createSku('PUTAWAY-OTHER');
    const sourceLocation = await own('POST', '/locations', {
      code: `PA-SOURCE-${suffix}`, name: 'Putaway fixture source', type: 'STORAGE', parentReference: 'A-01',
    });
    const target = await own('POST', '/locations', {
      code: `PA-TARGET-${suffix}`, name: 'Putaway fixture target', type: 'STORAGE', parentReference: 'A-01',
    });
    const receive = (skuReference, locationReference, quantity) =>
      own('POST', '/inventory/quants/receive', { skuReference, locationReference, quantity });
    const source = (await receive(sku.code, sourceLocation.code, 6)).quant;
    const wrongStock = (await receive(otherSku.code, sourceLocation.code, 6)).quant;
    const targetStock = (await receive(sku.code, target.code, 2)).quant;
    const input = { stockQuantReference: source.id, quantity: 3 };
    await own('POST', '/putaway/suggest', {}, 409);
    const suggestion = await own('POST', '/putaway/suggest', input);
    assert.equal(suggestion.suggestedLocationId, target.id);
    await own('POST', '/putaway/tasks', { ...input, toLocationReference: sourceLocation.code }, 409);
    await own('POST', '/putaway/tasks', { ...input, quantity: 7 }, 409);
    const created = await own('POST', '/putaway/tasks', input);
    const task = created.task;
    assert.equal(task.toLocationId, target.id);
    assert.equal(task.status, 'OPEN');
    const started = await own('POST', `/tasks/${task.id}/start`, { metadata: { station: 'TEST' } });
    assert.equal(started.metadata.stockQuantId, source.id);
    assert.equal(started.metadata.station, 'TEST');
    await own('POST', `/tasks/${task.id}/confirm`, {}, 409);
    const confirm = `/putaway/tasks/${task.id}/confirm`;
    await own('POST', confirm, { stockQuantReference: wrongStock.id }, 409);
    await own('POST', confirm, { fromLocationReference: target.code }, 409);
    await own('POST', confirm, { quantity: 7 }, 409);
    for (const scope of [{ stockQuantId: source.id }, { locationId: target.id }]) {
      const freeze = await prisma.stockFreeze.create({
        data: { warehouseId: task.warehouseId, reason: 'Putaway test freeze', ...scope },
      });
      try {
        await own('POST', confirm, {}, 409);
      } finally {
        await prisma.stockFreeze.delete({ where: { id: freeze.id } });
      }
    }
    assert.equal((await own('GET', `/tasks/${task.id}`)).status, 'IN_PROGRESS');
    assert.equal((await own('GET', `/inventory/quants/${wrongStock.id}`)).quantity, 6);
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 6);

    const idempotencyKey = randomUUID();
    const [completed, replay] = await Promise.all([
      own('POST', confirm, { idempotencyKey }),
      own('POST', confirm, { idempotencyKey }),
    ]);
    assert.equal(completed.task.status, 'DONE');
    assert.equal(completed.task.version, started.version + 1);
    assert.equal(replay.movement.id, completed.movement.id);
    assert.equal(completed.targetQuant.id, targetStock.id);
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 3);
    assert.equal((await own('GET', `/inventory/quants/${targetStock.id}`)).quantity, 5);
    assert.equal(await prisma.stockMovement.count({ where: { taskId: task.id, type: 'PUTAWAY' } }), 1);
    await own('POST', confirm, { idempotencyKey, quantity: 1 }, 409);
    await own('POST', confirm, {}, 409);

    const next = await own('POST', '/putaway/tasks', input);
    await own('POST', `/putaway/tasks/${next.task.id}/confirm`, { idempotencyKey }, 409);
    assert.equal((await own('GET', `/tasks/${next.task.id}`)).status, 'OPEN');
  });

  await scenario('replenishment issues one demand and preserves stock identities during confirmation', async () => {
    const { sku } = await createSku('REPLENISH');
    const zone = `REPL-${suffix}`;
    const bulk = await own('POST', '/locations', {
      code: `BULK-${suffix}`, zone, name: 'Replenishment bulk stock', type: 'STORAGE', parentReference: 'A-01',
    });
    const face = await own('POST', '/locations', {
      code: `FACE-${suffix}`, name: 'Replenishment pick face', type: 'PICKING', parentReference: 'A-01',
    });
    const receive = (locationReference, batch, quantity) => own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference, batch, quantity,
    });
    const { quant: source } = await receive(bulk.code, 'BULK-BATCH', 16);
    const { quant: existing } = await receive(face.code, 'OTHER-BATCH', 2);
    const ruleBody = {
      code: zone, sku: sku.code.toLowerCase(), pickLocationReference: face.code,
      sourceZone: zone.toLowerCase(), minQuantity: 4, maxQuantity: 10, targetQuantity: 8,
    };
    await own('POST', '/replenishment/rules', { ...ruleBody, targetQuantity: 11 }, 409);
    await own('POST', '/replenishment/rules', { ...ruleBody, sku: `MISSING-${suffix}` }, 404);
    const rule = await own('POST', '/replenishment/rules', ruleBody);
    assert.equal(rule.skuId, sku.id);
    assert.equal(rule.pickLocationId, face.id);
    await own('POST', '/replenishment/rules', ruleBody, 409);
    const evaluate = (ruleReference = rule.code) => own('POST', '/replenishment/evaluate', { ruleReference });
    await own('POST', '/replenishment/evaluate', { ruleReference: `MISSING-${suffix}` }, 404);

    const evaluations = await Promise.all([evaluate(), evaluate(rule.id)]);
    const demands = evaluations.flatMap(result => result.demands);
    assert.equal(demands.length, 1);
    const [cancelled] = demands;
    await own('POST', `/tasks/${cancelled.warehouseTaskId}/cancel`, { reason: 'Replan test demand' });
    await own('POST', `/replenishment/tasks/${cancelled.id}/confirm`, {}, 409);
    const { demands: replacements } = await evaluate();
    assert.equal(replacements.length, 1);
    const [demand] = replacements;
    assert.notEqual(demand.id, cancelled.id);
    assert.equal(demand.availablePickQuantity, 2);
    assert.equal(demand.requiredQuantity, 6);
    assert.equal(demand.stockQuantId, source.id);
    const taskPath = `/tasks/${demand.warehouseTaskId}`;
    await own('POST', taskPath + '/start', {});
    await own('POST', taskPath + '/confirm', {}, 409);
    const confirm = `/replenishment/tasks/${demand.warehouseTaskId}/confirm`;
    await asWorker('POST', warehouse + confirm, {}, 403);
    await own('POST', confirm, { quantity: 7 }, 409);
    await own('POST', '/replenishment/tasks/unknown/confirm', {}, 404);

    const confirmations = await Promise.all([
      own('POST', confirm, {}, [201, 409]),
      own('POST', `/replenishment/tasks/${demand.id}/confirm`, {}, [201, 409]),
    ]);
    const recorded = confirmations.filter(result => result.movementId);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].movedQuantity, 6);
    assert.equal(recorded[0].demand.status, 'COMPLETED');
    const savedTask = await own('GET', taskPath);
    assert.equal(savedTask.status, 'DONE');
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 10);
    assert.equal((await own('GET', `/inventory/quants/${existing.id}`)).quantity, 2);
    const movements = await prisma.stockMovement.findMany({ where: { taskId: savedTask.id } });
    assert.equal(movements.length, 1);
    const target = await own('GET', `/inventory/quants/${movements[0].stockQuantId}`);
    assert.equal(target.quantity, 6);
    assert.equal(target.batch, source.batch);
    assert.equal(target.location.id, face.id);
    assert.equal((await evaluate()).demandsCreated, 0);
  });

  await scenario('inbound shipment changes roll back when any line is invalid', async () => {
    const { sku } = await createSku('INBOUND');
    const shipment = await own('POST', '/inbound-shipments', {
      shipmentNumber: `ASN-UPDATE-${suffix}`,
      supplierName: 'Initial supplier',
      lines: [
        { lineNumber: '10', sku: sku.code, expectedQuantity: 2 },
        { lineNumber: '20', sku: sku.code, expectedQuantity: 3 },
      ],
    });
    const path = `/inbound-shipments/${shipment.id}`;
    const changes = {
      supplierName: 'Updated supplier',
      lines: [
        { lineReference: '10', expectedQuantity: 4 },
        { lineReference: '20', expectedQuantity: 5 },
      ],
    };
    await own('PATCH', path, { ...changes, lines: [changes.lines[0], { lineReference: 'missing', expectedQuantity: 6 }] }, 404);
    const unchanged = await own('GET', path);
    assert.equal(unchanged.supplierName, 'Initial supplier');
    assert.deepEqual(unchanged.lines.map(line => line.expectedQuantity), [2, 3]);
    const saved = await own('PATCH', path, changes);
    assert.equal(saved.supplierName, 'Updated supplier');
    assert.deepEqual(saved.lines.map(line => line.expectedQuantity), [4, 5]);
  });

  await scenario('outbound picking waits for stock after an allocated line grows', async () => {
    const { sku } = await createSku('SHORT');
    const receipt = { skuReference: sku.code, locationReference: 'A-01-01', quantity: 2 };
    await own('POST', '/inventory/quants/receive', receipt);
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `SHORT-${suffix}`,
      lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 2 }],
    });
    const path = `/outbound-orders/${order.id}`;
    const tasksForOrder = async () => (await own('GET', `/tasks?type=PICK&sku=${sku.code}`))
      .filter(task => task.outboundOrderId === order.id);
    const initial = await own('POST', `${path}/allocate`, {});
    assert.equal(initial.lines[0].remainingQuantity, 0);
    assert.deepEqual((await tasksForOrder()).map(task => task.quantity), [2]);

    await own('PATCH', path, {
      recipientName: 'Rolled-back update',
      lines: [
        { lineReference: '10', orderedQuantity: 5 },
        { lineReference: 'missing', orderedQuantity: 2 },
      ],
    }, 404);
    const unchanged = await own('GET', path);
    assert.equal(unchanged.recipientName, null);
    assert.equal(unchanged.lines[0].orderedQuantity, 2);

    await own('PATCH', path, { lines: [{ lineReference: '10', orderedQuantity: 5 }] });
    await own('POST', `${path}/allocate`, {}, 409);
    await own('POST', `${path}/release-picking`, {}, 409);
    assert.equal((await own('GET', path)).status, 'ALLOCATED');
    assert.deepEqual((await tasksForOrder()).map(task => task.quantity), [2]);

    await own('POST', '/inventory/quants/receive', { ...receipt, quantity: 3 });
    const full = await own('POST', `${path}/allocate`, {});
    assert.equal(full.lines[0].alreadyReservedQuantity, 2);
    assert.equal(full.lines[0].allocatedQuantity, 3);
    assert.equal(full.lines[0].remainingQuantity, 0);
    const released = await own('POST', `${path}/release-picking`, {});
    assert.equal(released.order.status, 'PICKING');
    const tasks = await tasksForOrder();
    assert.deepEqual(tasks.map(task => task.quantity).sort((a, b) => a - b), [2, 3]);
    for (const task of tasks) {
      await own('POST', `/tasks/${task.id}/confirm-pick`, { orderReference: order.id, quantity: task.quantity });
    }
    const picked = await own('GET', path);
    assert.equal(picked.status, 'PICKED');
    assert.equal(picked.lines[0].pickedQuantity, 5);
  });

  await scenario('pick waves roll back a release when any order lacks stock and then link the correct tasks', async () => {
    async function orderWithStock(group) {
      const { sku } = await createSku(group);
      const receipt = { skuReference: sku.code, locationReference: 'A-01-01', quantity: 2 };
      await own('POST', '/inventory/quants/receive', receipt);
      const order = await own('POST', '/outbound-orders', {
        orderNumber: `ORDER-${group}-${suffix}`, lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 2 }],
      });
      const path = `/outbound-orders/${order.id}`;
      await own('POST', `${path}/allocate`, {});
      return { order, path, receipt };
    }
    const first = await orderWithStock('WAVE-A');
    const second = await orderWithStock('WAVE-B');
    const wave = await own('POST', '/pick-waves', {
      waveNumber: `TEST-WAVE-${suffix}`, outboundOrderReferences: [first.order.id, second.order.id],
    });
    const path = `/pick-waves/${wave.id}`;
    assert.equal(wave.status, 'PLANNED');
    assert.equal(wave.orders.length, 2);
    await own('PATCH', second.path, { lines: [{ lineReference: '10', orderedQuantity: 3 }] });

    await own('POST', `${path}/release`, {}, 409);
    const stillPlanned = await own('GET', path);
    assert.equal(stillPlanned.status, 'PLANNED');
    assert.equal(stillPlanned.tasks.length, 0);
    assert.equal((await own('GET', first.path)).status, 'ALLOCATED');
    assert.equal((await own('GET', second.path)).status, 'ALLOCATED');

    await own('POST', '/inventory/quants/receive', { ...second.receipt, quantity: 1 });
    await own('POST', `${second.path}/allocate`, {});
    const outcomes = await Promise.all([
      own('POST', `${path}/release`, {}, [201, 409]),
      own('POST', `${path}/release`, {}, [201, 409]),
    ]);
    const releases = outcomes.filter(result => result.wave);
    assert.equal(releases.length, 1);
    const [released] = releases;
    assert.equal(released.wave.status, 'RELEASED');
    assert.equal(released.ordersReleased, 2);
    assert.equal(released.tasksLinked, 3);
    assert.equal(released.tasksCreated, 0);
    await own('POST', `${path}/release`, {}, 409);
    await own('POST', `${path}/complete`, {}, 409);
    const tasks = (await own('GET', path)).tasks;
    assert.equal(new Set(tasks.map(task => task.warehouseTaskId)).size, 3);
    const expectedTasks = new Set(tasks.map(task => task.warehouseTaskId));
    for (const item of [first, second]) {
      assert.equal((await own('GET', item.path)).status, 'PICKING');
      const skuTasks = await own('GET', `/tasks?type=PICK&sku=${item.receipt.skuReference}`);
      for (const task of skuTasks) {
        assert.ok(expectedTasks.delete(task.id));
        await own('POST', `/tasks/${task.id}/confirm-pick`, { orderReference: item.order.id, quantity: task.quantity });
      }
      assert.equal((await own('GET', item.path)).status, 'PICKED');
    }
    assert.equal(expectedTasks.size, 0);
    const completions = await Promise.all([
      own('POST', `${path}/complete`, {}, [201, 409]),
      own('POST', `${path}/complete`, {}, [201, 409]),
    ]);
    assert.equal(completions.filter(result => result.status === 'COMPLETED').length, 1);
    const finished = await own('GET', path);
    assert.equal(finished.status, 'COMPLETED');
    assert.ok(finished.orders.every(item => item.status === 'PICKED'));
  });

  await scenario('pick carts and totes stay with their assigned wave and orders', async () => {
    const { sku } = await createSku('CART');
    await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 2,
    });
    async function plan(code) {
      const order = await own('POST', '/outbound-orders', {
        orderNumber: `CART-${code}-${suffix}`, lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 1 }],
      });
      await own('POST', `/outbound-orders/${order.id}/allocate`, {});
      const wave = await own('POST', '/pick-waves', {
        waveNumber: `CART-WAVE-${code}-${suffix}`, outboundOrderReferences: [order.id],
      });
      return { order, wave, path: `/pick-waves/${wave.id}` };
    }
    const first = await plan('A');
    const second = await plan('B');
    const cartBody = { code: `CART-${suffix}` };
    await asWorker('POST', `${warehouse}/pick-carts`, cartBody, 403);
    const cart = await own('POST', '/pick-carts', cartBody);
    assert.equal(cart.status, 'AVAILABLE');
    const selectCart = { pickCartReference: cart.code };
    const assigned = await own('POST', `${first.path}/assign-cart`, selectCart);
    assert.equal(assigned.waveId, first.wave.id);
    assert.equal(assigned.status, 'ASSIGNED');

    const tote = { code: `TOTE-${suffix}`, ...selectCart, capacityUnits: 60 };
    await own('POST', '/pick-totes', { ...tote, waveReference: second.wave.id, outboundOrderReference: second.order.id }, 409);
    await own('POST', '/pick-totes', { ...tote, waveReference: first.wave.id, outboundOrderReference: second.order.id }, 409);
    const saved = await own('POST', '/pick-totes', { ...tote, outboundOrderReference: first.order.id });
    assert.equal(saved.pickCartId, cart.id);
    assert.equal(saved.waveId, first.wave.id);
    assert.equal(saved.outboundOrderId, first.order.id);
    assert.equal(saved.capacityUnits, 60);
    await own('POST', `${second.path}/assign-cart`, selectCart, 409);
    await own('POST', `${second.path}/release`, selectCart, 409);
    const currentFirst = await own('GET', first.path);
    const currentSecond = await own('GET', second.path);
    assert.deepEqual(currentFirst.totes.map(item => item.id), [saved.id]);
    assert.deepEqual(currentFirst.carts.map(item => item.id), [cart.id]);
    assert.equal(currentSecond.status, 'PLANNED');
    assert.equal(currentSecond.tasks.length, 0);
    assert.equal((await own('GET', `/outbound-orders/${second.order.id}`)).status, 'ALLOCATED');

    const spare = await own('POST', '/pick-carts', { code: `SPARE-${suffix}` });
    const staged = await own('POST', '/pick-totes', {
      code: `STAGED-${suffix}`, pickCartReference: spare.code, waveReference: second.wave.id,
    });
    assert.equal(staged.waveId, second.wave.id);
    await own('POST', `${first.path}/assign-cart`, { pickCartReference: spare.code }, 409);
    assert.equal((await own('POST', `${second.path}/assign-cart`, { pickCartReference: spare.code })).waveId, second.wave.id);

    await own('POST', `${first.path}/release`, selectCart);
    const [task] = (await own('GET', `/tasks?type=PICK&sku=${sku.code}`)).filter(item => item.outboundOrderId === first.order.id);
    await own('POST', `/tasks/${task.id}/confirm-pick`, { orderReference: first.order.id, quantity: task.quantity });
    await own('POST', `${first.path}/complete`, {});
    const reused = await own('POST', `${second.path}/assign-cart`, selectCart);
    assert.equal(reused.waveId, second.wave.id);
    assert.equal((await own('GET', first.path)).totes[0].waveId, first.wave.id);

  });

  await scenario('billing invoices protect their events and finalize once across concurrent requests', async () => {
    const client = await asAdmin('POST', '/api/clients', {
      code: `BILL-${suffix}`, name: 'Billing test client', billingCurrency: 'EUR',
    });
    const path = `/clients/${client.code}`;
    await own('POST', `${path}/attach`, {});
    const eventBody = {
      eventType: 'PICK', status: 'BILLABLE', reference: `TEST-FEE-${suffix}`,
      quantity: 2, unitPriceMinor: 1200, occurredAt: '2026-10-10T12:00:00.000Z',
    };
    const event = await own('POST', `${path}/billing-events`, eventBody);
    assert.equal(event.amountMinor, 2400);
    const period = { periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z', vatRateBps: 2100 };
    const invoice = await own('POST', `${path}/billing-invoices`, period);
    assert.equal(invoice.status, 'DRAFT');
    assert.equal(invoice.subtotalMinor, 2400);
    assert.equal(invoice.taxTotalMinor, 504);
    assert.equal(invoice.totalAmountMinor, 2904);
    assert.equal(invoice.lines[0].billingEventId, event.id);
    const invoicePath = `${path}/billing-invoices/${invoice.id}`;
    const ledger = () => prisma.billingEvent.findUniqueOrThrow({ where: { id: event.id } });
    await own('POST', `/billing-events/${event.id}/void`, { reason: 'Invoice event cannot be voided separately' }, 409);
    await own('POST', `${path}/billing-events`, { ...eventBody, quantity: 3 }, 409);
    assert.equal((await ledger()).status, 'BILLABLE');
    assert.equal((await ledger()).amountMinor, 2400);

    const finalizations = await Promise.all([
      own('POST', `${invoicePath}/finalize`, {}, [201, 409]),
      own('POST', `${invoicePath}/finalize`, {}, [201, 409]),
    ]);
    assert.equal(finalizations.filter(item => item.status === 'FINALIZED').length, 1);
    assert.equal((await ledger()).status, 'INVOICED');
    assert.equal(await prisma.outboxEvent.count({
      where: { aggregateId: invoice.id, type: 'BILLING_INVOICE_FINALIZED' },
    }), 1);
    await own('POST', `${path}/billing-invoices`, period, 409);

    await Promise.all([
      own('POST', `${invoicePath}/void`, { reason: 'Test correction' }),
      own('POST', `${invoicePath}/void`, { reason: 'Same correction' }),
    ]);
    assert.equal(await prisma.outboxEvent.count({
      where: { aggregateId: invoice.id, type: 'BILLING_INVOICE_VOIDED' },
    }), 1);
    assert.equal((await ledger()).status, 'BILLABLE');
    assert.equal((await ledger()).invoicedAt, null);
    const replacements = await Promise.all([
      own('POST', `${path}/billing-invoices`, period, [201, 409]),
      own('POST', `${path}/billing-invoices`, period, [201, 409]),
    ]);
    const drafts = replacements.filter(item => item.status === 'DRAFT');
    assert.equal(drafts.length, 1);
    const [replacement] = drafts;
    assert.notEqual(replacement.id, invoice.id);
    assert.equal(replacement.lines[0].billingEventId, event.id);
    assert.equal(replacement.totalAmountMinor, 2904);

    const unbilled = await own('POST', `${path}/billing-events`, { ...eventBody, reference: `PENDING-${suffix}`, status: 'PENDING' });
    const voided = await own('POST', `/billing-events/${unbilled.reference}/void`, { reason: 'Unbilled fixture' });
    assert.equal(voided.status, 'VOIDED');

    const counters = [{ eventType: 'PACK', quantity: 2, unitPriceMinor: 350, referenceSuffix: `COUNT-${suffix}` }];
    const generate = `${path}/billing-events/generate`;
    const generatedBody = { counters, occurredAt: '2026-09-04T10:00:00.000Z' };
    const generated = await own('POST', generate, generatedBody);
    assert.equal(generated.events[0].amountMinor, 700);
    await own('POST', `${path}/billing-invoices`, {
      periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventStatuses: ['PENDING'],
    });
    const repeat = await own('POST', generate, { ...generatedBody, counters: [{ ...counters[0], quantity: 6 }] });
    assert.equal(repeat.events[0].id, generated.events[0].id);
    assert.equal(repeat.events[0].amountMinor, 700);
    assert.equal((await prisma.billingEvent.findUniqueOrThrow({ where: { id: generated.events[0].id } })).quantity, 2);
  });

  await scenario('parcels, tracking, operational exceptions and notifications can be updated', async () => {
    const parcelBody = { trackingNumber: `PARCEL-${suffix}`, currentLocationReference: 'A-01-01' };
    const parcel = await own('POST', '/parcels', parcelBody);
    await own('POST', '/parcels', parcelBody, 409);
    await own('PATCH', `/parcels/${parcel.id}`, { weightGrams: 100 });
    assert.equal((await own('GET', `/parcels/${parcel.id}`)).weightGrams, 100);
    const tracking = await own('POST', `/parcels/${parcel.id}/tracking-events`, { type: 'SCANNED', locationReference: 'A-01-01' });
    assert.equal(tracking.type, 'SCANNED');
    const exception = await own('POST', `/parcels/${parcel.id}/exceptions`, {
      code: 'DAMAGED', title: `Damage test ${suffix}`, severity: 'HIGH',
    });
    await own('PATCH', `/exceptions/${exception.id}`, { status: 'IN_PROGRESS' });
    const resolved = await own('PATCH', `/exceptions/${exception.id}`, { status: 'RESOLVED' });
    assert.equal(resolved.status, 'RESOLVED');
    const notification = await own('POST', '/notifications', { type: 'WARNING', title: `Test-${suffix}`, message: 'Test notification' });
    assert.equal(notification.status, 'UNREAD');
    const read = await own('PATCH', `/notifications/${notification.id}/read`);
    assert.equal(read.status, 'READ');
    assert.ok(read.readAt);
    const list = await own('GET', `/notifications?status=READ&search=${notification.title}`);
    assert.ok(list.some(item => item.id === notification.id));
  });

  await scenario('role assignment and credential rotation enforce permissions and revoke old sessions', async () => {
    const email = `test-${suffix.toLowerCase()}@example.invalid`;
    const password = `Fixture-${randomUUID()}-42!`;
    const userBody = { email, password, displayName: 'Test worker', roleCode: 'WAREHOUSE_WORKER', warehouseCode: 'MAIN' };
    await asManager('POST', '/api/users', userBody, 403);
    const user = await asAdmin('POST', '/api/users', userBody);
    await asAdmin('POST', '/api/users', userBody, 409);
    const session = await login(email, password);
    const asNewUser = bind(session.accessToken);
    assert.equal((await asNewUser('GET', '/api/auth/me')).email, email);
    const access = await asNewUser('GET', '/api/auth/me/warehouses/MAIN/access');
    assert.equal(access.warehouseCode, 'MAIN');
    assert.deepEqual(await asNewUser('GET', `/api/auth/me/warehouses/${access.warehouseId}/access`), access);
    await asNewUser('PUT', '/api/auth/me/work-context', { warehouseId: 'MAIN', rfMode: 'MOBILE' });
    assert.equal((await asNewUser('GET', '/api/auth/me/work-context')).rfMode, 'MOBILE');
    await asAdmin('POST', `/api/users/${user.id}/roles`, { roleCode: 'WAREHOUSE_MANAGER', warehouseCode: 'MAIN' });
    await request('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken }, expected: 401 });
    const assigned = bind((await login(email, password)).accessToken);
    const next = `Rotated-${randomUUID()}-42!`;
    await assigned('POST', '/api/auth/me/password', { currentPassword: password, newPassword: next });
    await request('POST', '/api/auth/login', { body: { email, password }, expected: 401 });
    const renewed = await login(email, next);
    await bind(renewed.accessToken)('POST', '/api/auth/revoke', { refreshToken: renewed.refreshToken });
    await request('POST', '/api/auth/refresh', { body: { refreshToken: renewed.refreshToken }, expected: 401 });
  });

  await scenario('external ID mappings and inbox redelivery persist a single business identity', async () => {
    const enterprise = '/api/integrations/enterprise';
    const systemBody = { code: `ERP-${suffix}`, name: 'Testing ERP', systemType: 'ERP' };
    const system = await asAdmin('POST', enterprise + '/external-systems', systemBody);
    assert.equal((await asAdmin('POST', enterprise + '/external-systems', { ...systemBody, name: 'Updated test ERP' })).id, system.id);
    const externalId = `OUT-${suffix}`;
    const query = new URLSearchParams({ externalSystemReference: system.code, resourceType: 'outbound_order', externalId });
    const resolver = enterprise + '/external-id-mappings/resolve';
    await asAdmin('GET', `${resolver}?${query}`, undefined, 404);
    const body = { ...Object.fromEntries(query), warehouseReference: 'MAIN', resourceId: randomUUID() };
    const mapping = await asAdmin('POST', enterprise + '/external-id-mappings', body);
    assert.equal((await asAdmin('GET', `${resolver}?${query}`)).resourceId, body.resourceId);
    const newResource = randomUUID();
    assert.equal((await asAdmin('POST', enterprise + '/external-id-mappings', { ...body, resourceId: newResource })).id, mapping.id);
    assert.equal((await asAdmin('GET', `${resolver}?${query}`)).resourceId, newResource);
    await asAdmin('GET', `${resolver}?${query}&externalId=another`, undefined, 400);

    const eventBody = { sourceSystem: system.code, externalEventId: `IN-${suffix}`, eventType: 'TEST_RECEIVED' };
    const received = await asAdmin('POST', '/api/inbox/events', eventBody);
    const repeated = await asAdmin('POST', '/api/outbox/events/inbox', eventBody);
    assert.equal(repeated.id, received.id);
    const processed = await asAdmin('POST', `/api/inbox/events/${received.id}/processed`, { resourceId: newResource });
    assert.equal(processed.status, 'PROCESSED');
    const another = await asAdmin('POST', '/api/inbox/events', { ...eventBody, externalEventId: `FAILED-${suffix}` });
    const failed = await asAdmin('POST', `/api/outbox/events/inbox/${another.id}/failed`, { errorMessage: 'Test failure' });
    assert.equal(failed.status, 'FAILED');
  });

  await scenario('quality checks handle a missing stock reference and quarantine and release real stock', async () => {
    const { sku } = await createSku('QUALITY');
    const receipt = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 2,
    });
    const body = { inspectionNumber: `QC-${suffix}`, skuReference: sku.code, sampleQuantity: 1 };
    await own('POST', '/quality/inspections', { ...body, stockQuantId: randomUUID() }, 404);
    const rule = await own('POST', '/quality/sampling-rules', { skuReference: sku.code, samplePercent: 25 });
    assert.equal(rule.samplePercent, 25);
    await own('POST', '/quality/sampling-rules', { samplePercent: 101 }, 400);
    const quantId = receipt.quant.id;
    const inspection = await own('POST', '/quality/inspections', { ...body, stockQuantId: quantId });
    assert.equal(inspection.status, 'OPEN');
    await asWorker('POST', `${warehouse}/quality/inspections/${inspection.id}/complete`, { result: 'PASS' }, 403);
    const completed = await own('POST', `/quality/inspections/${inspection.id}/complete`, { result: 'QUARANTINE' });
    assert.equal(completed.status, 'QUARANTINED');
    const quarantined = await own('GET', `/inventory/quants/${quantId}`);
    assert.equal(quarantined.status, 'QUARANTINE');
    assert.equal(quarantined.availableQuantity, 0);
    await own('POST', `/quality/quarantine/${quantId}/release`);
    assert.equal((await own('GET', `/inventory/quants/${quantId}`)).availableQuantity, 2);
  });

  await scenario('scanner writes persist bounded telemetry and RF queue filters reject invalid input', async () => {
    const scanner = await own('POST', '/scanners', { code: `TEST-SCAN-${suffix}`, name: 'Test scanner' });
    await own('PATCH', `/scanners/${scanner.id}`, { name: 'Renamed test scanner' });
    await own('PATCH', `/scanners/${scanner.id}/telemetry`, { batteryLevel: 101 }, 400);
    const updated = await own('PATCH', `/scanners/${scanner.id}/telemetry`, { batteryLevel: 0, signalStrength: 100 });
    assert.equal(updated.batteryLevel, 0);
    assert.equal(updated.signalStrength, 100);
    assert.ok(updated.lastSeenAt);
    const listed = await own('GET', '/scanners');
    assert.equal(listed.find(item => item.id === scanner.id).name, 'Renamed test scanner');
    for (const query of ['limit=abc', 'limit=0', 'workflow=UNKNOWN', 'workflow=PICK&workflow=COUNT', 'zone=A&zone=B']) {
      await own('GET', `/rf/queue?${query}`, undefined, 400);
    }
    const picking = await asWorker('GET', `${warehouse}/rf/queue?workflow=pick&limit=1`);
    assert.ok(picking.tasks.length <= 1);
    assert.ok(picking.tasks.every(task => task.workflow === 'PICK'));
  });

  await scenario('RF putaway moves stock once and rolls back rejected offline confirmations', async () => {
    const { sku } = await createSku('RF-PUTAWAY');
    const target = await own('POST', '/locations', {
      code: `RF-PA-${suffix}`, name: 'RF putaway target', type: 'STORAGE', parentReference: 'A-01',
    });
    const { quant: source } = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 8,
    });
    const work = (path, body, expected = 201) => asWorker('POST', warehouse + path, body, expected);
    const startPutaway = async () => {
      const { task } = await own('POST', '/putaway/tasks', {
        stockQuantReference: source.id, toLocationReference: target.id, quantity: 3,
      });
      const started = await work(`/rf/tasks/${task.id}/start`, {});
      const sessionPath = `/rf/sessions/${started.sessionId}`;
      const scan = (body, expected) => work(sessionPath + '/scan', body, expected);
      const item = await scan({ scannedValue: sku.code });
      assert.equal(item.step.expected.type, 'LOCATION');
      const origin = await scan({ scannedValue: 'A-01-01' });
      assert.equal(origin.step.expected.value, target.code);
      const wrong = await scan({ scannedValue: 'A-01-01' });
      assert.equal(wrong.step.errorCode, 'SCAN_MISMATCH');
      const amount = await scan({ scannedValue: target.code });
      assert.equal(amount.step.expected.type, 'QUANTITY');
      assert.equal(await prisma.stockMovement.count({ where: { taskId: task.id } }), 0);
      return { task, started, sessionPath, scan, amount };
    };

    const online = await startPutaway();
    for (const quantity of ['not-a-quantity', '0', '4']) {
      await online.scan({ scannedValue: quantity }, 409);
    }
    assert.equal((await own('GET', online.sessionPath)).step.key, online.amount.step.key);
    const completed = await online.scan({ scannedValue: '3' });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.task.status, 'DONE');
    await online.scan({ quantity: 3 }, 409);
    const movementWhere = { taskId: online.task.id, type: 'PUTAWAY' };
    const movements = await prisma.stockMovement.findMany({ where: movementWhere });
    assert.equal(movements.length, 1);
    assert.equal(movements[0].quantity, 3);
    const targetId = movements[0].stockQuantId;
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 5);
    assert.equal((await own('GET', `/inventory/quants/${targetId}`)).quantity, 3);

    const offline = await startPutaway();
    const queued = {
      idempotencyKey: `RF-PA-FROZEN-${suffix}`,
      sessionReference: offline.started.sessionId, taskReference: offline.task.id,
      stepKey: offline.amount.step.key, quantity: 2,
    };
    const sync = scan => work('/rf/offline/sync', { scans: [scan] });
    const freeze = await prisma.stockFreeze.create({
      data: { warehouseId: offline.task.warehouseId, locationId: target.id, reason: 'RF putaway test freeze' },
    });
    try {
      const rejected = await sync(queued);
      assert.equal(rejected.items[0].status, 'FAILED');
      assert.equal(rejected.items[0].errorCode, 'REPLAY_FAILED');
      assert.match(rejected.items[0].errorMessage, /active stock freeze/);
      assert.equal((await own('GET', offline.sessionPath)).step.key, offline.amount.step.key);
      assert.equal((await own('GET', `/tasks/${offline.task.id}`)).status, 'IN_PROGRESS');
      assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 5);
      assert.equal(await prisma.stockMovement.count({ where: { taskId: offline.task.id } }), 0);
    } finally {
      await prisma.stockFreeze.delete({ where: { id: freeze.id } });
    }
    const corrected = { ...queued, idempotencyKey: `RF-PA-READY-${suffix}` };
    const results = await Promise.all([sync(corrected), sync(corrected)]);
    assert.deepEqual(results.flatMap(result => result.items).map(item => item.status).sort(), ['DUPLICATE', 'SYNCED']);
    assert.equal((await own('GET', offline.sessionPath)).status, 'COMPLETED');
    assert.equal((await own('GET', `/tasks/${offline.task.id}`)).quantity, 2);
    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 3);
    assert.equal((await own('GET', `/inventory/quants/${targetId}`)).quantity, 5);
    assert.equal(await prisma.stockMovement.count({ where: { taskId: offline.task.id, type: 'PUTAWAY' } }), 1);

    const { task: protectedTask } = await own('POST', '/putaway/tasks', {
      stockQuantReference: source.id, toLocationReference: target.id, quantity: 1,
    });
    const role = await prisma.role.create({ data: {
      code: `RF-ONLY-${suffix}`, name: 'RF without stock permission',
      permissions: { create: [{ permission: { connect: { code: 'rf.manage' } } }] },
    } });
    const email = `rf-only-${suffix.toLowerCase()}@example.invalid`;
    const password = `Test-${randomUUID()}-42!`;
    const restricted = await asAdmin('POST', '/api/users', {
      email, password, displayName: 'Restricted RF operator', roleCode: 'WAREHOUSE_WORKER', warehouseCode: 'MAIN',
    });
    const membership = { userId: restricted.id, warehouseId: protectedTask.warehouseId };
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: membership }),
      prisma.userRole.create({ data: { ...membership, roleId: role.id } }),
    ]);
    const asRestricted = bind((await login(email, password)).accessToken);
    const profile = await asRestricted('GET', '/api/auth/me');
    assert.deepEqual(profile.warehouses.find(item => item.warehouseCode === 'MAIN').permissionCodes, ['rf.manage']);
    await asRestricted('POST', `${warehouse}/rf/tasks/${protectedTask.id}/start`, {}, 403);
    await asRestricted('POST', `${warehouse}/rf/sessions`, { taskReference: protectedTask.id }, 403);
    assert.equal((await own('GET', `/tasks/${protectedTask.id}`)).status, 'OPEN');
  });

  await scenario('RF replay preserves mismatches and stores each offline scan once', async () => {
    const runtime = '/operations-runtime';
    const scanPath = `${runtime}/rf/scans`;
    const replayPath = `${runtime}/rf/offline-queue/replay`;
    const exceptionPath = `${runtime}/rf/exceptions`;
    const deviceCode = `RF-${suffix}`;
    const session = await own('POST', `${runtime}/rf/sessions`, { deviceCode, workerCode: 'TEST-WORKER' });
    const location = {
      sessionId: session.id, deviceCode, stepKey: 'SCAN_LOCATION',
      scannedValue: 'A-01-01', expectedValue: 'A-01-01',
    };
    const wrong = { ...location, scannedValue: 'B-00-00', offlineId: `WRONG-${suffix}` };
    const failed = await own('POST', scanPath, wrong);
    assert.equal(failed.result, 'MISMATCH');
    assert.equal(failed.accepted, false);
    const replayed = await own('POST', replayPath, { deviceCode, actions: [wrong] });
    assert.deepEqual([replayed.accepted, replayed.duplicates, replayed.rejected], [0, 0, 1]);
    assert.equal(replayed.results[0].result, 'MISMATCH');
    assert.equal((await own('POST', scanPath, wrong)).event.id, failed.event.id);
    let dashboard = await own('GET', `${runtime}/rf-console`);
    assert.equal(dashboard.activeSessions.find(item => item.id === session.id).lastError, 'SCAN_MISMATCH');
    assert.equal(dashboard.exceptionQueue.filter(item => item.sessionId === session.id && item.code === 'SCAN_MISMATCH').length, 1);

    const accepted = { ...location, offlineId: ` ACCEPT-${suffix} ` };
    const attempts = await Promise.all(Array.from({ length: 6 }, () => own('POST', scanPath, accepted)));
    assert.equal(attempts.filter(item => item.result === 'ACCEPTED').length, 1);
    assert.equal(attempts.filter(item => item.result === 'DUPLICATE' && item.accepted).length, 5);
    assert.equal(new Set(attempts.map(item => item.event.id)).size, 1);
    const detached = { ...accepted, sessionId: undefined, offlineId: `NO-SESSION-${suffix}` };
    const parallel = await Promise.all(Array.from({ length: 6 }, () => own('POST', scanPath, detached)));
    assert.equal(parallel.filter(item => item.result === 'ACCEPTED').length, 1);
    assert.equal(new Set(parallel.map(item => item.event.id)).size, 1);
    await own('POST', scanPath, { ...accepted, scannedValue: 'B-00-00' }, 409);
    await own('POST', scanPath, { ...location, deviceCode: 'OTHER-DEVICE' }, 404);
    await own('POST', scanPath, { ...location, sessionId: 'not-a-uuid' }, 400);
    await own('POST', exceptionPath, { sessionId: session.id, deviceCode: 'OTHER-DEVICE', code: 'SHORT_PICK' }, 404);

    const sku = { ...location, stepKey: 'SCAN_SKU', scannedValue: 'TEST-SKU', expectedValue: 'TEST-SKU' };
    await own('POST', replayPath, {
      deviceCode, actions: [sku, { ...sku, sessionId: randomUUID() }],
    }, 404);
    dashboard = await own('GET', `${runtime}/rf-console`);
    assert.equal(dashboard.activeSessions.find(item => item.id === session.id).currentStep, 'SCAN_SKU');
    assert.equal(dashboard.recentScans.filter(item => item.sessionId === session.id).length, 2);

    const recorded = await own('POST', exceptionPath, { sessionId: session.id, deviceCode, code: 'SHORT_PICK' });
    assert.equal(recorded.sessionId, session.id);
    const repeats = await own('POST', replayPath, { deviceCode, actions: [wrong, accepted] });
    assert.deepEqual([repeats.accepted, repeats.duplicates, repeats.rejected], [0, 1, 1]);
    dashboard = await own('GET', `${runtime}/rf-console`);
    assert.equal(dashboard.activeSessions.find(item => item.id === session.id).state, 'BLOCKED');
    assert.equal(dashboard.activeSessions.find(item => item.id === session.id).lastError, 'SHORT_PICK');
  });

  await scenario('scanner queue acknowledges only applied scans and retains failed and pending entries', async () => {
    const { sku } = await createSku('OFFLINE');
    await own('POST', '/inventory/quants/receive', { skuReference: sku.code, locationReference: 'A-01-01', quantity: 1 });
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `OFFLINE-${suffix}`, lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 1 }],
    });
    await own('POST', `/outbound-orders/${order.id}/allocate`, {});
    await own('POST', `/outbound-orders/${order.id}/release-picking`, {});
    const [task] = (await own('GET', `/tasks?type=PICK&sku=${sku.code}`)).filter(item => item.outboundOrderId === order.id);
    const session = await asWorker('POST', `${warehouse}/rf/tasks/${task.id}/start`, {});
    const sessionPath = `/rf/sessions/${session.sessionId}`;
    const common = { sessionReference: session.sessionId, taskReference: task.id, stepKey: session.step.key };
    const sync = (scans, dryRun = false) => asWorker('POST', `${warehouse}/rf/offline/sync`, { scans, dryRun });
    const wrong = { ...common, idempotencyKey: `WRONG-${suffix}`, scannedValue: 'MISSING-LOCATION' };
    const pending = { idempotencyKey: `WAIT-${suffix}`, scannedValue: 'UNASSIGNED' };
    const correct = { ...common, idempotencyKey: `RIGHT-${suffix}`, scannedValue: session.step.expected.value };
    const preview = await sync([correct], true);
    assert.equal(preview.queued, 1);
    const original = await sync([wrong, pending]);
    assert.deepEqual(original.items.map(item => item.status), ['FAILED', 'QUEUED']);
    assert.equal(original.items[0].errorCode, 'SCAN_MISMATCH');
    assert.deepEqual((await sync([wrong, pending])).items.map(item => item.status), ['FAILED', 'QUEUED']);

    const outcomes = await Promise.all(Array.from({ length: 6 }, () => sync([correct])));
    assert.equal(outcomes.reduce((sum, item) => sum + item.synced, 0), 1);
    assert.equal(outcomes.reduce((sum, item) => sum + item.duplicates, 0), 5);
    const current = await own('GET', sessionPath);
    assert.notEqual(current.step.key, session.step.key);

    const reused = await sync([{ ...correct, scannedValue: 'different-input' }]);
    assert.equal(reused.items[0].status, 'FAILED');
    assert.equal(reused.items[0].errorCode, 'OFFLINE_KEY_CONFLICT');
    const delayed = await sync([{ ...correct, idempotencyKey: `DELAY-${suffix}`, scannedValue: current.step.expected.value }]);
    assert.equal(delayed.items[0].status, 'FAILED');
    assert.equal((await own('GET', sessionPath)).step.key, current.step.key);

    const { sku: countedSku } = await createSku('OFFLINE-COUNT');
    await own('POST', '/inventory/quants/receive', { skuReference: countedSku.code, locationReference: 'A-01-01', quantity: 3 });
    const plan = await own('POST', '/cycle-counts', { code: `OFFLINE-COUNT-${suffix}`, scopeType: 'SKU', scopeReference: countedSku.code });
    await own('POST', `/cycle-counts/${plan.id}/release`, {});
    const [countTask] = await own('GET', `/cycle-counts/${plan.id}/tasks`);
    await own('POST', `/tasks/${countTask.warehouseTaskId}/start`, {}, 409);
    let count = await asWorker('POST', `${warehouse}/rf/tasks/${countTask.warehouseTaskId}/start`, {});
    await own('POST', `/tasks/${countTask.warehouseTaskId}/confirm`, { quantity: 0 }, 409);
    assert.equal(count.remainingSteps[0].key, count.step.key);
    assert.equal(count.remainingSteps.find(item => item.expected.type === 'QUANTITY').expected.value, null);
    const countPath = `/rf/sessions/${count.sessionId}`;
    for (let step = 0; step < 2 && ['LOCATION', 'SKU'].includes(count.step.expected.type); step += 1) {
      count = await asWorker('POST', `${warehouse}${countPath}/scan`, { scannedValue: count.step.expected.value });
    }
    assert.equal(count.step.expected.type, 'QUANTITY');
    const countScan = { sessionReference: count.sessionId, taskReference: countTask.warehouseTaskId, stepKey: count.step.key };
    const invalidQuantity = await sync([{ ...countScan, idempotencyKey: `BAD-COUNT-${suffix}`, scannedValue: 'NOT-A-COUNT' }]);
    assert.equal(invalidQuantity.items[0].status, 'FAILED');
    const afterFailure = await own('GET', countPath);
    assert.equal(afterFailure.status, 'ACTIVE');
    assert.equal(afterFailure.step.key, count.step.key);
    const zeroQuantity = await sync([{ ...countScan, idempotencyKey: `ZERO-COUNT-${suffix}`, scannedValue: '0', quantity: 0 }]);
    assert.equal(zeroQuantity.items[0].status, 'SYNCED');
    assert.equal((await own('GET', countPath)).status, 'COMPLETED');
    const [submittedCount] = await own('GET', `/cycle-counts/${plan.id}/tasks`);
    assert.equal(submittedCount.status, 'SUBMITTED');
    assert.equal(submittedCount.countedQuantity, 0);
  });

  await scenario('scanner session completion and cancellation are mutually exclusive', async () => {
    const session = await asWorker('POST', `${warehouse}/rf/sessions`, { workflow: 'MOVE' });
    const path = `${warehouse}/rf/sessions/${session.sessionId}`;
    assert.equal((await asWorker('POST', `${path}/resume`)).status, 'ACTIVE');
    assert.equal((await asWorker('POST', `${path}/heartbeat`)).status, 'ACTIVE');
    assert.equal((await asWorker('POST', `${path}/scan`, { scannedValue: 'COMPLETE' })).status, 'COMPLETED');
    await asWorker('POST', `${path}/cancel`, { reason: 'Completed session' }, 409);
    await asWorker('POST', `${path}/resume`, undefined, 409);
    await asWorker('POST', `${path}/heartbeat`, undefined, 409);
    assert.equal((await asWorker('GET', path)).status, 'COMPLETED');

    const next = await asWorker('POST', `${warehouse}/rf/sessions`, { workflow: 'MOVE' });
    const nextPath = `${warehouse}/rf/sessions/${next.sessionId}`;
    const competing = await Promise.all([
      asWorker('POST', `${nextPath}/scan`, { scannedValue: 'COMPLETE' }, [201, 409]),
      asWorker('POST', `${nextPath}/cancel`, { reason: 'Stopped by operator' }, [201, 409]),
    ]);
    const terminal = competing.filter(result => ['COMPLETED', 'CANCELLED'].includes(result.status));
    assert.equal(terminal.length, 1);
    assert.equal((await asWorker('GET', nextPath)).status, terminal[0].status);

    const stopped = await asWorker('POST', `${warehouse}/rf/sessions`, { workflow: 'MOVE' });
    const stoppedPath = `${warehouse}/rf/sessions/${stopped.sessionId}`;
    await asWorker('POST', `${stoppedPath}/cancel`, { reason: 'First cancellation' });
    const replay = await asWorker('POST', `${stoppedPath}/cancel`, { reason: 'Later cancellation' });
    assert.equal(replay.status, 'CANCELLED');
    assert.equal(replay.metadata.cancelReason, 'First cancellation');
    const persisted = await asWorker('GET', stoppedPath);
    assert.equal(persisted.step.key, null);
    assert.equal(await prisma.auditLog.count({
      where: { resourceId: stopped.sessionId, action: 'rf.session_cancelled' },
    }), 1);
  });

  await scenario('an RF exception releases only the reported quantity and preserves order details', async () => {
    const { sku } = await createSku('RF-EXCEPTION');
    await own('POST', '/inventory/quants/receive', { skuReference: sku.code, locationReference: 'A-01-01', quantity: 5 });
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `RF-EXCEPTION-${suffix}`, metadata: { channel: 'Test channel' },
      lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 3 }],
    });
    const allocation = await own('POST', `/outbound-orders/${order.id}/allocate`, {});
    const reservationId = allocation.reservations[0].id;
    await own('POST', `/outbound-orders/${order.id}/release-picking`, {});
    const [task] = (await own('GET', `/tasks?type=PICK&sku=${sku.code}`)).filter(item => item.outboundOrderId === order.id);
    const path = `${warehouse}/rf/tasks/${task.id}/report-exception`;
    const scanner = await asWorker('POST', `${warehouse}/rf/tasks/${task.id}/start`, {});
    const body = { code: 'SHORT_PICK', shortQuantity: 1, releaseReservation: true };
    const ledger = () => prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const initial = await ledger();
    const stock = () => prisma.stockQuant.findUniqueOrThrow({ where: { id: initial.stockQuantId } });
    const reservedBefore = (await stock()).reservedQuantity;

    await asWorker('POST', path, { ...body, taskStatus: 'DONE' }, 400);
    assert.equal((await ledger()).quantity, 3);
    const result = await asWorker('POST', path, body);
    assert.equal(result.releasedReservedQuantity, 1);
    assert.equal(result.taskStatus, 'FAILED');
    assert.equal(result.orderStatus, 'EXCEPTION');
    assert.equal((await ledger()).quantity, 2);
    assert.equal((await stock()).reservedQuantity, reservedBefore - 1);
    const currentOrder = await own('GET', `/outbound-orders/${order.id}`);
    assert.equal(currentOrder.metadata.channel, 'Test channel');
    assert.equal(currentOrder.metadata.fulfillmentStatus, 'EXCEPTION');

    await asWorker('POST', path, body, 409);
    await asWorker('POST', `${warehouse}/rf/sessions/${scanner.sessionId}/scan`, { scannedValue: scanner.step.expected.value }, 409);
    assert.equal((await ledger()).quantity, 2);
    assert.equal((await stock()).reservedQuantity, reservedBefore - 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: task.id, action: 'rf.exception_reported' } }), 1);
  });

  await scenario('fake print agents claim, finish and replay a job without touching hardware', async () => {
    const printerCode = `TEST-PRINTER-${suffix}`;
    const agentCode = `TEST-AGENT-${suffix}`;
    const token = randomUUID();
    await own('POST', '/printers', { code: printerCode, name: 'Test printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' });
    await own('POST', '/print-agents', { code: agentCode, name: 'Test agent', token, printerCodes: [printerCode] });
    const body = { printerCode, agentCode, renderedZpl: '^XA^FO40,40^FDTest^FS^XZ' };
    const key = randomUUID();
    const job = await asAdmin('POST', `${warehouse}/print-jobs`, body, 201, key);
    assert.equal(job.status, 'QUEUED');
    assert.equal((await asAdmin('POST', `${warehouse}/print-jobs`, body, 201, key)).id, job.id);
    await asAdmin('POST', `${warehouse}/print-jobs`, { ...body, copies: 2 }, 409, key);
    const claimPath = `${warehouse}/print-agent/jobs/claim`;
    await request('POST', claimPath, { body: { agentCode, token: randomUUID() }, expected: 401 });
    const claimed = await request('POST', claimPath, { body: { agentCode, token, limit: 1 }, expected: 201 });
    assert.deepEqual(claimed.data.jobs.map(item => item.id), [job.id]);
    assert.equal(claimed.data.jobs[0].status, 'CLAIMED');
    const resultPath = `${warehouse}/print-agent/jobs/${job.id}/result`;
    const printed = { agentCode, token, status: 'PRINTED' };
    assert.equal((await request('POST', resultPath, { body: printed, expected: 201 })).data.status, 'PRINTED');
    assert.equal((await request('POST', resultPath, { body: printed, expected: 201 })).data.status, 'PRINTED');
    await request('POST', resultPath, { body: { ...printed, status: 'FAILED' }, expected: 409 });
    await own('POST', `/print-jobs/${job.id}/retry`, {}, 409);
    const reprint = await own('POST', `/print-jobs/${job.id}/reprint`, {});
    assert.notEqual(reprint.id, job.id);
    assert.equal((await own('POST', `/print-jobs/${reprint.id}/cancel`, {})).status, 'CANCELLED');
  });

  await scenario('legacy print metrics count failed jobs from PostgreSQL', async () => {
    const parcel = await own('POST', '/parcels', { trackingNumber: `PRINT-${suffix}` });
    const before = await own('GET', '/analytics/overview');
    const job = await own('POST', `/parcels/${parcel.id}/labels/print-jobs`, { templateReference: 'PARCEL-ZPL-DEFAULT' });
    await prisma.labelPrintJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
    const metrics = await own('GET', '/analytics/overview');
    assert.equal(metrics.labelJobs.available, true);
    assert.equal(metrics.labelJobs.failed, before.labelJobs.failed + 1);
  });

  await scenario('shipment labels are linked to confirmed print jobs and scoped to their shipment', async () => {
    const printerCode = `SHIP-PRINTER-${suffix}`;
    const agentCode = `SHIP-AGENT-${suffix}`;
    const token = randomUUID();
    await own('POST', '/printers', { code: printerCode, name: 'Shipment test printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' });
    await own('POST', '/print-agents', { code: agentCode, name: 'Shipment test agent', token, printerCodes: [printerCode] });
    const shipment = await own('POST', '/shipments', { shipmentNumber: `PRINT-SHIP-${suffix}` });
    const otherShipment = await own('POST', '/shipments', { shipmentNumber: `PRINT-OTHER-${suffix}` });
    const packagesPath = `/shipments/${shipment.id}/packages`;
    const labelsPath = `/shipments/${shipment.id}/labels`;
    const left = await own('POST', packagesPath, { packageCode: `PRINT-L-${suffix}` });
    const right = await own('POST', packagesPath, { packageCode: `PRINT-R-${suffix}` });
    await own('POST', labelsPath, { packageReference: left.id, labelFormat: 'PDF' }, 400);
    const leftLabel = await own('POST', labelsPath, { packageReference: left.id });
    const rightLabel = await own('POST', labelsPath, { packageReference: right.id });
    const document = await own('GET', `${labelsPath}/${leftLabel.id}/document`);
    assert.equal(document.format, 'ZPL');
    assert.equal(document.content, leftLabel.payload.labelData);
    assert.match(document.content, /^\^XA[\s\S]*\^XZ$/);
    await own('GET', `/shipments/${otherShipment.id}/labels/${leftLabel.id}/document`, undefined, 404);
    const printPath = label => `${warehouse}${labelsPath}/${label.id}/print-jobs`;
    const key = randomUUID();
    const queued = await asWorker('POST', printPath(leftLabel), { printerCode }, 201, key);
    assert.equal(queued.renderedZpl, document.content);
    assert.equal((await asWorker('POST', printPath(leftLabel), { printerCode }, 201, key)).id, queued.id);
    await asWorker('POST', printPath(rightLabel), { printerCode }, 409, key);
    const claimPath = `${warehouse}/print-agent/jobs/claim`;
    const claim = async () => (await request('POST', claimPath, { body: { agentCode, token }, expected: 201 })).data.jobs[0];
    const report = (job, status) => request('POST', `${warehouse}/print-agent/jobs/${job.id}/result`, {
      body: { agentCode, token, status }, expected: 201,
    });
    const states = async () => new Map((await own('GET', packagesPath)).map(item => [item.id, item.label]));
    assert.equal((await claim()).id, queued.id);
    await report(queued, 'FAILED');
    assert.equal((await states()).get(left.id).status, 'GENERATED');
    assert.equal((await states()).get(left.id).printStatus, 'FAILED');

    const unrelated = await own('POST', '/print-jobs', {
      printerCode, renderedZpl: document.content, payload: { carrierLabelId: rightLabel.id },
    });
    assert.equal((await claim()).id, unrelated.id);
    await report(unrelated, 'PRINTED');
    assert.equal((await states()).get(right.id).status, 'GENERATED');
    const reprint = await own('POST', `/print-jobs/${queued.id}/reprint`, {});
    assert.equal((await claim()).id, reprint.id);
    await report(reprint, 'PRINTED');
    await report(reprint, 'PRINTED');
    const current = await states();
    assert.equal(current.get(left.id).status, 'PRINTED');
    assert.equal(current.get(left.id).printStatus, 'PRINTED');
    assert.equal(current.get(right.id).status, 'GENERATED');
  });

  await scenario('automation commands, appointments and replayed events stay scoped to the warehouse', async () => {
    const prefix = '/enterprise-ops';
    const deviceBody = { code: `DEVICE-${suffix}`, deviceType: 'TEST', status: 'ONLINE' };
    await asWorker('POST', warehouse + prefix + '/automation/devices', deviceBody, 403);
    const device = await own('POST', prefix + '/automation/devices', deviceBody);
    const heartbeat = await own('POST', `${prefix}/automation/devices/${device.id}/heartbeat`, { telemetry: { test: true } });
    assert.equal(heartbeat.id, device.id);
    const commandBody = { deviceId: device.id, commandType: 'TEST_COMMAND', correlationId: `CMD-${suffix}` };
    const command = await own('POST', prefix + '/automation/commands', commandBody);
    const queuedAgain = await own('POST', prefix + '/automation/commands', { ...commandBody, priority: 60 });
    assert.equal(queuedAgain.id, command.id);
    assert.equal(queuedAgain.priority, 60);
    const claimed = await own('POST', `${prefix}/automation/commands/claim-next?deviceId=${device.id}`);
    assert.equal(claimed.id, command.id);
    assert.equal(claimed.status, 'CLAIMED');
    const completion = `${prefix}/automation/commands/${command.id}/complete`;
    assert.equal((await own('PATCH', completion, { result: { test: true } })).status, 'COMPLETED');
    await own('PATCH', completion, {}, 409);

    const ramp = await own('POST', prefix + '/yard/dock-doors', { code: `DOOR-${suffix}` });
    const appointment = {
      appointmentNumber: `APPT-${suffix}`, direction: 'INBOUND',
      plannedStartAt: '2030-01-01T12:00:00Z', plannedEndAt: '2030-01-01T13:00:00Z',
    };
    await own('POST', prefix + '/yard/appointments', { ...appointment, plannedEndAt: appointment.plannedStartAt }, 409);
    const booked = await own('POST', prefix + '/yard/appointments', appointment);
    const assigned = await own('PATCH', `${prefix}/yard/appointments/${booked.id}/assign-dock`, { dockDoorId: ramp.id });
    assert.equal(assigned.dockDoorId, ramp.id);

    const type = `TEST_EVENT_${suffix}`;
    const subscription = await own('POST', prefix + '/webhook-subscriptions', {
      name: `Test-${suffix}`, targetUrl: 'http://127.0.0.1:1/', eventTypes: [type],
    });
    const eventBody = { eventType: type, resourceType: 'automation_device', resourceId: device.id };
    const event = await own('POST', prefix + '/domain-events', eventBody);
    assert.equal((await own('POST', prefix + '/domain-events', eventBody)).id, event.id);
    const delivery = await own('POST', `${prefix}/domain-events/${event.id}/replay`);
    const attempts = delivery.filter(item => item.subscriptionId === subscription.id).map(item => item.attemptNumber).sort();
    assert.deepEqual(attempts, [1, 2]);
  });

  await scenario('returns roll back invalid orders and keep an accurate ledger for partial inspections', async () => {
    const { sku } = await createSku('RETURN');
    const rma = `RMA-${suffix}`;
    const line = { lineNumber: '1', skuReference: sku.code, expectedQuantity: 2 };
    await own('POST', '/returns', {
      rmaNumber: rma,
      lines: [line, { ...line, lineNumber: '2', skuReference: 'MISSING-SKU-FOR-TEST' }],
    }, 404);
    await own('GET', `/returns/${rma}`, undefined, 404);
    const order = await own('POST', '/returns', { rmaNumber: rma, lines: [line] });
    const base = `/returns/${order.id}/lines/${order.lines[0].id}`;
    await Promise.all([
      own('POST', base + '/receive', { quantity: 1 }),
      own('POST', base + '/receive', { quantity: 1 }),
    ]);
    assert.equal((await own('GET', `/returns/${order.id}`)).lines[0].receivedQuantity, 2);
    await own('POST', base + '/receive', { quantity: 1 }, 409);
    const inspection = { disposition: 'RESTOCK', inspectedQuantity: 1, locationReference: 'A-01-01' };
    const first = await own('POST', base + '/inspect', inspection);
    assert.equal((await own('GET', `/returns/${order.id}`)).status, 'INSPECTION');
    const second = await own('POST', base + '/inspect', inspection);
    assert.equal(first.stockQuantId, second.stockQuantId);
    assert.equal((await own('GET', `/returns/${order.id}`)).status, 'CLOSED');
    assert.equal((await own('GET', `/inventory/quants/${second.stockQuantId}`)).quantity, 2);
    assert.equal(await prisma.stockMovement.count({ where: { sourceSystem: 'RETURNS', referenceId: order.lines[0].id } }), 2);
    await own('POST', base + '/inspect', inspection, 409);
  });

  return scenarios;
}
