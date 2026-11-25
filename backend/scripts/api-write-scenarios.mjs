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
