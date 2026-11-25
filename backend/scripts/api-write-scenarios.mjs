import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const warehouse = '/api/warehouses/MAIN';

function authenticatorCodeForFixture(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(symbol => alphabet.indexOf(symbol).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, '0');
}

export async function runWriteScenarios(suite, { asAdmin, asManager, asWorker, bind, request, login, setMfaMode, prisma, runQueueCycle, baseCom, carrierWebhookSecret }) {
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

  await scenario('a separate test account can enroll and disable MFA with session renewal', async () => {
    const email = `factor-${suffix.toLowerCase()}@example.invalid`;
    const password = `Fixture-${randomUUID()}-42!`;
    const user = await asAdmin('POST', '/api/users', {
      email, password, displayName: 'Authenticator fixture operator',
      roleCode: 'WAREHOUSE_WORKER', warehouseCode: 'MAIN',
    });
    const initial = await login(email, password);
    const asInitial = bind(initial.accessToken);
    const path = '/api/auth/me/mfa';
    assert.deepEqual(await asInitial('GET', path), { available: true, enabled: false, verifiedAt: null });
    await asInitial('POST', path + '/setup');
    const setup = await asInitial('POST', path + '/setup');
    assert.equal(setup.accountName, email);
    assert.equal(/^[A-Z2-7]{32}$/.test(setup.secret), true);
    assert.equal(new URL(setup.otpAuthUri).searchParams.get('secret') === setup.secret, true);
    assert.equal(await prisma.mfaTotpSecret.count({ where: { userId: user.id, verifiedAt: null, disabledAt: null } }), 1);
    await asInitial('POST', path + '/verify', { code: 'invalid' }, 400);
    const enabled = await asInitial('POST', path + '/verify', { code: authenticatorCodeForFixture(setup.secret) });
    assert.equal(enabled.enabled, true);
    assert.ok(Number.isFinite(Date.parse(enabled.verifiedAt)));
    await asInitial('GET', '/api/auth/me', undefined, 401);
    await request('POST', '/api/auth/refresh', { body: { refreshToken: initial.refreshToken }, expected: 401 });
    const saved = await prisma.mfaTotpSecret.findFirstOrThrow({ where: { userId: user.id, disabledAt: null } });
    assert.equal(saved.secretCiphertext.alg, 'A256GCM');
    assert.equal(JSON.stringify(saved.secretCiphertext).includes(setup.secret), false);

    await request('POST', '/api/auth/login', { body: { email, password }, expected: 401 });
    const enrolled = (await request('POST', '/api/auth/login', {
      body: { email, password, mfaCode: authenticatorCodeForFixture(setup.secret) }, expected: 201,
    })).data;
    assert.equal(enrolled.mfaSatisfied, true);
    const asEnrolled = bind(enrolled.accessToken);
    assert.deepEqual(await asEnrolled('GET', path), { available: true, ...enabled });

    let passwordSession;
    setMfaMode('off');
    try {
      const passwordLogin = await login(email, password);
      assert.equal(passwordLogin.mfaRequired, false);
      assert.equal(passwordLogin.mfaSatisfied, false);
      const asPassword = bind(passwordLogin.accessToken);
      assert.equal((await asPassword('GET', '/api/auth/me')).email, email);
      assert.deepEqual(await asPassword('GET', path), { available: false, enabled: false, verifiedAt: null });
      await asPassword('POST', path + '/setup', undefined, 404);
      const code = authenticatorCodeForFixture(setup.secret);
      await asPassword('POST', path + '/verify', { code }, 404);
      await asPassword('POST', path + '/disable', { code }, 404);
      passwordSession = (await request('POST', '/api/auth/refresh', {
        body: { refreshToken: passwordLogin.refreshToken }, expected: 201,
      })).data;
      assert.equal((await bind(passwordSession.accessToken)('GET', '/api/auth/me')).email, email);
    } finally {
      setMfaMode('warn');
    }
    await bind(passwordSession.accessToken)('GET', '/api/auth/me', undefined, 401);
    await request('POST', '/api/auth/refresh', { body: { refreshToken: passwordSession.refreshToken }, expected: 401 });
    assert.deepEqual(await asEnrolled('GET', path), { available: true, ...enabled });

    await asEnrolled('POST', path + '/disable', { code: 'invalid' }, 400);
    const disabled = await asEnrolled('POST', path + '/disable', { code: authenticatorCodeForFixture(setup.secret) });
    assert.deepEqual(disabled, { enabled: false, verifiedAt: null });
    await asEnrolled('GET', '/api/auth/me', undefined, 401);
    await request('POST', '/api/auth/refresh', { body: { refreshToken: enrolled.refreshToken }, expected: 401 });
    const renewed = await login(email, password);
    assert.deepEqual(await bind(renewed.accessToken)('GET', path), { available: true, ...disabled });
    assert.equal(await prisma.mfaTotpSecret.count({ where: { userId: user.id, disabledAt: null } }), 0);
  });

  await scenario('operational summaries respect the requested window and recommendation option', async () => {
    const path = '/decision-support/ops-summary';
    await asWorker('POST', warehouse + path, {}, 403);
    await own('POST', path, { lookbackDays: 0 }, 400);
    await own('POST', path, { lookbackDays: 91 }, 400);
    const summary = await own('POST', path, { lookbackDays: 2, includeRecommendations: false });
    const warehouseRow = await prisma.warehouse.findUniqueOrThrow({ where: { code: 'MAIN' } });
    assert.equal(summary.warehouse.id, warehouseRow.id);
    assert.match(summary.summary, /last 2 days/);
    assert.equal(summary.metrics.parcelsTotal, await prisma.parcel.count({ where: { warehouseId: warehouseRow.id } }));
    assert.equal(summary.engine.externalCalls, false);
    assert.deepEqual(summary.recommendedActions, []);
    assert.ok((await own('POST', path, {})).recommendedActions.length > 0);
  });

  await scenario('exception triage filters warehouse and focus before applying its limit', async () => {
    const main = await prisma.warehouse.create({ data: { code: `TRIAGE-${suffix}`, name: 'Triage fixture warehouse' } });
    const other = await prisma.warehouse.create({
      data: { code: `TRIAGE-OTHER-${suffix}`, name: 'Other triage fixture warehouse' },
    });
    const path = `/api/warehouses/${main.code}/decision-support/exception-triage`;
    await asAdmin('POST', path, {}, 403);
    const email = `triage-${suffix.toLowerCase()}@example.invalid`;
    const password = `Fixture-${randomUUID()}-42!`;
    const operator = await asAdmin('POST', '/api/users', {
      email, password, displayName: 'Triage fixture operator', roleCode: 'WAREHOUSE_WORKER', warehouseCode: 'MAIN',
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'WMS_ADMIN' } });
    await prisma.userRole.create({ data: { userId: operator.id, roleId: role.id, warehouseId: main.id } });
    const asOperator = bind((await login(email, password)).accessToken);
    const triage = (body, expected = 201) => asOperator('POST', path, body, expected);
    await triage({ focus: 'UNKNOWN' }, 400);
    await triage({ limit: 51 }, 400);
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
    const exception = (warehouseId, severity, status, title) => prisma.wmsException.create({
      data: { warehouseId, createdByUserId: actor.id, severity, status, code: `TEST-${suffix}`, title, createdAt: new Date(0) },
    });
    const high = await exception(main.id, 'CRITICAL', 'OPEN', 'Fixture critical exception');
    const low = await exception(main.id, 'LOW', 'OPEN', 'Fixture label issue');
    const resolved = await exception(main.id, 'CRITICAL', 'RESOLVED', 'Fixture resolved issue');
    const unrelated = await exception(other.id, 'CRITICAL', 'OPEN', 'Fixture in another warehouse');
    const first = await triage({ focus: 'HIGH_RISK', limit: 1 });
    assert.deepEqual(first.source, { available: true, scanned: 1 });
    assert.equal(first.recommendations[0].exceptionId, high.id);
    assert.equal(first.recommendations[0].category, 'HIGH_RISK');
    assert.equal(first.recommendations[0].priority, 'critical');
    const open = await triage({ focus: 'OPEN', limit: 50 });
    const openIds = open.recommendations.map(item => item.exceptionId);
    assert.ok(openIds.includes(high.id) && openIds.includes(low.id));
    assert.ok(!openIds.includes(resolved.id) && !openIds.includes(unrelated.id));
    assert.equal(open.recommendations.find(item => item.exceptionId === low.id).category, 'LABELING');
    const all = await triage({ focus: 'ALL', limit: 50 });
    assert.ok(all.recommendations.some(item => item.exceptionId === resolved.id));
    assert.equal((await prisma.wmsException.findUniqueOrThrow({ where: { id: high.id } })).status, 'OPEN');
  });

  await scenario('workflow validation requires a consistent transition and reports missing reasons', async () => {
    const evaluate = body => asAdmin('POST', '/api/workflows/validate-transition', {
      entity: 'outbound-order', currentStatus: 'allocated', ...body,
    });
    const selection = { action: 'release-picking', targetStatus: 'picking' };
    const valid = await evaluate({ ...selection, actorPermissions: ['fulfillment.manage'] });
    assert.equal(valid.allowed, true);
    assert.equal(valid.targetStatus, 'PICKING');
    const noReason = await evaluate({ action: 'cancel', actorPermissions: ['outbound.manage'] });
    assert.deepEqual(noReason.issues.map(issue => issue.code), ['REASON_REQUIRED']);
    const invalid = [
      [selection, 'PERMISSION_REQUIRED'],
      [{ action: 'release-picking', targetStatus: 'cancelled' }, 'INVALID_TARGET_STATUS'],
      [{}, 'UNKNOWN_ACTION'],
    ];
    for (const [body, code] of invalid) {
      const result = await evaluate({ ...body, actorPermissions: [] });
      assert.equal(result.allowed, false, code);
      assert.ok(result.issues.some(issue => issue.code === code), code);
    }
  });

  await scenario('browser telemetry retains diagnostics without storing request query values', async () => {
    const path = '/api/observability/frontend-events';
    const input = {
      type: 'api_failure', severity: 'error', route: '/inventory?search=example',
      source: '/api/warehouses/MAIN/inventory?search=example', message: 'Fixture request failed',
      statusCode: 503, browserOnline: false, metadata: { component: 'Inventory' },
    };
    await request('POST', path, { body: { ...input, statusCode: 600 }, expected: 400 });
    const { data } = await request('POST', path, { body: input, expected: 201 });
    assert.equal(data.accepted, true);
    const runtime = await asAdmin('GET', '/api/observability/runtime');
    const stored = runtime.frontend.recentEvents.find(event => event.id === data.eventId);
    assert.equal(stored.receivedAt, data.receivedAt);
    assert.equal(stored.route, '/inventory');
    assert.equal(stored.source, '/api/warehouses/MAIN/inventory');
    assert.equal(stored.statusCode, 503);
    assert.equal(stored.browserOnline, false);
    assert.equal(stored.message, input.message);
    assert.equal(Object.hasOwn(stored, 'metadata'), false);
  });

  await scenario('SKU creation and product alias updates preserve explicit nullable fields and reject blank names', async () => {
    const product = await asAdmin('POST', '/api/products', { code: `SKU-ALIAS-${suffix}`, name: 'Fixture product' });
    const body = {
      productReference: product.id, code: `SKU-ALIAS-${suffix}`, name: ' Fixture SKU ',
      barcode: `SKU-BARCODE-${suffix}`, weightGrams: 100,
    };
    const sku = await asAdmin('POST', '/api/skus', body);
    assert.equal(sku.name, 'Fixture SKU');
    assert.equal(sku.weightGrams, 100);
    await asAdmin('POST', '/api/skus', body, 409);
    const path = `/api/products/skus/${sku.id}`;
    const changed = await asAdmin('PATCH', path, { name: '  Updated name  ', barcode: null, weightGrams: null });
    assert.equal(changed.name, 'Updated name');
    assert.equal(changed.barcode, null);
    assert.equal(changed.weightGrams, null);
    assert.equal(changed.code, sku.code);
    await asAdmin('PATCH', path, { name: '  ' }, 400);
    await asAdmin('PATCH', path, { code: null }, 400);
    await asAdmin('PATCH', path, { weightGrams: 2_147_483_648 }, 400);
    await asAdmin('POST', '/api/skus', { ...body, code: '  ' }, 400);
    assert.equal((await asAdmin('GET', `/api/skus/${sku.code}`)).name, 'Updated name');
  });

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
    const movement = await own('GET', `/inventory/movements/${received.movement.id}`);
    assert.deepEqual(
      [movement.id, movement.skuId, movement.type, movement.quantityDelta],
      [received.movement.id, sku.id, 'RECEIVE', receipt.quantity],
    );
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

  await scenario('manual reservations validate the order SKU and release each stock hold once', async () => {
    const { sku } = await createSku('RESERVATION');
    const { sku: otherSku } = await createSku('RESERVATION-OTHER');
    const locationReference = 'A-01-01';
    const receive = (skuReference, quantity, status) =>
      own('POST', '/inventory/quants/receive', { skuReference, locationReference, quantity, status });
    const { quant } = await receive(sku.code, 7);
    const { quant: other } = await receive(otherSku.code, 5);
    const { quant: damaged } = await receive(sku.code, 3, 'DAMAGED');
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `MANUAL-RES-${suffix}`,
      lines: [{ lineNumber: '1', sku: sku.code.toLowerCase(), orderedQuantity: 6 }],
    });
    const lineId = order.lines[0].id;
    const path = '/reservations';
    const create = { stockQuantReference: quant.id, outboundOrderLineId: lineId, quantity: 2 };
    await own('POST', path, { ...create, stockQuantReference: other.id }, 409);
    await own('POST', path, { ...create, stockQuantReference: damaged.id }, 409);
    await own('POST', path, { ...create, quantity: 7 }, 409);
    assert.equal(await prisma.reservation.count({ where: { outboundOrderLineId: lineId } }), 0);
    assert.equal(await prisma.stockQuant.count({ where: { id: { in: [other.id, damaged.id] }, reservedQuantity: 0 } }), 2);

    const released = await own('POST', path, create);
    assert.equal(released.status, 'ACTIVE');
    assert.equal(released.sku, sku.code);
    assert.equal(released.outboundOrderId, order.id);
    assert.equal(released.outboundOrderLineId, lineId);
    const releasedPath = `${path}/${released.id}`;
    const task = await prisma.warehouseTask.findFirstOrThrow({ where: { reservationId: released.id } });
    assert.equal(task.status, 'OPEN');
    await own('POST', `/tasks/${task.id}/assign`, {});
    const stock = () => prisma.stockQuant.findUniqueOrThrow({ where: { id: quant.id } });
    assert.equal((await stock()).reservedQuantity, 2);
    const releaseBody = { reason: 'Test release of assigned work' };
    const releases = await Promise.all([
      own('POST', releasedPath + '/release', releaseBody, [201, 409]),
      own('POST', releasedPath + '/release', releaseBody, [201, 409]),
    ]);
    assert.equal(releases.filter(entry => entry.status === 'RELEASED').length, 1);
    assert.equal((await own('GET', releasedPath)).status, 'RELEASED');
    assert.equal((await stock()).reservedQuantity, 0);
    assert.equal((await own('GET', `/tasks/${task.id}`)).status, 'CANCELLED');
    await own('POST', `/tasks/${task.id}/start`, {}, 409);
    const entries = await own('GET', `${path}?sku=${encodeURIComponent(sku.code.toLowerCase())}&status=RELEASED`);
    assert.deepEqual(entries.map(entry => entry.id), [released.id]);
    assert.deepEqual(await own('GET', `${path}?sku=${otherSku.code}&status=RELEASED`), []);

    const cancel = await own('POST', path, { stockQuantReference: quant.id, quantity: 4 });
    const cancelPath = `${path}/${cancel.id}`;
    assert.equal((await stock()).reservedQuantity, 4);
    assert.equal((await own('POST', cancelPath + '/cancel', { reason: 'Test cancellation' })).status, 'CANCELLED');
    await own('POST', cancelPath + '/release', undefined, 409);
    assert.equal((await stock()).reservedQuantity, 0);
    for (const [record, quantity, action] of [[released, 2, 'released'], [cancel, 4, 'cancelled']]) {
      const movements = await prisma.stockMovement.findMany({ where: { reservationId: record.id } });
      assert.deepEqual(movements.map(movement => [movement.type, movement.quantity]).sort(),
        [['CANCEL_RESERVATION', quantity], ['RESERVE', quantity]]);
      assert.equal(await prisma.auditLog.count({ where: { resourceId: record.id, action: `reservation.${action}` } }), 1);
    }

    const racing = await own('POST', path, create);
    const racingTask = await prisma.warehouseTask.findFirstOrThrow({ where: { reservationId: racing.id } });
    const outcomes = await Promise.all([
      own('POST', `${path}/${racing.id}/cancel`, {}, [201, 409]),
      own('POST', `/tasks/${racingTask.id}/start`, {}, [201, 409]),
    ]);
    const cancelled = outcomes[0].status === 'CANCELLED';
    assert.equal(outcomes[1].status === 'IN_PROGRESS', !cancelled);
    assert.equal((await stock()).reservedQuantity, cancelled ? 0 : 2);
    if (!cancelled) {
      await own('POST', `${path}/${racing.id}/release`, {}, 409);
      assert.equal((await stock()).reservedQuantity, 2);
    }
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
    const trackedLot = await own('GET', `/traceability/lots/${lot.id}`);
    assert.deepEqual([trackedLot.id, trackedLot.skuId, trackedLot.lotCode, trackedLot.batch], [lot.id, sku.id, lot.lotCode, 'PLANNED']);
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

  await scenario('lot and serial traceability preserves identities and the latest recorded location', async () => {
    const { sku } = await createSku('SERIAL');
    const { sku: otherSku } = await createSku('SERIAL-OTHER');
    const trace = '/traceability';
    const sourceLocation = await own('GET', '/locations/A-01-01');
    const target = await own('POST', '/locations', {
      code: `SERIAL-${suffix}`, name: 'Traceability test bin', type: 'STORAGE', parentReference: 'A-01',
    });
    const lotBody = {
      skuReference: sku.code, lotCode: `SERIAL-LOT-${suffix}`,
      manufacturedAt: '2026-01-01', expiryDate: '2028-01-01',
    };
    const lot = await own('POST', trace + '/lots', lotBody);
    await own('POST', trace + '/lots', lotBody, 409);
    const lotPath = `${trace}/lots/${lot.id}`;
    await own('PATCH', lotPath, { expiryDate: '2025-01-01' }, 409);
    const released = await own('PATCH', lotPath, { status: 'RELEASED', supplierLot: '  SUPPLIER-1  ' });
    assert.equal(released.supplierLot, 'SUPPLIER-1');
    assert.ok(released.releasedAt);
    assert.equal((await own('PATCH', lotPath, { status: 'RELEASED' })).releasedAt, released.releasedAt);
    const unrelatedLot = await own('POST', trace + '/lots', { skuReference: otherSku.id, lotCode: `OTHER-${suffix}` });

    const inbound = await own('POST', '/inbound-shipments', {
      shipmentNumber: `SERIAL-ASN-${suffix}`, supplierName: 'Traceability fixture supplier',
      lines: [{ lineNumber: '1', sku: sku.code, expectedQuantity: 2 }],
    });
    const receive = locationReference => own('POST', `/inbound-shipments/${inbound.id}/receive`, {
      locationReference, lineReference: '1', quantity: 1, lotReference: lot.lotCode, createPutawayTask: false,
    });
    const { quant: atSource } = await receive(sourceLocation.id);
    const { quant: atTarget } = await receive(target.id);
    const { quant: unrelatedStock } = await own('POST', '/inventory/quants/receive', {
      skuReference: otherSku.id, locationReference: sourceLocation.id, quantity: 1,
    });
    const serials = trace + '/serial-numbers';
    const serialBody = { skuReference: sku.id, serialNumber: `SN-${suffix}`, stockQuantId: atSource.id };
    await own('POST', serials, { ...serialBody, lotReference: unrelatedLot.id }, 409);
    await own('POST', serials, { ...serialBody, stockQuantId: unrelatedStock.id }, 409);
    await own('POST', serials, { ...serialBody, stockQuantId: 'not-a-stock-id' }, 400);
    const created = await own('POST', serials, serialBody);
    assert.equal(created.lotId, lot.id);
    assert.equal(created.lastSeenLocationId, sourceLocation.id);
    await own('POST', serials, serialBody, 409);
    const serialPath = `${serials}/${created.id}`;
    await own('PATCH', serialPath, { stockQuantId: atTarget.id, lastSeenLocationReference: sourceLocation.id }, 409);
    await own('PATCH', serialPath, { stockQuantId: unrelatedStock.id }, 409);
    const moved = await own('PATCH', serialPath, { stockQuantId: atTarget.id, status: 'AVAILABLE' });
    assert.equal(moved.lastSeenLocationId, target.id);
    assert.equal(moved.stockQuantId, atTarget.id);
    const eventPath = serialPath + '/events';
    const backdated = await own('POST', eventPath, {
      eventType: 'OBSERVED', toLocationReference: sourceLocation.id, occurredAt: '2025-01-01T10:00:00.000Z',
    });
    assert.equal(backdated.stockQuantId, null);
    assert.equal((await own('GET', serialPath)).lastSeenLocationId, target.id);
    await own('POST', eventPath, { eventType: 'MOVED', toLocationReference: sourceLocation.id }, 409);
    const transfer = {
      eventType: 'MOVED', fromLocationReference: target.id, toLocationReference: sourceLocation.id, stockQuantId: atSource.id,
    };
    const attempts = await Promise.all([
      own('POST', eventPath, transfer, [201, 409]),
      own('POST', eventPath, transfer, [201, 409]),
    ]);
    assert.equal(attempts.filter(item => item.eventType === 'MOVED').length, 1);
    const saved = await own('GET', serialPath);
    assert.equal(saved.stockQuantId, atSource.id);
    assert.equal(saved.lastSeenLocationId, sourceLocation.id);
    const events = await own('GET', eventPath);
    assert.deepEqual(events.map(event => event.eventType), ['MOVED', 'STATUS_AVAILABLE', 'CREATED', 'OBSERVED']);
    assert.equal(events[1].fromLocationId, sourceLocation.id);
    assert.equal(events[1].toLocationId, target.id);
  });

  await scenario('serialized stock moves the selected labels and records each transfer once', async () => {
    const { sku } = await createSku('SERIAL-TRANSFER');
    const target = await own('POST', '/locations', {
      code: `SERIAL-MOVE-${suffix}`, name: 'Serialized stock destination', type: 'STORAGE', parentReference: 'A-01',
    });
    const { quant: source } = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.id, locationReference: 'A-01-01', quantity: 3, batch: 'SERIAL-MOVE',
    });
    const serials = [];
    for (let index = 1; index <= 3; index++) {
      serials.push(await own('POST', '/traceability/serial-numbers', {
        skuReference: sku.id, serialNumber: `MOVE-SN-${index}-${suffix}`, stockQuantId: source.id,
      }));
    }
    const move = '/inventory/quants/move';
    const body = { quantReference: source.id, toLocationReference: target.id, quantity: 1 };
    await own('POST', move, body, 409);
    await own('POST', move, { ...body, serialNumbers: [`UNKNOWN-${suffix}`] }, 409);
    const part = { ...body, serialNumbers: [serials[0].serialNumber], idempotencyKey: randomUUID() };
    const [first, replay] = await Promise.all([
      own('POST', move, part, 201, part.idempotencyKey),
      own('POST', move, part, 201, part.idempotencyKey),
    ]);
    assert.equal(replay.movement.id, first.movement.id);
    assert.equal((await own('GET', `/inventory/quants/${first.quant.id}`)).quantity, 1);

    const start = async label => {
      const order = await own('POST', '/warehouse-orders', {
        orderType: 'MOVE', orderNumber: `${label}-${suffix}`,
        fromLocationReference: 'A-01-01', toLocationReference: target.id,
        lines: [{ lineNumber: '1', skuReference: sku.id, requestedQuantity: 1, serialRequired: true }],
      });
      const path = `/warehouse-orders/${order.id}`;
      const released = await own('POST', path + '/release');
      return { taskId: released.taskLinks[0].warehouseTaskId, path };
    };
    const desktop = await start('DESKTOP-SERIAL');
    const desktopPath = `/tasks/${desktop.taskId}`;
    await own('POST', desktopPath + '/start', {});
    await own('POST', desktopPath + '/confirm', {}, 409);
    await own('POST', desktopPath + '/confirm', { serialNumbers: [serials[0].serialNumber] }, 409);
    await own('POST', desktopPath + '/confirm', { serialNumbers: [serials[1].serialNumber] });
    assert.equal((await own('POST', desktop.path + '/complete', {})).status, 'COMPLETED');

    const rf = await start('RF-SERIAL');
    const work = (path, data) => asWorker('POST', warehouse + path, data);
    const { sessionId } = await work(`/rf/tasks/${rf.taskId}/start`, {});
    const scan = value => work(`/rf/sessions/${sessionId}/scan`, { scannedValue: value });
    for (const value of ['A-01-01', sku.code, '1']) await scan(value);
    assert.equal((await scan(target.code)).status, 'COMPLETED');
    assert.equal((await own('POST', rf.path + '/complete', {})).status, 'COMPLETED');

    assert.equal((await own('GET', `/inventory/quants/${source.id}`)).quantity, 0);
    assert.equal((await own('GET', `/inventory/quants/${first.quant.id}`)).quantity, 3);
    const movementIds = [];
    for (const serial of serials) {
      const path = `/traceability/serial-numbers/${serial.id}`;
      const saved = await own('GET', path);
      assert.equal(saved.stockQuantId, first.quant.id);
      assert.equal(saved.lastSeenLocationId, target.id);
      const events = await own('GET', path + '/events');
      assert.deepEqual(events.map(event => event.eventType), ['MOVED', 'CREATED']);
      assert.equal(events[0].referenceType, 'STOCK_MOVEMENT');
      movementIds.push(events[0].referenceId);
    }
    assert.equal(movementIds[0], first.movement.id);
    assert.equal(new Set(movementIds).size, 3);
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

  await scenario('manual stock adjustment preserves reservations and applies a concurrent replay only once', async () => {
    const { sku } = await createSku('MANUAL-ADJUST');
    const { quant } = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 6,
    });
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `MANUAL-ADJUST-${suffix}`, lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 4 }],
    });
    await own('POST', `/outbound-orders/${order.id}/allocate`, {});
    const adjust = '/inventory/quants/adjust';
    await asWorker('POST', warehouse + adjust, { quantReference: quant.id, quantity: 7 }, 403);
    await own('POST', adjust, { quantReference: quant.id, quantity: 3 }, 409);
    const body = {
      quantReference: quant.id, quantityDelta: 2, reasonCode: 'FOUND_STOCK',
      reason: 'Test stock found after review', idempotencyKey: randomUUID(),
    };
    const [first, second] = await Promise.all(Array.from({ length: 2 }, () => own('POST', adjust, body, 201, body.idempotencyKey)));
    assert.equal(first.movement.id, second.movement.id);
    assert.equal(first.quant.quantity, 8);
    assert.equal(first.quant.reservedQuantity, 4);
    assert.equal(first.movement.metadata.reasonCode, 'FOUND_STOCK');
    assert.equal(first.movement.metadata.reason, body.reason);
    assert.equal(await prisma.stockMovement.count({ where: { stockQuantId: quant.id, type: 'ADJUST' } }), 1);
    await own('POST', adjust, { ...body, quantityDelta: 3 }, 409, body.idempotencyKey);
    await own('POST', adjust, { ...body, quantityDelta: 2_147_483_647, idempotencyKey: randomUUID() }, 409);
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: quant.id } })).quantity, 8);
  });

  await scenario('cycle count submissions keep unresolved variance visible and approval reconciles stock once', async () => {
    const { sku } = await createSku('DIRECT-COUNT');
    const quantAt = async label => {
      const location = await own('POST', '/locations', {
        code: `DIRECT-COUNT-${label}-${suffix}`, name: `Fixture count ${label}`, type: 'STORAGE', parentReference: 'A-01',
      });
      return (await own('POST', '/inventory/quants/receive', {
        skuReference: sku.code, locationReference: location.id, quantity: 4,
      })).quant;
    };
    const first = await quantAt('A');
    const second = await quantAt('B');
    const plan = await own('POST', '/cycle-counts', { code: `DIRECT-COUNT-${suffix}`, scopeType: 'SKU', scopeReference: sku.code });
    const planPath = `/cycle-counts/${plan.id}`;
    await own('POST', planPath + '/release', {});
    const tasks = await own('GET', planPath + '/tasks');
    assert.equal(tasks.length, 2);
    const variance = tasks.find(task => task.stockQuantId === first.id);
    const exact = tasks.find(task => task.stockQuantId === second.id);
    const variancePath = `/cycle-counts/tasks/${variance.id}`;
    const exactPath = `/cycle-counts/tasks/${exact.id}`;
    await own('POST', variancePath + '/approve', {}, 409);
    const counts = await Promise.all(Array.from({ length: 2 }, () => own('POST', variancePath + '/submit', { countedQuantity: 3 }, [201, 409])));
    assert.equal(counts.filter(result => result.status === 'SUBMITTED').length, 1);
    assert.equal((await own('POST', exactPath + '/submit', { countedQuantity: 4 })).varianceQuantity, 0);
    assert.equal((await prisma.cycleCountPlan.findUniqueOrThrow({ where: { id: plan.id } })).status, 'RECONCILING');
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: first.id } })).quantity, 4);
    await own('POST', '/inventory/quants/adjust', { quantReference: first.id, quantity: 5 }, 409);
    await prisma.stockQuant.update({ where: { id: first.id }, data: { quantity: 5 } });
    await own('POST', variancePath + '/approve', {}, 409);
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: first.id } })).quantity, 5);
    await prisma.stockQuant.update({ where: { id: first.id }, data: { quantity: 4 } });
    const approvals = await Promise.all(Array.from({ length: 2 }, () => own('POST', variancePath + '/approve', {}, [201, 409])));
    assert.equal(approvals.filter(result => result.adjustmentCreated).length, 1);
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: first.id } })).quantity, 3);
    const movement = await prisma.stockMovement.findMany({ where: { referenceId: variance.id, type: 'ADJUST' } });
    assert.equal(movement.length, 1);
    assert.equal(movement[0].quantity, 1);
    const done = await own('POST', exactPath + '/approve', {});
    assert.equal(done.adjustmentCreated, false);
    assert.equal(done.planCompleted, true);
    assert.equal(await prisma.stockFreeze.count({ where: { planId: plan.id, status: 'ACTIVE' } }), 0);
  });

  await scenario('direct packing and shipping follow picking and record each movement once', async () => {
    const { sku } = await createSku('DIRECT-FULFILLMENT');
    const parcel = await own('POST', '/parcels', { trackingNumber: `DIRECT-PARCEL-${suffix}` });
    const receive = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 4,
    });
    const order = await own('POST', '/outbound-orders', {
      orderNumber: `DIRECT-FULFILLMENT-${suffix}`,
      lines: [{ lineNumber: '10', sku: sku.code, orderedQuantity: 2, parcelReference: parcel.id }],
    });
    const orderPath = `/outbound-orders/${order.id}`;
    const pack = `/packing/${order.id}/pack`;
    const ship = `/shipping/${order.id}/ship`;
    await own('POST', pack, {}, 409);
    await own('POST', ship, {}, 409);
    await own('POST', orderPath + '/allocate', {});
    await own('POST', orderPath + '/release-picking', {});
    const tasks = await prisma.warehouseTask.findMany({ where: { outboundOrderId: order.id, type: 'PICK' } });
    assert.equal(tasks.length, 1);
    await own('POST', `/tasks/${tasks[0].id}/confirm-pick`, { orderReference: order.id, quantity: 2 });
    const pickedStock = await prisma.stockQuant.findUniqueOrThrow({ where: { id: receive.quant.id } });
    const race = async (path, body, status) => {
      const responses = await Promise.all(Array.from({ length: 2 }, () => own('POST', path, body, [201, 409])));
      const successful = responses.filter(response => response.order?.status === status);
      assert.equal(successful.length, 1);
      assert.equal(successful[0].movementsCreated, 1);
    };
    await race(pack, { packageReference: `DIRECT-${suffix}` }, 'PACKED');
    assert.equal((await own('GET', `/parcels/${parcel.id}`)).status, 'PACKED');
    await race(ship, { carrier: 'INTERNAL', trackingReference: parcel.trackingNumber }, 'SHIPPED');
    assert.equal((await own('GET', `/parcels/${parcel.id}`)).status, 'SHIPPED');
    assert.equal((await own('GET', orderPath)).status, 'SHIPPED');
    const journal = await prisma.stockMovement.findMany({
      where: { referenceId: order.id, type: { in: ['PACK', 'SHIP'] } },
      orderBy: { type: 'asc' },
    });
    assert.deepEqual(journal.map(entry => [entry.type, entry.quantity]), [['PACK', 2], ['SHIP', 2]]);
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: receive.quant.id } })).quantity, pickedStock.quantity);
  });

  await scenario('packing stations require a valid location and audit concurrent creation once', async () => {
    const path = '/packing-stations';
    const location = await own('POST', '/locations', {
      code: `PACK-LOC-${suffix}`, name: 'Fixture packing location', type: 'PACKING', parentReference: 'A-01',
    });
    const input = { code: `pack-station-${suffix.toLowerCase()}`, name: '  Fixture station  ', locationReference: location.id };
    await own('POST', path, { ...input, locationReference: 'MISSING-PACKING-LOCATION' }, 404);
    const attempts = await Promise.all([own('POST', path, input, [201, 409]), own('POST', path, input, [201, 409])]);
    const created = attempts.filter(attempt => attempt.id);
    assert.equal(created.length, 1);
    const [station] = created;
    assert.equal(station.code, input.code.toUpperCase());
    assert.equal(station.name, 'Fixture station');
    assert.equal(station.locationId, location.id);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: station.id, action: 'packing.station_created' } }), 1);
    assert.ok((await own('GET', path)).some(entry => entry.id === station.id));
    await own('POST', path, { ...input, code: '   ' }, 400);
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
    const draftsBefore = await own('GET', `${path}/billing-invoices?status=DRAFT&take=1`);
    assert.deepEqual(draftsBefore.items.map(item => item.id), [invoice.id]);
    const billable = await own('GET', `${path}/billing-events?status=BILLABLE&take=1`);
    assert.deepEqual(billable.items.map(item => item.id), [event.id]);
    const summary = await own('GET', `${path}/billing-summary?eventType=PICK`);
    assert.equal(summary.clientId, client.id);
    assert.equal(summary.currency, 'EUR');
    assert.equal(summary.billableAmountMinor, 2400);
    assert.deepEqual(summary.byType, [{ eventType: 'PICK', count: 1, amountMinor: 2400 }]);
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
    assert.equal((await own('GET', invoicePath)).status, 'FINALIZED');
    assert.equal((await ledger()).status, 'INVOICED');
    const invoiced = await own('GET', `${path}/billing-summary?status=INVOICED`);
    assert.deepEqual([invoiced.billableEvents, invoiced.invoicedEvents, invoiced.invoicedAmountMinor], [0, 1, 2400]);
    const csv = await own('GET', invoicePath + '/export');
    assert.equal(csv.filename, invoice.invoiceNumber + '.csv');
    assert.equal(csv.contentType, 'text/csv');
    assert.match(csv.csv, /^invoiceNumber,clientCode,warehouseCode/);
    assert.match(csv.csv, /2400,2100,504,2904,EUR\s*$/);
    const pdf = await own('GET', invoicePath + '/export.pdf');
    assert.equal(pdf.filename, invoice.invoiceNumber + '.pdf');
    assert.equal(pdf.contentType, 'application/pdf');
    const contents = Buffer.from(pdf.pdfBase64, 'base64').toString('latin1');
    assert.match(contents, /^%PDF-[0-9.]+/);
    assert.match(contents, /%%EOF\s*$/);
    assert.ok(contents.includes(invoice.invoiceNumber));
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

  await scenario('billing credits include only valid invoice lines and finalize each line once', async () => {
    const client = await asAdmin('POST', '/api/clients', {
      code: `CREDIT-${suffix}`, name: 'Credit note fixture client', billingCurrency: 'EUR',
    });
    const path = `/clients/${client.code}`;
    await own('POST', path + '/attach', {});
    const makeInvoice = async (day, prices, invoiceNumber) => {
      const events = [];
      for (const [index, unitPriceMinor] of prices.entries()) {
        events.push(await own('POST', path + '/billing-events', {
          eventType: 'PICK', status: 'BILLABLE', reference: `CREDIT-${suffix}-${day}-${index}`,
          quantity: 1, unitPriceMinor, occurredAt: `2026-10-${day}T12:0${index}:00.000Z`,
        }));
      }
      const invoice = await own('POST', path + '/billing-invoices', {
        periodStart: `2026-10-${day}T00:00:00.000Z`, periodEnd: `2026-10-${Number(day) + 1}T00:00:00.000Z`,
        vatRateBps: 2100, invoiceNumber,
      });
      return { invoice, events, invoicePath: `${path}/billing-invoices/${invoice.id}` };
    };

    const { invoice, invoicePath, events } = await makeInvoice('20', [1200, 800], 'TEST-' + 'X'.repeat(115));
    const credits = invoicePath + '/credit-notes';
    await own('POST', credits, { invoiceLineNumbers: [1] }, 409);
    await own('POST', invoicePath + '/finalize', {});
    await own('POST', credits, { invoiceLineNumbers: [1, 999] }, 409);
    await own('POST', credits, { invoiceLineNumbers: [] }, 409);
    await own('POST', credits, { invoiceLineNumbers: [1], finalize: 'false' }, 400);
    assert.equal(await prisma.billingCreditNote.count({ where: { invoiceId: invoice.id } }), 0);

    const draft = { invoiceLineNumbers: [1], reason: 'Fixture correction' };
    const candidates = await Promise.all([
      own('POST', credits, draft, [201, 409]),
      own('POST', credits, draft, [201, 409]),
    ]);
    const drafts = candidates.filter(item => item.status === 'DRAFT');
    assert.equal(drafts.length, 1);
    const [credit] = drafts;
    assert.equal(credit.lines.length, 1);
    assert.equal(credit.lines[0].invoiceLineId, invoice.lines[0].id);
    assert.equal(credit.subtotalMinor, 1200);
    assert.equal(credit.taxTotalMinor, 252);
    assert.equal(credit.totalAmountMinor, 1452);

    const creditPath = `${path}/billing-credit-notes/${credit.id}`;
    const results = await Promise.all([
      own('POST', creditPath + '/finalize', { metadata: { confirmed: true } }, [201, 409]),
      own('POST', creditPath + '/finalize', { metadata: { confirmed: true } }, [201, 409]),
    ]);
    assert.equal(results.filter(item => item.status === 'FINALIZED').length, 1);
    assert.equal((await own('GET', creditPath)).metadata.confirmed, true);
    const posted = await own('GET', `${path}/billing-credit-notes?invoiceReference=${invoice.id}&status=FINALIZED`);
    assert.deepEqual(posted.items.map(item => item.id), [credit.id]);
    const csv = await own('GET', creditPath + '/export');
    assert.equal(csv.filename, credit.creditNoteNumber + '.csv');
    assert.equal(csv.contentType, 'text/csv');
    assert.match(csv.csv, /^creditNoteNumber,invoiceNumber,clientCode/);
    assert.ok(csv.csv.includes(invoice.invoiceNumber));
    const pdf = await own('GET', creditPath + '/export.pdf');
    assert.equal(pdf.filename, credit.creditNoteNumber + '.pdf');
    assert.equal(pdf.contentType, 'application/pdf');
    const contents = Buffer.from(pdf.pdfBase64, 'base64').toString('latin1');
    assert.match(contents, /^%PDF-[0-9.]+/);
    assert.match(contents, /%%EOF\s*$/);
    assert.ok(contents.includes(credit.creditNoteNumber));
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: credit.id, type: 'BILLING_CREDIT_NOTE_FINALIZED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: credit.id, action: 'billing.credit_note_finalized' } }), 1);
    await own('POST', credits, { invoiceLineNumbers: [1], finalize: true }, 409);
    await own('POST', credits, { invoiceLineNumbers: [2], creditNoteNumber: credit.creditNoteNumber }, 409);
    const remaining = await own('POST', credits, { invoiceLineNumbers: [2], finalize: true });
    assert.equal(remaining.status, 'FINALIZED');
    assert.equal(remaining.totalAmountMinor, 968);
    assert.equal(remaining.lines[0].invoiceLineId, invoice.lines[1].id);
    assert.notEqual(remaining.creditNoteNumber, credit.creditNoteNumber);
    assert.equal(await prisma.billingCreditNote.count({ where: { invoiceId: invoice.id } }), 2);
    await own('POST', invoicePath + '/void', { reason: 'Credit is already posted' }, 409);
    assert.equal((await own('GET', invoicePath)).status, 'FINALIZED');
    assert.equal(await prisma.billingEvent.count({ where: { id: { in: events.map(event => event.id) }, status: 'INVOICED' } }), 2);

    const other = await makeInvoice('21', [500]);
    await own('POST', other.invoicePath + '/finalize', {});
    const savedDraft = await own('POST', other.invoicePath + '/credit-notes', { finalize: false });
    const savedDraftPath = `${path}/billing-credit-notes/${savedDraft.id}`;
    const transitions = await Promise.all([
      own('POST', other.invoicePath + '/void', { reason: 'Concurrent invoice cancellation' }, [201, 409]),
      own('POST', savedDraftPath + '/finalize', {}, [201, 409]),
    ]);
    const voided = transitions[0].status === 'VOIDED';
    assert.equal(transitions[1].status === 'FINALIZED', !voided);
    assert.equal((await own('GET', savedDraftPath)).status, voided ? 'VOIDED' : 'FINALIZED');
    const event = await prisma.billingEvent.findUniqueOrThrow({ where: { id: other.events[0].id } });
    assert.equal(event.status, voided ? 'BILLABLE' : 'INVOICED');
    await own('POST', path + '/billing-invoices', {
      periodStart: '2026-10-22T00:00:00.000Z', periodEnd: '2026-10-22T23:59:00.000Z',
    }, 400);
  });

  await scenario('long client invoices and credit notes export as multi-page PDFs', async () => {
    const client = await asAdmin('POST', '/api/clients', {
      code: `PDF-${suffix}`, name: 'PDF fixture client', billingCurrency: 'CZK',
    });
    const path = `/clients/${client.code}`;
    const attachment = await own('POST', path + '/attach', {});
    const lineCount = 40;
    await prisma.billingEvent.createMany({
      data: Array.from({ length: lineCount }, (_, index) => ({
        clientId: client.id, warehouseId: attachment.warehouseId, eventType: 'PICK', status: 'BILLABLE',
        reference: `PDF-${suffix}-${index}`, description: `Příjem a výdej zboží (${index + 1})`,
        quantity: 1, unitPriceMinor: 100, amountMinor: 100, currency: 'CZK',
        occurredAt: new Date('2026-10-22T12:00:00.000Z'),
      })),
    });
    const invoice = await own('POST', path + '/billing-invoices', {
      periodStart: '2026-10-22T00:00:00.000Z', periodEnd: '2026-10-23T00:00:00.000Z',
      vatRateBps: 2100, finalize: true,
    });
    assert.equal(invoice.lines.length, lineCount);
    assert.equal(invoice.totalAmountMinor, 4840);
    const invoicePath = `${path}/billing-invoices/${invoice.id}`;
    const credit = await own('POST', invoicePath + '/credit-notes', { finalize: true });
    assert.equal(credit.lines.length, lineCount);
    assert.equal(credit.totalAmountMinor, invoice.totalAmountMinor);

    for (const [documentPath, documentNumber] of [
      [invoicePath, invoice.invoiceNumber],
      [`${path}/billing-credit-notes/${credit.id}`, credit.creditNoteNumber],
    ]) {
      const exported = await own('GET', documentPath + '/export.pdf');
      assert.equal(exported.contentType, 'application/pdf');
      assert.equal(exported.filename, documentNumber + '.pdf');
      const pdf = Buffer.from(exported.pdfBase64, 'base64').toString('latin1');
      const pages = [...pdf.matchAll(/\/Type \/Page\b/g)].length;
      assert.ok(pages > 1, 'The export must paginate a long billing document');
      assert.ok(pdf.includes(documentNumber));
      assert.ok(pdf.includes('/ToUnicode'), 'Accented item text needs a Unicode mapping');
      assert.match(pdf, /%%EOF\s*$/);
    }
  });

  await scenario('client setup validates rate cards, aliases, access and warehouse-safe ownership', async () => {
    const { sku } = await createSku('CLIENT-OPS');
    const client = await asAdmin('POST', '/api/clients', { code: `OPS-A-${suffix}`, name: 'First test client' });
    const other = await asAdmin('POST', '/api/clients', { code: `OPS-B-${suffix}`, name: 'Second test client' });
    const path = `/clients/${client.code}`;
    const otherPath = `/clients/${other.code}`;
    const attachment = await own('POST', path + '/attach', {});
    await own('POST', otherPath + '/attach', {});
    const ratePath = path + '/rate-cards';
    const rate = { eventType: 'PICK', unit: 'EA', unitPriceMinor: 700, vatRateBps: 2100 };
    const card = { name: 'Fixture rates', currency: 'CZK', validFrom: '2026-01-01', validTo: '2027-01-01', rates: [rate] };
    await own('POST', ratePath, { ...card, rates: [rate, { ...rate, unit: ' ea ' }] }, 409);
    await own('POST', ratePath, { ...card, validTo: card.validFrom }, 409);
    await own('POST', ratePath, { ...card, name: '  ' }, 400);
    assert.deepEqual(await own('GET', ratePath), []);
    const savedCard = await own('POST', ratePath, { ...card, rates: [rate, { ...rate, eventType: 'PACK', unitPriceMinor: 900 }] });
    assert.equal(savedCard.currency, 'CZK');
    assert.deepEqual(savedCard.rates.map(item => [item.eventType, item.unit, item.unitPriceMinor]).sort(),
      [['PACK', 'EA', 900], ['PICK', 'EA', 700]]);
    assert.equal((await own('GET', ratePath))[0].id, savedCard.id);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: savedCard.id, type: 'CLIENT_RATE_CARD_CREATED' } }), 1);

    const aliasPath = path + '/sku-aliases';
    const aliasBody = { skuReference: sku.code, clientSku: ' sku-client-1 ', clientBarcode: '87654321000' };
    await asWorker('POST', warehouse + aliasPath, aliasBody, 403);
    await own('POST', aliasPath, { ...aliasBody, clientSku: '   ' }, 400);
    const alias = await own('POST', aliasPath, aliasBody);
    const updatedAlias = await own('POST', aliasPath, { ...aliasBody, clientSku: 'SKU-CLIENT-1', description: 'Updated client SKU' });
    assert.equal(updatedAlias.id, alias.id);
    const aliasRow = await prisma.clientSkuAlias.findUniqueOrThrow({ where: { id: alias.id } });
    assert.equal(aliasRow.warehouseId, attachment.warehouseId);
    assert.equal(aliasRow.skuId, sku.id);
    assert.equal(aliasRow.description, 'Updated client SKU');
    const otherAlias = await own('POST', otherPath + '/sku-aliases', aliasBody);
    assert.notEqual(otherAlias.id, alias.id);

    const email = `client-access-${suffix.toLowerCase()}@example.invalid`;
    const password = `Fixture-${randomUUID()}-42!`;
    const user = await asAdmin('POST', '/api/users', {
      email, password, displayName: 'Test client worker', roleCode: 'WAREHOUSE_WORKER', warehouseCode: 'MAIN',
    });
    const account = bind((await login(email, password)).accessToken);
    const userPath = path + '/user-access';
    await own('POST', userPath, { userReference: 'missing@example.invalid' }, 404);
    const readAccess = async () => (await account('GET', '/api/auth/me')).clientAccess.find(item => item.clientId === client.id);
    assert.equal(await readAccess(), undefined);
    const grant = await own('POST', userPath, { userReference: email.toUpperCase() });
    assert.equal(grant.userId, user.id);
    assert.equal((await readAccess()).isActive, true);
    const revoke = await own('POST', userPath, { userReference: user.id, isActive: false });
    assert.equal(revoke.id, grant.id);
    assert.equal((await readAccess()).isActive, false);
    const accessEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: grant.id, type: 'CLIENT_USER_ACCESS_GRANTED' },
    });
    assert.deepEqual(accessEvents.map(event => event.payload.isActive).sort(), [false, true]);

    const outsideWarehouse = await prisma.warehouse.create({ data: { code: `OTHER-${suffix}`, name: 'Other fixture warehouse' } });
    const outsideLocation = await prisma.warehouseLocation.create({
      data: { warehouseId: outsideWarehouse.id, code: 'STORAGE', name: 'Fixture storage', type: 'STORAGE' },
    });
    const outsideStock = await prisma.stockQuant.create({
      data: { warehouseId: outsideWarehouse.id, locationId: outsideLocation.id, skuId: sku.id, quantity: 4 },
    });
    const stock = await own('POST', '/inventory/quants/receive', { skuReference: sku.code, locationReference: 'A-01-01', quantity: 2 });
    const linkPath = path + '/resource-links';
    const linkBody = { resourceType: 'STOCK_QUANT', resourceId: stock.quant.id, externalReference: 'CLIENT-STOCK' };
    await own('POST', linkPath, { ...linkBody, resourceId: outsideStock.id }, 404);
    await own('POST', linkPath, { ...linkBody, resourceId: randomUUID() }, 404);
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: outsideStock.id } })).ownerClientId, null);
    assert.deepEqual(await own('GET', linkPath), []);
    const link = await own('POST', linkPath, linkBody);
    const owner = async () => (await prisma.stockQuant.findUniqueOrThrow({ where: { id: stock.quant.id } })).ownerClientId;
    assert.equal(await owner(), client.id);
    const otherLink = otherPath + '/resource-links';
    await own('POST', otherLink, linkBody, 409);
    await own('POST', otherLink, { ...linkBody, allowOwnerTransfer: { unexpected: true } }, 400);
    assert.equal(await owner(), client.id);
    const transferred = await own('POST', otherLink, { ...linkBody, allowOwnerTransfer: true });
    assert.equal(transferred.id, link.id);
    assert.equal(await owner(), other.id);
    assert.deepEqual(await own('GET', linkPath), []);
    assert.equal((await own('GET', otherLink))[0].id, link.id);
    const snapshot = await own('GET', otherPath + '/ownership/snapshot');
    assert.deepEqual(snapshot, {
      clientId: other.id, warehouseId: attachment.warehouseId,
      resourceCounts: [{ resourceType: 'STOCK_QUANT', count: 1 }],
    });
    assert.deepEqual((await own('GET', path + '/ownership/snapshot')).resourceCounts, []);
  });

  await scenario('storage billing uses daily captures and bills overlapping periods once', async () => {
    const { sku } = await createSku('STORAGE-FEE');
    const client = await asAdmin('POST', '/api/clients', { code: `STORAGE-${suffix}`, name: 'Storage fee fixture' });
    const empty = await asAdmin('POST', '/api/clients', { code: `STORAGE-EMPTY-${suffix}`, name: 'Empty storage fixture' });
    const path = `/clients/${client.code}`;
    const { warehouseId } = await own('POST', path + '/attach', {});
    await own('POST', `/clients/${empty.code}/attach`, {});
    const { quant } = await own('POST', '/inventory/quants/receive', {
      skuReference: sku.code, locationReference: 'A-01-01', quantity: 9, ownerClientReference: client.code,
    });
    const utcDay = offset => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() + offset);
      return date;
    };
    const days = [-3, -2, -1, 0, 1].map(utcDay);
    const [first, second, third, today, tomorrow] = days;
    const scope = { warehouseId, clientId: client.id };
    const generate = path + '/billing-events/storage-days/generate';
    const period = (start, end, input = {}) => ({ periodStart: start.toISOString(), periodEnd: end.toISOString(), ...input });
    await own('POST', generate, period(first, third, { unitPriceMinorPerUnitDay: 5 }), 409);
    await own('POST', generate, period(today, tomorrow, { unitPriceMinorPerUnitDay: 5 }), 400);

    await runQueueCycle();
    const capturedToday = await prisma.storageOccupancyCapture.findFirstOrThrow({ where: { ...scope, snapshotDate: today } });
    assert.ok(capturedToday.capturedAt >= today);
    assert.equal((await prisma.storageOccupancySnapshot.findFirstOrThrow({
      where: { ...scope, snapshotDate: today, stockQuantId: quant.id },
    })).quantity, 9);
    assert.equal(await prisma.storageOccupancyCapture.count({ where: { warehouseId, clientId: empty.id, snapshotDate: today } }), 1);
    await prisma.stockQuant.update({ where: { id: quant.id }, data: { quantity: 14 } });
    const { captureDailyStorageOccupancy } = await import('../dist/clients/storage-occupancy.js');
    await Promise.all([captureDailyStorageOccupancy(prisma), captureDailyStorageOccupancy(prisma)]);
    const recaptured = await prisma.storageOccupancySnapshot.findMany({
      where: { ...scope, snapshotDate: today, stockQuantId: quant.id },
    });
    assert.deepEqual(recaptured.map(snapshot => snapshot.quantity), [9]);

    await prisma.storageOccupancyCapture.createMany({
      data: [first, second, third].map(snapshotDate => ({ ...scope, snapshotDate })),
    });
    await prisma.storageOccupancySnapshot.createMany({
      data: [[first, 3], [second, 6]].map(([snapshotDate, quantity]) => ({
        ...scope, snapshotDate, quantity, skuId: sku.id, locationId: quant.locationId, stockQuantId: quant.id,
        metadata: { skuCode: sku.code },
      })),
    });
    await own('POST', path + '/rate-cards', {
      name: 'First daily rate', currency: 'CZK', validFrom: first, validTo: second,
      rates: [{ eventType: 'STORAGE_DAY', unit: 'UNIT_DAY', unitPriceMinor: 5 }],
    });
    await own('POST', path + '/rate-cards', {
      name: 'Second daily rate', currency: 'EUR', validFrom: second,
      rates: [{ eventType: 'STORAGE_DAY', unit: 'UNIT_DAY', unitPriceMinor: 8 }],
    });
    const preview = await own('POST', generate, period(first, third, { dryRun: true }));
    assert.equal(preview.created, 0);
    assert.deepEqual(preview.events.map(event => [event.quantity, event.amountMinor, event.currency, event.occurredAt]),
      [[3, 15, 'CZK', first.toISOString()], [6, 48, 'EUR', second.toISOString()]]);
    const storageEvents = () => prisma.billingEvent.findMany({ where: { ...scope, eventType: 'STORAGE_DAY' } });
    assert.deepEqual(await storageEvents(), []);
    const generated = await Promise.all([
      own('POST', generate, period(first, third)),
      own('POST', generate, period(first, today)),
    ]);
    assert.equal(generated.reduce((sum, result) => sum + result.created, 0), 2);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: client.id, type: 'STORAGE_DAY_BILLING_GENERATED' } }), 1);
    const saved = await storageEvents();
    assert.equal(saved.length, 2);
    const invoices = path + '/billing-invoices';
    await own('POST', invoices, period(first, third), 409);
    await own('POST', invoices, period(first, third, { currency: 'CZK', finalize: 'false' }), 400);
    const [czk, eur] = await Promise.all([
      own('POST', invoices, period(first, third, { currency: 'czk' })),
      own('POST', invoices, period(first, third, { currency: 'EUR' })),
    ]);
    assert.deepEqual([czk.currency, czk.subtotalMinor, eur.currency, eur.subtotalMinor], ['CZK', 15, 'EUR', 48]);
    assert.notEqual(czk.invoiceNumber, eur.invoiceNumber);
    await own('POST', `${invoices}/${eur.id}/finalize`, {});
    const replay = await own('POST', generate, period(second, today, { unitPriceMinorPerUnitDay: 99, currency: 'CZK' }));
    assert.equal(replay.created, 0);
    assert.deepEqual(replay.events.map(event => [event.quantity, event.amountMinor, event.currency, event.status]), [
      [6, 48, 'EUR', 'INVOICED'],
    ]);

    await own('POST', path + '/billing-events', {
      eventType: 'STORAGE_DAY', status: 'BILLABLE', reference: `STOR-LEGACY-${suffix}`, quantity: 1, unitPriceMinor: 5,
      occurredAt: today, metadata: period(third, today),
    });
    await own('POST', generate, period(third, today), 409);
    assert.equal((await storageEvents()).length, 3);
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
    const accountPath = `/api/users/${user.id}`;
    assert.equal((await asAdmin('GET', accountPath)).email, email);
    await asWorker('GET', accountPath, undefined, 403);
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

  await scenario('inbox redelivery preserves the original message and terminal decisions are recorded once', async () => {
    const inbox = '/api/inbox/events';
    const alias = '/api/outbox/events/inbox';
    const body = {
      sourceSystem: `QUEUE-${suffix}`,
      externalEventId: `QUEUE-RECEIVED-${suffix}`,
      eventType: 'TEST_INCOMING',
      payload: { sku: 'FIXTURE', quantity: 1 },
      headers: { correlationId: suffix, processedMetadata: 'Sender header' },
    };
    const received = await asAdmin('POST', inbox, body);
    const processedPath = `${alias}/${received.id}/processed`;
    const processed = await asAdmin('POST', processedPath, { resourceType: 'SKU', resourceId: 'FIXTURE', metadata: { mapped: true } });
    assert.equal(processed.status, 'PROCESSED');
    assert.deepEqual(processed.headers, { correlationId: suffix, processedMetadata: { mapped: true } });
    const replay = await asAdmin('POST', alias, body);
    assert.equal(replay.id, received.id);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.attempts, 1);
    assert.equal(replay.resourceId, 'FIXTURE');
    const persisted = await prisma.inboxEvent.findUniqueOrThrow({ where: { id: received.id } });
    assert.deepEqual(persisted.headers, body.headers);
    await asAdmin('POST', inbox, { ...body, headers: { ...body.headers, correlationId: 'changed' } }, 409);
    await asAdmin('POST', inbox, { ...body, eventType: 'INCOMING_WRONG_TYPE' }, 409);
    await asAdmin('POST', inbox, { ...body, sourceSystem: '   ' }, 400);
    const reread = await asAdmin('POST', processedPath, { resourceId: 'NOT-THE-ORIGINAL' });
    assert.equal(reread.resourceId, 'FIXTURE');
    assert.equal(reread.attempts, 1);

    const second = { ...body, externalEventId: `QUEUE-RACE-${suffix}`, headers: { correlationId: suffix } };
    const receipts = await Promise.all([asAdmin('POST', inbox, second), asAdmin('POST', alias, second)]);
    assert.equal(receipts[0].id, receipts[1].id);
    assert.deepEqual(receipts.map(entry => entry.duplicate).sort(), [false, true]);
    const id = receipts[0].id;
    const competing = await Promise.all([
      asAdmin('POST', `${alias}/${id}/processed`, {}, [201, 409]),
      asAdmin('POST', `${inbox}/${id}/failed`, { errorMessage: 'Fixture failure' }, [201, 409]),
    ]);
    assert.equal(competing.filter(item => ['FAILED', 'PROCESSED'].includes(item.status)).length, 1);
    assert.equal((await prisma.inboxEvent.findUniqueOrThrow({ where: { id } })).attempts, 1);

    const failedBody = { ...body, externalEventId: `QUEUE-FAILED-${suffix}`, headers: undefined };
    const failed = await asAdmin('POST', inbox, failedBody);
    const failedPath = `${inbox}/${failed.id}/failed`;
    await asAdmin('POST', failedPath, { errorMessage: '  ' }, 400);
    await asAdmin('POST', failedPath, { errorMessage: 'Original failure', metadata: { parser: 'fixture' } });
    const failedReplay = await asAdmin('POST', failedPath, { errorMessage: 'Duplicate failure' });
    assert.equal(failedReplay.lastError, 'Original failure');
    assert.equal(failedReplay.attempts, 1);
    assert.equal((await asAdmin('POST', alias, failedBody)).duplicate, true);
    await asAdmin('POST', `${alias}/${failed.id}/processed`, {}, 409);

    const legacy = await prisma.inboxEvent.create({
      data: {
        sourceSystem: body.sourceSystem, externalEventId: `QUEUE-LEGACY-${suffix}`, type: body.eventType,
        status: 'PROCESSED', attempts: 1, processedAt: new Date(), payload: body.payload,
        headers: { correlationId: suffix, processedMetadata: { legacy: true } },
      },
    });
    const legacyReplay = await asAdmin('POST', inbox, {
      ...body, externalEventId: legacy.externalEventId, headers: { correlationId: suffix },
    });
    assert.equal(legacyReplay.id, legacy.id);
    assert.equal(legacyReplay.duplicate, true);
    assert.deepEqual(legacyReplay.headers.processedMetadata, { legacy: true });
  });

  await scenario('outbox workers respect endpoint filters and resume a dead-letter event once', async () => {
    const [{ timezone }] = await prisma.$queryRaw`SELECT current_setting('TimeZone') AS timezone`;
    assert.equal(timezone, 'Europe/Prague');
    const eventType = `OUTBOX-FIXTURE-${suffix}`;
    const received = [];
    let rejectDelivery = true;
    let onDelivery;
    const receiver = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ route: req.url, payload });
      await onDelivery?.(payload);
      res.writeHead(rejectDelivery ? 503 : 200);
      res.end('fixture');
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${receiver.address().port}`;
    const endpointIds = [];
    try {
      for (const [name, types, path] of [
        ['Matching fixture', [eventType], '/business-events'],
        ['Unrelated fixture', ['ANOTHER-FIXTURE-EVENT'], '/unrelated'],
      ]) {
        const endpoint = await prisma.integrationEndpoint.create({
          data: {
            code: `${name.startsWith('Matching') ? 'MATCH' : 'OTHER'}-${suffix}`, name, type: 'ERP',
            status: 'ACTIVE', baseUrl, config: { eventTypes: types, path },
          },
        });
        endpointIds.push(endpoint.id);
      }
      const event = await prisma.outboxEvent.create({
        data: { type: eventType, aggregateType: 'fixture', aggregateId: suffix, payload: { test: true } },
      });
      const outbox = '/api/outbox/events';
      const dispatch = outbox + '/dispatch';
      const worker = '/api/jobs/queue-worker/run-once';
      const dispatchBody = { eventType, take: 2, maxAttempts: 2, retryDelaySeconds: 60 };
      const readEvent = () => prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      const preview = await asAdmin('POST', dispatch, { ...dispatchBody, dryRun: true });
      assert.equal(preview.skipped, 1);
      assert.equal((await readEvent()).attempts, 0);
      assert.deepEqual(received, []);
      const first = await asAdmin('POST', dispatch, dispatchBody);
      assert.equal(first.claimed, 1);
      assert.equal(first.retried, 1);
      assert.equal((await readEvent()).status, 'PENDING');
      assert.equal((await asAdmin('POST', worker, dispatchBody)).claimed, 0);
      assert.deepEqual(received.map(call => call.route), ['/business-events']);
      await asAdmin('POST', dispatch, { ...dispatchBody, dryRun: 'false' }, 400);

      await prisma.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(0) } });
      const second = await asAdmin('POST', dispatch, dispatchBody);
      assert.equal(second.failed, 1);
      const letters = await asAdmin('GET', outbox + '/dead-letter?' + new URLSearchParams({ eventType }));
      assert.equal(letters[0].id, event.id);
      assert.equal(letters[0].attempts, 2);
      const requeuePath = `${outbox}/dead-letter/${event.id}/requeue`;
      await asAdmin('POST', requeuePath, { reason: '   ' }, 400);
      await asAdmin('POST', requeuePath, { reason: 'Fixture recovered', resetAttempts: 'false' }, 400);
      const requeued = await Promise.all([
        asAdmin('POST', requeuePath, { reason: 'Fixture recovered', resetAttempts: false }, [201, 409]),
        asAdmin('POST', requeuePath, { reason: 'Competing action', resetAttempts: false }, [201, 409]),
      ]);
      const ready = requeued.filter(entry => entry.deliveryStatus === 'PENDING');
      assert.equal(ready.length, 1);
      assert.equal(ready[0].headers.requeueHistory.length, 1);
      assert.equal(ready[0].attempts, 2);
      rejectDelivery = false;
      const results = await Promise.all([
        asAdmin('POST', worker, dispatchBody),
        asAdmin('POST', dispatch, dispatchBody),
      ]);
      assert.equal(results.reduce((count, result) => count + result.claimed, 0), 1);
      assert.equal(results.reduce((count, result) => count + result.dispatched, 0), 1);
      const saved = await readEvent();
      assert.equal(saved.status, 'SENT');
      assert.equal(saved.attempts, 3);
      assert.equal(saved.lastError, null);
      assert.deepEqual(received.map(call => [call.route, call.payload.id, call.payload.attempt]), [
        ['/business-events', event.id, 0], ['/business-events', event.id, 1], ['/business-events', event.id, 2],
      ]);
      await asAdmin('POST', requeuePath, { reason: 'Already sent' }, 409);

      const newClaim = new Date(Date.now() + 600_000);
      const reclaimed = await prisma.outboxEvent.create({
        data: { type: eventType, aggregateType: 'fixture', aggregateId: suffix, payload: { test: true } },
      });
      onDelivery = async payload => {
        if (payload.id === reclaimed.id) {
          await prisma.outboxEvent.update({
            where: { id: reclaimed.id }, data: { availableAt: newClaim },
          });
        }
      };
      const stale = await asAdmin('POST', dispatch, dispatchBody);
      assert.equal(stale.claimed, 1);
      assert.equal(stale.skipped, 1);
      assert.equal(stale.dispatched, 0);
      const activeClaim = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: reclaimed.id } });
      assert.equal(activeClaim.status, 'PROCESSING');
      assert.equal(activeClaim.availableAt.toISOString(), newClaim.toISOString());
      assert.equal(activeClaim.attempts, 0);
    } finally {
      await prisma.integrationEndpoint.updateMany({ where: { id: { in: endpointIds } }, data: { status: 'INACTIVE' } });
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
    }
  });

  await scenario('configured endpoints validate changes, hide credentials and report test results', async () => {
    const calls = [];
    const key = randomUUID();
    const receiver = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      calls.push({ path: incoming.url, key: incoming.headers['x-fixture-key'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      if (incoming.url === '/disconnected') return outgoing.destroy();
      outgoing.writeHead(incoming.url === '/declined' ? 422 : 200);
      outgoing.end('Fixture response');
    });
    await new Promise((resolve, reject) => receiver.listen(0, '127.0.0.1', resolve).once('error', reject));
    try {
      const endpoints = '/api/integrations/endpoints';
      const body = {
        code: ` endpoint-${suffix.toLowerCase()} `, type: 'WEBHOOK', name: 'Fixture endpoint',
        baseUrl: `http://127.0.0.1:${receiver.address().port}`, authType: 'API_KEY',
        config: { auth: { apiKeyHeader: 'X-Fixture-Key', apiKey: key }, path: '/health' },
      };
      await asWorker('POST', endpoints, body, 403);
      await asAdmin('POST', endpoints, { ...body, code: '   ' }, 400);
      await asAdmin('POST', endpoints, { ...body, baseUrl: 'ftp://127.0.0.1' }, 400);
      const initial = await asAdmin('POST', endpoints, body);
      assert.equal(initial.code, body.code.trim().toUpperCase());
      assert.notEqual(initial.config.auth.apiKey, key);
      await asAdmin('POST', endpoints, { ...body, code: initial.code }, 409);
      const path = `${endpoints}/${initial.id}`;
      await asAdmin('PATCH', path, { name: null }, 400);
      await asAdmin('PATCH', path, { name: '   ' }, 400);
      const changed = await asAdmin('PATCH', path, { name: 'Renamed fixture', config: { ...initial.config, path: '/ready' } });
      assert.equal(changed.name, 'Renamed fixture');
      assert.equal(changed.config.path, '/ready');
      assert.notEqual(changed.config.auth.apiKey, key);
      const stored = await prisma.integrationEndpoint.findUniqueOrThrow({ where: { id: initial.id } });
      assert.equal(stored.config.auth.apiKey, key);
      await asAdmin('POST', `${endpoints}/${randomUUID()}/test`, {}, 404);
      await asAdmin('POST', path + '/test', { path: 'http://127.0.0.1:1/other' }, 400);
      assert.deepEqual(calls, []);
      const ping = await asAdmin('POST', path + '/test', { eventType: 'FIXTURE_HEALTH', payload: { ping: true } });
      assert.equal(ping.success, true);
      assert.equal(ping.statusCode, 200);
      assert.equal(new URL(ping.url).pathname, '/ready');
      assert.deepEqual(calls[0], { path: '/ready', key, body: { eventType: 'FIXTURE_HEALTH', payload: { ping: true }, generatedAt: calls[0].body.generatedAt } });
      const rejected = await asAdmin('POST', path + '/test', { path: '/declined' });
      assert.equal(rejected.statusCode, 422);
      assert.equal(rejected.success, false);
      await asAdmin('POST', path + '/test', { path: '/disconnected' }, 502);
      const logs = await prisma.integrationDispatchLog.findMany({
        where: { endpointId: initial.id }, orderBy: { createdAt: 'asc' },
      });
      assert.deepEqual(logs.map(log => [log.statusCode, log.success]), [[200, true], [422, false], [null, false]]);
      assert.equal(JSON.stringify(logs).includes(key), false);
    } finally {
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
    }
  });

  await scenario('Base.com imports confirmed orders and syncs only after real warehouse dispatch', async () => {
    const path = `${warehouse}/integrations/base-com`;
    const importPath = path + '/orders/import';
    const syncPath = path + '/orders/sync-dispatch';
    const { sku } = await createSku('BASE-COM');
    const orderId = Number.parseInt(suffix, 16) + 1;
    const remote = { confirmed: false, statusId: 7100, statusWrites: 0, products: [{ sku: sku.code.toLowerCase(), quantity: 2 }] };
    baseCom.orders.set(orderId, remote);
    const input = { orderId };
    assert.deepEqual(await asAdmin('GET', path), { configured: true, dispatchSyncConfigured: true });
    await asWorker('POST', importPath, input, 403);
    await asAdmin('POST', importPath, { orderId: orderId + 1 }, 404);
    await asAdmin('POST', importPath, input, 422);
    remote.confirmed = true;
    const lines = remote.products;
    remote.products = [{ sku: 'UNKNOWN-FIXTURE', quantity: 1 }];
    await asAdmin('POST', importPath, input, 422);
    assert.equal(await prisma.outboundOrder.count({ where: { orderNumber: `BASE-${orderId}` } }), 0);
    remote.products = lines;
    await asAdmin('POST', syncPath, input, 404);
    const imports = await Promise.all([
      asAdmin('POST', importPath, input, 200),
      asAdmin('POST', importPath, input, 200),
    ]);
    assert.deepEqual(imports.map(item => item.created).sort(), [false, true]);
    const { order } = imports[0];
    assert.equal(imports[1].order.id, order.id);
    assert.deepEqual(order.lines.map(line => [line.sku, line.orderedQuantity]), [[sku.code, 2]]);
    assert.equal(await prisma.externalIdMapping.count({ where: { resourceId: order.id } }), 1);
    await asAdmin('POST', syncPath, input, 422);
    assert.equal(remote.statusWrites, 0);

    await own('POST', '/inventory/quants/receive', { skuReference: sku.code, locationReference: 'A-01-01', quantity: 2 });
    const orderPath = `/outbound-orders/${order.id}`;
    await own('POST', orderPath + '/allocate', {});
    await own('POST', orderPath + '/release-picking', {});
    const tasks = (await own('GET', `/tasks?type=PICK&sku=${encodeURIComponent(sku.code)}`))
      .filter(task => task.outboundOrderId === order.id);
    assert.equal(tasks.reduce((total, task) => total + task.quantity, 0), 2);
    for (const task of tasks) {
      await own('POST', `/tasks/${task.id}/confirm-pick`, { orderReference: order.id, quantity: task.quantity });
    }
    const shipment = await own('POST', '/shipments', {
      shipmentNumber: `SHP-BASE-${suffix}`, outboundOrderReference: order.id, packingStationReference: 'PACK-01',
      carrier: 'EXPRESS_CARRIER',
    });
    const shipmentPath = `/shipments/${shipment.id}`;
    const pack = await own('POST', shipmentPath + '/packages', {
      packageCode: `BOX-BASE-${suffix}`,
      contents: [{ sku: sku.code, outboundOrderLineReference: order.lines[0].id, quantity: 2 }],
    });
    const staged = await own('POST', shipmentPath + '/stage', {});
    assert.equal(staged.status, 'STAGED');
    await own('POST', shipmentPath + '/ship', {}, 409);
    await own('POST', shipmentPath + '/labels', { packageReference: pack.id, labelFormat: 'ZPL' });
    assert.equal((await own('POST', shipmentPath + '/ship', {})).status, 'SHIPPED');
    assert.equal((await own('GET', orderPath)).status, 'SHIPPED');

    const externalSystem = { where: { code: 'BASE_COM' } };
    await prisma.externalSystem.update({ ...externalSystem, data: { status: 'INACTIVE' } });
    try {
      await asAdmin('POST', importPath, input, 409);
      await asAdmin('POST', syncPath, input, 409);
      assert.equal(remote.statusWrites, 0);
    } finally {
      await prisma.externalSystem.update({ ...externalSystem, data: { status: 'ACTIVE' } });
    }
    const updates = await Promise.all([
      asAdmin('POST', syncPath, input, 200),
      asAdmin('POST', syncPath, input, 200),
    ]);
    assert.deepEqual(updates.map(item => item.updated).sort(), [false, true]);
    assert.equal(remote.statusId, baseCom.shippedStatus);
    assert.equal(remote.statusWrites, 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'base_com.dispatch_synced', resourceId: order.id } }), 1);
  });

  await scenario('integration replay links the queued message once and only sends it to the failed endpoint', async () => {
    const received = [];
    const receiver = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      received.push({ path: incoming.url, event: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      outgoing.writeHead(200);
      outgoing.end('Fixture response');
    });
    await new Promise((resolve, reject) => receiver.listen(0, '127.0.0.1', resolve).once('error', reject));
    const baseUrl = `http://127.0.0.1:${receiver.address().port}`;
    const eventType = `REPLAY_FIXTURE_${suffix}`;
    const endpointIds = [];
    try {
      for (const segment of ['failed', 'already-delivered']) {
        const endpoint = await prisma.integrationEndpoint.create({
          data: {
            code: `REPLAY-${segment}-${suffix}`, name: 'Replay fixture endpoint', type: 'WEBHOOK', status: 'ACTIVE',
            baseUrl, config: { eventTypes: [eventType], path: '/' + segment },
          },
        });
        endpointIds.push(endpoint.id);
      }
      const path = '/api/integrations/enterprise/dead-letters';
      const publish = '/api/outbox/events/dispatch';
      const original = await prisma.outboxEvent.create({
        data: { type: eventType, aggregateType: 'order', aggregateId: suffix, payload: { order: suffix },
          status: 'SENT', sentAt: new Date(), attempts: 1 },
      });
      const letter = await prisma.integrationDeadLetter.create({
        data: { eventType, endpointId: endpointIds[0], outboxEventId: original.id, payload: original.payload,
          errorMessage: 'Fixture transport failure', fingerprint: `REPLAY-${suffix}` },
      });
      const letterPath = `${path}/${letter.id}`;
      const replayPath = letterPath + '/replay';
      await asAdmin('PATCH', letterPath, { status: 'REPLAYED' }, 400);
      const resolved = await asAdmin('PATCH', letterPath, { status: 'RESOLVED', note: 'Reviewed by operator' });
      assert.equal(resolved.status, 'RESOLVED');
      await asAdmin('PATCH', letterPath, { status: 'RESOLVED', note: 'Second acknowledgement' });
      assert.equal(await prisma.auditLog.count({ where: { resourceId: letter.id, action: 'integration_dead_letter.resolved' } }), 1);
      await asAdmin('POST', replayPath, {}, 409);
      const requests = await Promise.all([
        asAdmin('POST', replayPath, { force: true, note: 'Retry reviewed connection' }),
        asAdmin('POST', replayPath, { force: true, note: 'Competing replay' }),
      ]);
      assert.deepEqual(requests.map(item => item.replayCreated).sort(), [false, true]);
      const [replay] = requests;
      assert.equal(requests[1].outboxEventId, replay.outboxEventId);
      assert.notEqual(replay.outboxEventId, original.id);
      const originalAfter = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(originalAfter.status, 'SENT');
      assert.equal(originalAfter.sentAt.toISOString(), original.sentAt.toISOString());
      const audited = await prisma.integrationDeadLetter.findUniqueOrThrow({ where: { id: letter.id } });
      assert.equal(audited.outboxEventId, original.id);
      assert.equal(audited.replayOutboxEventId, replay.outboxEventId);
      const reported = (await asAdmin('GET', path + '?status=REPLAYED')).find(item => item.id === letter.id);
      assert.equal(reported?.outboxEventId, original.id);
      assert.equal(reported?.replayOutboxEventId, replay.outboxEventId);
      assert.equal(await prisma.auditLog.count({ where: { resourceId: letter.id, action: 'integration_dead_letter.replayed' } }), 1);
      const sent = await asAdmin('POST', publish, { eventType });
      assert.equal(sent.dispatched, 1);
      assert.deepEqual(received.map(call => [call.path, call.event.payload]), [['/failed', original.payload]]);
      assert.equal(received[0].event.id, replay.outboxEventId);
      const stable = await asAdmin('POST', replayPath, {});
      assert.equal(stable.outboxEventId, replay.outboxEventId);
      assert.equal(stable.replayCreated, false);

      const unlinked = await prisma.integrationDeadLetter.create({
        data: { eventType, endpointId: endpointIds[0], payload: { order: 'unlinked' },
          errorMessage: 'Fixture without a source outbox event', fingerprint: `UNLINKED-${suffix}` },
      });
      const unlinkedPath = `${path}/${unlinked.id}/replay`;
      const initial = await asAdmin('POST', unlinkedPath, {});
      const later = await asAdmin('POST', unlinkedPath, {});
      assert.equal(initial.replayCreated, true);
      assert.equal(later.outboxEventId, initial.outboxEventId);
      assert.equal(later.replayCreated, false);
      const firstEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: initial.outboxEventId } });
      assert.equal(firstEvent.status, 'PENDING');
      assert.equal(firstEvent.targetEndpointId, endpointIds[0]);
      assert.equal(await prisma.outboxEvent.count({ where: { type: eventType } }), 3);

      const legacyId = randomUUID();
      const legacyPayload = { order: 'legacy' };
      const legacy = await prisma.outboxEvent.create({
        data: { type: eventType, aggregateType: 'order', aggregateId: suffix,
          payload: { replayedDeadLetterId: legacyId, originalPayload: legacyPayload }, status: 'SENT', sentAt: new Date() },
      });
      await prisma.integrationDeadLetter.create({
        data: { id: legacyId, eventType, endpointId: endpointIds[0], payload: legacyPayload, status: 'REPLAYED',
          replayedAt: new Date(), metadata: { outboxEventId: legacy.id }, errorMessage: 'Older replay record',
          fingerprint: `LEGACY-${suffix}` },
      });
      const legacyPath = `${path}/${legacyId}/replay`;
      assert.equal((await asAdmin('POST', legacyPath, {})).outboxEventId, legacy.id);
      const legacyReplay = await asAdmin('POST', legacyPath, { force: true });
      assert.equal(legacyReplay.replayCreated, true);
      const restored = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: legacyReplay.outboxEventId } });
      assert.deepEqual(restored.payload, legacyPayload);
      assert.equal(restored.targetEndpointId, endpointIds[0]);
    } finally {
      await prisma.integrationEndpoint.updateMany({ where: { id: { in: endpointIds } }, data: { status: 'INACTIVE' } });
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
    }
  });

  await scenario('operations integration preserves applied events and tracks retries up to the configured limit', async () => {
    const events = '/operations-runtime/integrations/events';
    const input = { connectorCode: `OPS-${suffix}`, flow: 'order.import', externalId: 'APPLY', maxAttempts: 2 };
    const original = await own('POST', events, input);
    assert.equal(original.state, 'WAITING');
    assert.equal(original.attempts, 0);
    const path = `${events}/${original.id}`;
    const applications = await Promise.all([
      own('POST', path + '/apply', { mapping: { result: 'first' } }),
      own('POST', path + '/apply', { mapping: { result: 'second' } }),
    ]);
    assert.deepEqual(applications.map(item => [item.state, item.attempts]), [['APPLIED', 1], ['APPLIED', 1]]);
    assert.equal(applications[0].updatedAt, applications[1].updatedAt);
    const duplicate = await own('POST', events, { ...input, maxAttempts: 7 });
    assert.deepEqual(duplicate, applications[0]);
    await own('POST', path + '/retry', {}, 409);
    await own('POST', `${events}/${randomUUID()}/apply`, {}, 404);
    await own('POST', events + '/invalid/retry', {}, 400);
    await own('POST', events, { ...input, externalId: '  ' }, 400);

    const failed = await own('POST', events, { ...input, externalId: 'FAIL' });
    const retryPath = `${events}/${failed.id}/retry`;
    const scheduled = await own('POST', retryPath, {});
    assert.equal(scheduled.state, 'RETRYING');
    assert.equal(scheduled.attempts, 1);
    assert.ok(Date.parse(scheduled.retryAfter) > Date.now());
    const exhausted = await own('POST', retryPath, {});
    assert.equal(exhausted.state, 'DEAD_LETTER');
    assert.equal(exhausted.attempts, 2);
    assert.equal(exhausted.retryAfter, null);
    const restarted = await own('POST', retryPath, {});
    assert.deepEqual([restarted.state, restarted.attempts], ['RETRYING', 1]);
  });

  await scenario('operations reconciliation counts only the requested connector and flow', async () => {
    const integrations = '/operations-runtime/integrations';
    const connectorCode = `OPS-RECON-${suffix}`;
    const event = (flow, state, externalId, code = connectorCode) =>
      own('POST', integrations + '/events', { connectorCode: code, flow, state, externalId });
    await event('order.import', 'APPLIED', 'APPLIED');
    await event('order.import', 'DEAD_LETTER', 'DEAD');
    await event('inventory.publish', 'DEAD_LETTER', 'OTHER-FLOW');
    await event('order.import', 'DEAD_LETTER', 'OTHER-CONNECTOR', `${connectorCode}-OTHER`);
    const run = await own('POST', integrations + '/reconciliation-runs', {
      connectorCode: connectorCode.toLowerCase(), flow: 'order.import',
    });
    assert.equal(run.connectorCode, connectorCode);
    assert.equal(run.summary.checked, 2);
    assert.equal(run.summary.deadLetters, 1);
    assert.equal(run.summary.flow, 'order.import');
    assert.equal(run.mismatches, 1);
    const saved = (await own('GET', integrations + '/command-center')).reconciliation;
    assert.deepEqual([saved.lastRunAt, saved.status, saved.mismatches], [run.createdAt, run.status, run.mismatches]);
  });

  await scenario('operations rules apply scope and both bounds without matching disabled rules', async () => {
    const rules = '/operations-runtime/configuration/rules';
    const code = `OPS-RULE-${suffix}`;
    const input = { code, name: 'Fixture routing', type: 'CARRIER_ROUTING', priority: 71,
      scope: { client: 'FIXTURE' }, conditions: { quantity: { min: 2, max: 10 } }, actions: { route: 'FIXTURE' } };
    await asWorker('POST', warehouse + rules, input, 403);
    const main = await own('POST', rules, input);
    const disabled = await own('POST', rules, { ...input, code: code + '-OFF', enabled: false });
    const evaluate = async context => {
      const result = await own('POST', rules + '/evaluate', { ruleTypes: ['CARRIER_ROUTING'], context });
      assert.ok(!result.matchedRules.some(rule => rule.id === disabled.id));
      return result.recommendedActions.find(item => item.ruleCode === code);
    };
    assert.deepEqual(await evaluate({ client: 'FIXTURE', quantity: 10 }), { ruleCode: code, action: input.actions });
    assert.equal(await evaluate({ client: 'FIXTURE', quantity: 11 }), undefined);
    assert.equal(await evaluate({ client: 'OTHER', quantity: 5 }), undefined);
    assert.equal(await evaluate({ client: 'FIXTURE', quantity: null }), undefined);
    const updated = await own('POST', rules, { ...input, name: 'Updated routing' });
    assert.equal(updated.id, main.id);
    assert.equal(updated.name, 'Updated routing');
  });

  await scenario('operations labels sanitize printable data and queue real tests once for configured printers', async () => {
    const path = '/operations-runtime/integrations/print/test-label';
    const reference = `FIXTURE-${suffix} ^ ~ printable`;
    const jobsBefore = await own('GET', '/print-jobs');
    const printed = await own('POST', path, { stationCode: 'pack-01', reference });
    assert.equal(printed.dryRun, true);
    assert.equal(printed.event.state, 'APPLIED');
    assert.equal(printed.stationCode, 'PACK-01');
    assert.ok(printed.zplPreview.startsWith('^XA') && printed.zplPreview.endsWith('^XZ'));
    assert.ok(!printed.zplPreview.includes('^ ~'));
    assert.equal(printed.printJobId, null);
    const jobsAfter = await own('GET', '/print-jobs');
    assert.deepEqual(jobsAfter, jobsBefore);

    const stationCode = `OPS-PRINTER-${suffix}`;
    const agentCode = `OPS-PRINT-AGENT-${suffix}`;
    const token = randomUUID();
    const test = { stationCode, reference, dryRun: false };
    await own('POST', path, test, 404);
    await own('POST', '/printers', { code: stationCode, name: 'Test printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' });
    await own('POST', '/print-agents', { code: agentCode, name: 'Test agent', token, printerCodes: [stationCode] });
    const queued = await own('POST', path, test);
    assert.equal(queued.dryRun, false);
    assert.equal(queued.event.state, 'WAITING');
    assert.ok(queued.printJobId);
    assert.deepEqual(await own('POST', path, test), queued);
    const claimed = await request('POST', warehouse + '/print-agent/jobs/claim', { body: { agentCode, token }, expected: 201 });
    assert.deepEqual(claimed.data.jobs.map(job => job.id), [queued.printJobId]);
    assert.equal(claimed.data.jobs[0].renderedZpl, printed.zplPreview);
  });

  await scenario('reconciliation reports orphan and missing mappings inside the requested warehouse and owner', async () => {
    const external = '/api/integrations/enterprise';
    const system = await asAdmin('POST', external + '/external-systems', {
      code: `RECON-${suffix}`, name: 'Reconciliation fixture', systemType: 'ERP',
    });
    const owner = await asAdmin('POST', '/api/clients', { code: `RECON-OWNER-${suffix}`, name: 'Reconciliation owner' });
    const otherOwner = await asAdmin('POST', '/api/clients', { code: `RECON-OTHER-${suffix}`, name: 'Other fixture owner' });
    const main = await prisma.warehouse.findUniqueOrThrow({ where: { code: 'MAIN' } });
    const outside = await prisma.warehouse.create({ data: { code: `RECON-OUT-${suffix}`, name: 'Other fixture warehouse' } });
    const order = (tag, warehouseId, ownerClientId) => prisma.outboundOrder.create({
      data: { warehouseId, ownerClientId, orderNumber: `RECON-${tag}-${suffix}` },
    });
    const valid = await order('VALID', main.id, owner.id);
    const missing = await order('MISSING', main.id, owner.id);
    const wrongWarehouse = await order('OUTSIDE', outside.id, owner.id);
    const wrongOwner = await order('OWNER', main.id, otherOwner.id);
    const scope = { externalSystemId: system.id, resourceType: 'OUTBOUND_ORDER', warehouseId: main.id, ownerClientId: owner.id };
    await prisma.externalIdMapping.createMany({ data: [
      { ...scope, resourceId: valid.id, externalId: 'VALID' },
      { ...scope, resourceId: missing.id, externalId: 'WRONG-MAPPING-SCOPE', warehouseId: outside.id },
      { ...scope, resourceId: wrongWarehouse.id, externalId: 'WRONG-WAREHOUSE' },
      { ...scope, resourceId: wrongOwner.id, externalId: 'WRONG-OWNER' },
      { ...scope, resourceId: randomUUID(), externalId: 'MISSING-ID' },
    ] });
    const run = external + '/reconciliation/run';
    await asAdmin('POST', run, { warehouseReference: `MISSING-${suffix}` }, 404);
    const report = await asAdmin('POST', run, {
      warehouseReference: main.code, ownerClientReference: owner.code, externalSystemReference: system.code,
      resourceType: 'OUTBOUND_ORDER', metadata: { fixture: suffix },
    });
    assert.deepEqual(report.resources, [{
      resourceType: 'OUTBOUND_ORDER', mappedCount: 4, orphanMappingCount: 3, missingMappingCount: 1,
    }]);
    assert.equal(report.warehouseId, main.id);
    assert.equal(report.ownerClientId, owner.id);
    assert.equal(report.externalSystemId, system.id);
    const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: report.auditLogId } });
    assert.equal(audit.action, 'integration.reconciliation_run');
    assert.equal(audit.metadata.requestedMetadata.fixture, suffix);
    const saved = await asAdmin('GET', external + '/reconciliation/report');
    assert.equal(saved.auditLogId, audit.id);
    assert.deepEqual(saved.resources, report.resources);
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

  await scenario('scanner writes link parcels and respect maintenance state while the resolver checks warehouse codes', async () => {
    const scanner = await own('POST', '/scanners', { code: `DIRECT-SCAN-${suffix}`, name: 'Fixture scanner' });
    const scannerPath = `/scanners/${scanner.id}`;
    const parcel = await own('POST', '/parcels', { trackingNumber: `DIRECT-SCAN-PARCEL-${suffix}` });
    const scan = await own('POST', scannerPath + '/scans', {
      value: ` ${parcel.trackingNumber} `, symbology: 'CODE128', operation: 'RECEIVE',
    });
    assert.equal(scan.result, 'MATCHED');
    assert.equal(scan.match.parcel.id, parcel.id);
    assert.equal(scan.scan.value, parcel.trackingNumber);
    assert.equal(scan.trackingEventCreated, true);
    assert.equal(await prisma.trackingEvent.count({ where: { parcelId: parcel.id, type: 'SCANNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: parcel.id, action: 'scanner.scan.logged' } }), 1);
    const missing = await own('POST', scannerPath + '/scans', { value: 'MISSING-SCAN-PARCEL' });
    assert.equal(missing.result, 'UNMATCHED');
    assert.equal(missing.trackingEventCreated, false);
    const found = await asWorker('POST', warehouse + '/scans/resolve', { scannedValue: 'AARD1:LOC:MAIN:A-01-01' });
    assert.equal(found.resolved.found, true);
    assert.equal(found.resolved.code, 'A-01-01');
    await asWorker('POST', warehouse + '/scans/resolve', { scannedValue: 'AARD1:LOC:OTHER:A-01-01' }, 400);
    await asWorker('POST', warehouse + '/scans/resolve', { scannedValue: '   ' }, 400);
    await own('POST', scannerPath + '/scans', { value: '   ' }, 400);
    await own('PATCH', scannerPath, { status: 'MAINTENANCE' });
    const telemetry = await own('PATCH', scannerPath + '/telemetry', { batteryLevel: 20 });
    assert.equal(telemetry.status, 'MAINTENANCE');
    assert.equal(telemetry.batteryLevel, 20);
    await own('POST', scannerPath + '/scans', { value: parcel.trackingNumber }, 409);
    assert.equal(await prisma.trackingEvent.count({ where: { parcelId: parcel.id, type: 'SCANNED' } }), 1);
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

  await scenario('label templates validate blank content and preview a layout without scheduling a print job', async () => {
    const path = '/label-templates';
    const body = { code: `LABEL-${suffix}`, name: 'Fixture label', type: 'PARCEL', content: '^XA^FO40,40^FD{{trackingNumber}}^FS^XZ' };
    await asWorker('POST', warehouse + path, body, 403);
    const saved = await own('POST', path, body);
    assert.equal(saved.code, body.code);
    assert.equal(saved.content, body.content);
    await own('POST', path, body, 409);
    assert.ok((await own('GET', path)).some(template => template.id === saved.id));
    const queuedBefore = await own('GET', '/print-jobs');
    const preview = await own('POST', `${path}/${saved.code}/render-preview`, {
      layout: { widthMm: 100, heightMm: 150, dpi: 203, fields: [{ type: 'text', x: 6, y: 10, binding: 'title' }] },
      payload: { title: 'Fixture parcel' },
    });
    assert.ok(preview.zpl.startsWith('^XA') && preview.zpl.endsWith('^XZ'));
    assert.ok(preview.zpl.includes('Fixture parcel'));
    assert.deepEqual(await own('GET', '/print-jobs'), queuedBefore);
    await own('POST', path, { ...body, code: body.code + '-EMPTY', content: '   ' }, 400);
  });

  await scenario('print retry releases a failed job for a fresh attempt while reassignment respects claims', async () => {
    const jobs = '/print-jobs';
    const connect = async name => {
      const printerCode = `RETRY-${name}-${suffix}`;
      const agentCode = `AGENT-${name}-${suffix}`;
      const token = randomUUID();
      await own('POST', '/printers', { code: printerCode, name: 'Fixture printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' });
      await own('POST', '/print-agents', { code: agentCode, name: 'Fixture agent', token, printerCodes: [printerCode] });
      const credentials = { agentCode, token };
      return {
        printerCode, agentCode,
        claim: async () => (await request('POST', warehouse + '/print-agent/jobs/claim', { body: credentials, expected: 201 })).data.jobs,
        report: async (id, status) => (await request('POST', `${warehouse}/print-agent/jobs/${id}/result`, {
          body: { ...credentials, status, ...(status === 'FAILED' ? { errorMessage: 'Fixture printer offline' } : {}) }, expected: 201,
        })).data,
      };
    };
    const first = await connect('FIRST');
    const second = await connect('SECOND');
    const body = { printerCode: first.printerCode, agentCode: first.agentCode, renderedZpl: '^XA^FO40,40^FDFixture^FS^XZ', maxAttempts: 1 };
    const job = await own('POST', jobs, body);
    const action = `${jobs}/${job.id}`;
    assert.deepEqual((await first.claim()).map(item => item.id), [job.id]);
    await own('POST', action + '/retry', {}, 409);
    await own('POST', action + '/reassign', { printerCode: second.printerCode, agentCode: second.agentCode }, 409);
    assert.equal((await first.report(job.id, 'FAILED')).status, 'FAILED');
    const restarted = await own('POST', action + '/retry', {});
    assert.deepEqual([restarted.status, restarted.attempts, restarted.errorMessage], ['QUEUED', 0, null]);
    assert.deepEqual((await first.claim()).map(item => item.id), [job.id]);
    assert.equal((await first.report(job.id, 'PRINTED')).status, 'PRINTED');
    await own('POST', action + '/retry', {}, 409);
    const queued = await own('POST', jobs, body);
    const reroute = `${jobs}/${queued.id}/reassign`;
    await own('POST', reroute, { printerCode: second.printerCode, agentCode: first.agentCode }, 409);
    const reassigned = await own('POST', reroute, { printerCode: second.printerCode, agentCode: second.agentCode });
    assert.deepEqual([reassigned.id, reassigned.printerCode, reassigned.agentCode], [queued.id, second.printerCode, second.agentCode]);
    assert.equal((await first.claim()).length, 0);
    assert.deepEqual((await second.claim()).map(item => item.id), [queued.id]);
    assert.equal((await second.report(queued.id, 'PRINTED')).status, 'PRINTED');
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

  await scenario('configuration rules match valid inputs and preserve concurrent metadata edits', async () => {
    const path = '/configuration';
    const rules = path + '/rules';
    const ruleType = 'CARRIER_ROUTING';
    const base = { ruleType, code: `ROUTING-${suffix}`, name: 'Warehouse fallback', priority: 200, status: 'ACTIVE' };
    const fallback = await own('POST', rules, { ...base, actions: { service: 'STANDARD' } });
    const client = await asAdmin('POST', '/api/clients', { code: `RULES-${suffix}`, name: 'Rules fixture client' });
    const override = {
      ...base, code: `OVERRIDE-${suffix}`, name: 'Client override', ownerClientReference: client.code,
      priority: 1, conditions: { match: { 'parcel.grams': { min: 0, max: 1000 }, country: ['CZ', 'SK'] } },
      actions: { service: 'EXPRESS' }, metadata: { origin: 'fixture' },
    };
    const clientRule = await own('POST', rules, override);
    assert.equal(clientRule.ownerClientId, client.id);
    assert.equal((await own('POST', rules, override)).id, clientRule.id);
    const simulate = (context, ownerClientReference = client.code) =>
      own('POST', path + '/simulate', { ruleType, ownerClientReference, context });
    for (const value of [null, '', ' ', false, [], {}, 'infinity', -1, 1001]) {
      const result = await simulate({ country: 'CZ', parcel: { grams: value } });
      assert.equal(result.matchedRule.id, fallback.id, `Invalid weight: ${JSON.stringify(value)}`);
    }
    assert.equal((await simulate({ country: 'CZ' })).matchedRule.id, fallback.id);
    assert.equal((await simulate({ country: 'DE', parcel: { grams: 500 } })).matchedRule.id, fallback.id);
    const context = { country: 'SK', parcel: { grams: 1000 } };
    const chosen = await simulate(context);
    assert.equal(chosen.matchedRule.id, clientRule.id);
    assert.deepEqual(chosen.decision, { service: 'EXPRESS' });
    assert.equal((await simulate(context, null)).matchedRule.id, fallback.id);

    const rulePath = rules + '/' + clientRule.id;
    await own('POST', rules, { ...override, code: '   ' }, 400);
    await own('PATCH', rulePath, { name: '   ' }, 400);
    for (const match of [null, [], { grams: {} }, { grams: { minimum: 10 } }, { grams: { min: 200, max: 50 } }]) {
      await own('PATCH', rulePath, { conditions: { match } }, 400);
    }
    await Promise.all([
      own('PATCH', rulePath, { metadata: { serviceOwner: 'shipping' } }),
      own('PATCH', rulePath, { metadata: { verified: true } }),
    ]);
    const [savedRule] = await own('GET', rules + `?ownerClientReference=${client.code}&ruleType=${ruleType}`);
    assert.equal(savedRule.id, clientRule.id);
    assert.deepEqual(savedRule.metadata, { origin: 'fixture', serviceOwner: 'shipping', verified: true });
    const paused = await own('PATCH', rulePath, { status: 'PAUSED' });
    assert.equal(paused.status, 'PAUSED');
    assert.equal((await simulate(context)).matchedRule.id, fallback.id);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: clientRule.id, action: 'configuration_rule.updated' } }), 3);

    const sameCode = await own('POST', rules, { ...base, ruleType: 'SLA' });
    await own('PATCH', `${rules}/${fallback.code}`, { name: 'Ambiguous update' }, 409);
    assert.equal((await own('PATCH', `${rules}/${sameCode.id}`, { name: 'SLA updated' })).name, 'SLA updated');
    assert.equal((await simulate(context)).matchedRule.name, base.name);
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

  await scenario('carrier credentials stay encrypted and a status-only update preserves the account', async () => {
    const carrier = `CREDENTIAL-FIXTURE-${suffix}`.replaceAll('-', '_');
    const path = `/carriers/${carrier}/credentials`;
    const metadata = { contract: 'Fixture' };
    const apiKey = randomUUID();
    const body = { environment: 'test', accountNumber: 'FIXTURE-ACCOUNT', metadata, secrets: { apiKey } };
    await asWorker('POST', warehouse + path, body, 403);
    const stored = await own('POST', path, body);
    assert.equal(stored.environment, 'TEST');
    assert.equal(stored.secretLast4, apiKey.slice(-4));
    assert.ok(!JSON.stringify(stored).includes(apiKey));
    const persisted = await prisma.carrierCredential.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal(persisted.secretCiphertext.algorithm, 'aes-256-gcm');
    assert.ok(!JSON.stringify(persisted).includes(apiKey));
    const deactivated = await own('POST', path, { status: 'INACTIVE' });
    assert.equal(deactivated.id, stored.id);
    assert.equal(deactivated.status, 'INACTIVE');
    assert.equal(deactivated.accountNumber, body.accountNumber);
    assert.deepEqual(deactivated.metadata, metadata);
    assert.equal(deactivated.secretFingerprint, stored.secretFingerprint);
    const newKey = randomUUID();
    const rotated = await own('POST', path, { status: 'ACTIVE', secrets: { apiKey: newKey } });
    assert.equal(rotated.id, stored.id);
    assert.notEqual(rotated.secretFingerprint, stored.secretFingerprint);
    assert.equal(rotated.secretLast4, newKey.slice(-4));
    const listed = await own('GET', `/carriers/credentials?carrier=${carrier}`);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(newKey));
  });

  async function carrierFixture(group) {
    const carrier = `FIXTURE_${group}_${suffix}`;
    const shipment = await own('POST', '/shipments', { shipmentNumber: `CARRIER-${group}-${suffix}` });
    const shipmentPackage = await own('POST', `/shipments/${shipment.id}/packages`, { packageCode: `PKG-${group}-${suffix}` });
    const path = `/carriers/${carrier}`;
    return { carrier, shipment, shipmentPackage, path, body: {
      shipmentReference: shipment.id,
      packageReference: shipmentPackage.id,
      idempotencyKey: randomUUID(),
      weightGrams: 1000,
    } };
  }

  await scenario('carrier label creation is idempotent and checks the original request', async () => {
    const { path, body, shipmentPackage } = await carrierFixture('LABEL');
    const labels = path + '/labels';
    await own('POST', labels, { ...body, packageReference: randomUUID() }, 404);
    const pair = await Promise.all([own('POST', labels, body), own('POST', labels, body)]);
    assert.deepEqual(pair.map(result => result.duplicate).sort(), [false, true]);
    const [first, second] = pair;
    assert.equal(first.label.id, second.label.id);
    assert.deepEqual(first.adapter, second.adapter);
    assert.equal(first.adapter.testMode, true);
    assert.equal(first.label.packageId, shipmentPackage.id);
    assert.equal((await prisma.shipmentPackage.findUniqueOrThrow({ where: { id: shipmentPackage.id } })).trackingNumber, first.label.trackingNumber);
    await own('POST', labels, { ...body, weightGrams: 2000 }, 409);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: first.label.id, action: 'carrier.label_created' } }), 1);
  });

  await scenario('carrier manifests respect carrier and service filters and concurrent void happens once', async () => {
    const { path, carrier, shipment, body } = await carrierFixture('MANIFEST');
    const extra = await own('POST', `/shipments/${shipment.id}/packages`, { packageCode: `PKG-EXPRESS-${suffix}` });
    const labels = path + '/labels';
    const ordinary = await own('POST', labels, { ...body, serviceLevel: 'STANDARD' });
    const express = await own('POST', labels, { ...body, idempotencyKey: randomUUID(), serviceLevel: 'EXPRESS', packageReference: extra.id });
    const manifestPath = path + '/manifests/close';
    const first = await own('POST', manifestPath, { carrier, serviceLevel: ' standard ' });
    assert.deepEqual([first.manifest.carrier, first.manifest.shipmentCount, first.manifest.packageCount], [carrier, 1, 1]);
    await own('POST', manifestPath, { carrier: 'OTHER_FIXTURE_CARRIER' }, 409);
    const voidPath = `${labels}/${ordinary.label.labelReference}/void`;
    const voided = await Promise.all([
      own('POST', voidPath, { reasonCode: 'FIXTURE' }),
      own('POST', voidPath, { reasonCode: 'FIXTURE' }),
    ]);
    assert.deepEqual(voided.map(item => item.voided).sort(), [false, true]);
    assert.ok(voided.every(item => item.status === 'CANCELLED'));
    assert.equal(await prisma.auditLog.count({ where: { resourceId: ordinary.label.id, action: 'carrier.label_voided' } }), 1);
    const remaining = await own('POST', manifestPath, {});
    assert.deepEqual([remaining.manifest.shipmentCount, remaining.manifest.packageCount], [1, 1]);
    assert.equal((await prisma.carrierLabel.findUniqueOrThrow({ where: { id: express.label.id } })).status, 'GENERATED');
    await prisma.carrierLabel.update({ where: { id: express.label.id }, data: { status: 'PRINTED' } });
    await own('POST', `${labels}/${express.label.labelReference}/void`, {}, 409);
  });

  await scenario('carrier tracking sync and authenticated callbacks keep the latest linked scan', async () => {
    const { carrier, path, body, shipment, shipmentPackage } = await carrierFixture('TRACKING');
    const { label } = await own('POST', path + '/labels', body);
    const syncPath = path + '/tracking-sync';
    const syncPair = await Promise.all([own('POST', syncPath, { status: 'IN_TRANSIT' }), own('POST', syncPath, { status: 'IN_TRANSIT' })]);
    assert.deepEqual(syncPair.map(result => result.createdEvents).sort(), [0, 1]);
    assert.deepEqual(syncPair.map(result => result.skippedDuplicates).sort(), [0, 1]);
    const callback = warehouse + path + '/webhooks/tracking';
    const eventBody = {
      rawPayload: {
        id: `SCAN-${suffix}`, barcode: label.trackingNumber, eventStatus: 'DELIVERED',
        eventTime: '2035-02-10T10:00:00.000Z',
      },
    };
    await request('POST', callback, { body: eventBody, expected: 403 });
    const send = async (body, expected = 201) => (await request('POST', callback, {
      body, headers: { 'x-webhook-secret': carrierWebhookSecret }, expected,
    })).data;
    const reports = await Promise.all([send(eventBody), send(eventBody)]);
    assert.deepEqual(reports.map(item => item.duplicate).sort(), [false, true]);
    assert.equal(reports[0].event.id, reports[1].event.id);
    assert.equal(reports[0].event.shipmentId, shipment.id);
    assert.equal(reports[0].event.packageId, shipmentPackage.id);
    assert.equal(reports[0].event.status, 'DELIVERED');
    const inbox = await prisma.inboxEvent.findFirstOrThrow({ where: { resourceId: reports[0].event.id } });
    assert.ok(!Object.hasOwn(inbox.headers, 'x-webhook-secret'));
    const unrelated = await own('POST', `/shipments/${shipment.id}/packages`, { packageCode: `PKG-UNRELATED-${suffix}` });
    await send({ ...eventBody, packageReference: unrelated.id }, 409);
    await send({ rawPayload: { ...eventBody.rawPayload, id: `OLD-${suffix}`, eventStatus: 'CANCELLED', eventTime: '2035-02-09T10:00:00.000Z' } });
    await send({ rawPayload: { ...eventBody.rawPayload, id: `BAD-${suffix}`, eventTime: 'invalid' } }, 400);
    const noTimestamp = { rawPayload: { barcode: label.trackingNumber, eventStatus: 'OUT_FOR_DELIVERY' } };
    const unversioned = await send(noTimestamp);
    assert.equal((await send(noTimestamp)).event.id, unversioned.event.id);
    const latest = await prisma.carrierLabel.findUniqueOrThrow({ where: { id: label.id } });
    assert.equal(latest.status, 'GENERATED');
    assert.equal(latest.payload.latestTracking.status, 'DELIVERED');
    const list = await own('GET', `/carriers/tracking-events?carrier=${carrier}`);
    assert.equal(list.items.length, 4);
  });

  await scenario('slotting validates rules and preserves counters in incremental velocity updates', async () => {
    const slotting = '/slotting';
    const { sku } = await createSku('SLOT-COUNTERS');
    const invalid = { code: `INVALID-${suffix}`, minVelocityScore: 50, maxVelocityScore: 30 };
    await own('POST', slotting + '/rules', invalid, 409);
    await own('POST', slotting + '/rules', { ...invalid, maxVelocityScore: 70, targetLocationType: 'MISSING-TYPE' }, 400);
    const input = { code: `LOT-VELOCITY-${suffix}`, minVelocityScore: 60, maxVelocityScore: 100, targetLocationType: 'picking' };
    const rule = await own('POST', slotting + '/rules', input);
    assert.equal(rule.targetLocationType, 'PICKING');
    await own('POST', slotting + '/rules', input, 409);
    await own('POST', slotting + '/velocities', { sku: 'TEST-MISSING-SKU' }, 404);
    const original = await own('POST', slotting + '/velocities', {
      sku: sku.code, picksLast30Days: 10, unitsPickedLast30Days: 30, replenishmentsLast30Days: 1,
    });
    assert.deepEqual([original.velocityScore, original.abcClass], [76, 'A']);
    const revised = await own('POST', slotting + '/velocities', { sku: sku.id, replenishmentsLast30Days: 0 });
    assert.equal(revised.id, original.id);
    assert.deepEqual([revised.picksLast30Days, revised.unitsPickedLast30Days, revised.velocityScore, revised.abcClass], [10, 30, 70, 'B']);
  });

  await scenario('slotting previews safely, creates each recommendation once and moves confirmed stock', async () => {
    const slotting = '/slotting';
    const { sku } = await createSku('SLOTTING');
    const { sku: dismissedSku } = await createSku('SLOT-DISMISS');
    const zone = `SLOT-ZONE-${suffix}`;
    const location = (name, type, pickSequence) => own('POST', '/locations', {
      code: `SLOT-${name}-${suffix}`, name: `Slotting ${name}`, type, zone, pickSequence, parentReference: 'A-01',
    });
    const source = await location('SOURCE', 'STORAGE', 300);
    const target = await location('TARGET', 'PICKING', 20);
    const inventory = (await own('POST', '/inventory/quants/receive', {
      skuReference: sku.id, locationReference: source.id, quantity: 9,
    })).quant;
    const otherStock = (await own('POST', '/inventory/quants/receive', {
      skuReference: dismissedSku.id, locationReference: source.id, quantity: 7,
    })).quant;
    await own('POST', slotting + '/rules', {
      code: `00-SLOT-${suffix}`, zone, targetLocationType: 'PICKING', maxPickSequence: 40, minPickFaceQuantity: 3,
    });
    await own('POST', slotting + '/rules', {
      code: `00-SLOT-OTHER-${suffix}`, zone: 'OTHER-ZONE', targetLocationType: 'PICKING', maxPickSequence: 0,
    });
    await own('POST', slotting + '/velocities', { sku: sku.id, velocityScore: 99 });
    await own('POST', slotting + '/velocities', { sku: dismissedSku.id, velocityScore: 98 });
    const evaluate = slotting + '/evaluate';
    const options = { minVelocityScore: 95, lowVelocityScore: 0 };
    await own('POST', evaluate, { ...options, dryRun: 'false' }, 400);
    const preview = await own('POST', evaluate, { ...options, dryRun: true });
    assert.equal(preview.recommendationsCreated, 0);
    const drafts = preview.recommendations.filter(item => item.skuId === sku.id);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].toLocationId, target.id);
    assert.equal(drafts[0].metadata.plannedQuantity, 3);
    assert.ok(!Object.hasOwn(drafts[0].metadata, 'sourceQuantId'));
    assert.equal(await prisma.slottingRecommendation.count({ where: { skuId: sku.id } }), 0);
    const runs = await Promise.all([own('POST', evaluate, options), own('POST', evaluate, options)]);
    const saved = runs.flatMap(run => run.recommendations).filter(item => item.skuId === sku.id);
    const discard = runs.flatMap(run => run.recommendations).filter(item => item.skuId === dismissedSku.id);
    assert.equal(saved.length, 1);
    assert.equal(discard.length, 1);
    const apply = `${slotting}/recommendations/${saved[0].id}/apply`;
    const results = await Promise.all([own('POST', apply, {}, [201, 409]), own('POST', apply, {}, [201, 409])]);
    assert.equal(results.filter(item => item.status === 'APPLIED').length, 1);
    const applied = results.find(item => item.status === 'APPLIED');
    const taskId = applied.metadata.moveTaskId;
    const task = await prisma.warehouseTask.findUniqueOrThrow({ where: { id: taskId } });
    assert.deepEqual([task.type, task.fromLocationId, task.toLocationId, task.quantity], ['MOVE', source.id, target.id, 3]);
    assert.equal(await prisma.warehouseTask.count({ where: { skuId: sku.id, type: 'MOVE' } }), 1);
    const rerun = await own('POST', evaluate, options);
    assert.ok(!rerun.recommendations.some(item => item.skuId === sku.id));
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: inventory.id } })).quantity, 9);
    await own('POST', `/tasks/${taskId}/start`, {});
    assert.equal((await own('POST', `/tasks/${taskId}/confirm`, {})).status, 'DONE');
    assert.equal((await prisma.stockQuant.findUniqueOrThrow({ where: { id: inventory.id } })).quantity, 6);
    const destination = await prisma.stockQuant.findFirstOrThrow({ where: { skuId: sku.id, locationId: target.id } });
    assert.equal(destination.quantity, 3);
    assert.ok(!(await own('POST', evaluate, options)).recommendations.some(item => item.skuId === sku.id));
    await prisma.stockQuant.update({ where: { id: otherStock.id }, data: { quantity: 0 } });
    await own('POST', `${slotting}/recommendations/${discard[0].id}/apply`, {}, 409);
    assert.equal((await prisma.slottingRecommendation.findUniqueOrThrow({ where: { id: discard[0].id } })).status, 'OPEN');
    const dismiss = `${slotting}/recommendations/${discard[0].id}/dismiss`;
    const decisions = await Promise.all([own('POST', dismiss, {}, [201, 409]), own('POST', dismiss, {}, [201, 409])]);
    assert.equal(decisions.filter(item => item.status === 'DISMISSED').length, 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: discard[0].id, action: 'slotting.recommendation_dismissed' } }), 1);
    await own('POST', `${slotting}/recommendations/${discard[0].id}/apply`, {}, 409);
  });

  await scenario('idempotency records bind the request and replay only the first completed result', async () => {
    const check = '/api/idempotency/check';
    const records = '/api/idempotency/records';
    const key = { sourceSystem: `fixture-${suffix}`, idempotencyKey: randomUUID(), requestHash: randomUUID() };
    const empty = await asAdmin('POST', check, key);
    assert.equal(empty.status, 'available');
    assert.equal(empty.record, null);
    const registered = await Promise.all([asAdmin('POST', records, key), asAdmin('POST', records, key)]);
    assert.equal(registered[0].status, 'IN_PROGRESS');
    assert.equal(registered[1].id, registered[0].id);
    assert.equal((await asAdmin('POST', check, key)).status, 'conflict');
    const results = await Promise.all([
      asAdmin('POST', records, { ...key, responseBody: { result: 'first' } }),
      asAdmin('POST', records, { ...key, responseBody: { result: 'second' } }),
    ]);
    assert.equal(results[0].id, registered[0].id);
    assert.equal(results[0].status, 'COMPLETED');
    assert.deepEqual(results[0], results[1]);
    const replay = await asAdmin('POST', check, key);
    assert.equal(replay.status, 'replay');
    assert.deepEqual(replay.responseBody, results[0].responseBody);
    const changed = { ...key, requestHash: randomUUID() };
    await asAdmin('POST', records, { ...changed, responseBody: { result: 'changed' } }, 409);
    assert.equal((await asAdmin('POST', check, changed)).status, 'conflict');
    await asAdmin('POST', check, { ...key, idempotencyKey: '        ' }, 400);
    assert.equal(await prisma.idempotencyRecord.count({ where: { sourceSystem: key.sourceSystem.toUpperCase(), idempotencyKey: key.idempotencyKey } }), 1);
    const failedKey = { ...key, idempotencyKey: randomUUID() };
    await asAdmin('POST', records, failedKey);
    const failure = await asAdmin('POST', records, { ...failedKey, status: 'FAILED', responseBody: false });
    assert.equal(failure.responseBody, false);
    assert.deepEqual(await asAdmin('POST', records, { ...failedKey, status: 'FAILED' }), failure);
    assert.equal((await asAdmin('POST', check, failedKey)).status, 'conflict');
    await asAdmin('POST', records, { ...failedKey, responseBody: {} }, 409);
    const nullKey = { ...key, idempotencyKey: randomUUID() };
    await asAdmin('POST', records, nullKey);
    const nullResponse = await asAdmin('POST', records, { ...nullKey, responseBody: null });
    assert.equal(nullResponse.status, 'COMPLETED');
    assert.equal(nullResponse.responseBody, null);
  });

  await scenario('incident transitions audit a repeated request once and clear the prior resolution on recurrence', async () => {
    const key = `fixture-incident-${suffix}`;
    const path = `/api/operations/reliability/incidents/${key}`;
    await asWorker('POST', path + '/acknowledge', { note: 'Not a warehouse action' }, 403);
    await asAdmin('POST', '/api/operations/reliability/incidents/invalid%20key/acknowledge', {}, 400);
    const [first, retry] = await Promise.all([
      asAdmin('POST', path + '/acknowledge', { note: '  Investigating  ' }),
      asAdmin('POST', path + '/acknowledge', { note: 'Investigating' }),
    ]);
    assert.equal(first.status, 'ACKNOWLEDGED');
    assert.deepEqual(retry, first);
    const ackAudit = { resourceId: key, action: 'reliability.incident_acknowledged' };
    assert.equal(await prisma.auditLog.count({ where: ackAudit }), 1);
    const settled = await asAdmin('POST', path + '/resolve', { note: 'Restored operation' });
    assert.equal(settled.status, 'RESOLVED');
    assert.equal(settled.acknowledgedAt, first.acknowledgedAt);
    assert.ok(settled.resolvedByUserId);
    assert.deepEqual(await asAdmin('POST', path + '/resolve', { note: 'Restored operation' }), settled);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: key, action: 'reliability.incident_resolved' } }), 1);
    const recurring = await asAdmin('POST', path + '/acknowledge', { note: 'Issue detected again' });
    assert.equal(recurring.status, 'ACKNOWLEDGED');
    assert.equal(recurring.resolvedAt, null);
    assert.equal(recurring.resolvedByUserId, null);
    assert.equal(await prisma.auditLog.count({ where: ackAudit }), 2);
  });

  await scenario('retention previews safely, skips locked records and respects recent replay activity', async () => {
    const path = '/api/operations/reliability/retention';
    await asWorker('POST', path + '/run', { dryRun: false }, 403);
    await asAdmin('POST', path + '/run', { dryRun: false, batchSize: 9 }, 400);
    const old = new Date('2000-01-01T00:00:00.000Z');
    const fixture = `RETENTION-${suffix}`;
    const event = (tag, status, sentAt) => prisma.outboxEvent.create({ data: {
      type: fixture, aggregateType: 'retention_fixture', aggregateId: tag, payload: {},
      status, sentAt, availableAt: old, updatedAt: old,
    } });
    const stale = await event('stale', 'SENT', old);
    const locked = await event('locked', 'SENT', old);
    const pending = await event('pending', 'PENDING', null);
    const recent = await event('recent', 'SENT', new Date());
    const replayed = await prisma.integrationDeadLetter.create({ data: {
      eventType: fixture, errorMessage: 'Fixture replay', status: 'REPLAYED', fingerprint: fixture,
      resolvedAt: old, replayedAt: new Date(), updatedAt: old, replayOutboxEventId: pending.id,
    } });
    const preview = await asAdmin('POST', path + '/run', { batchSize: 10 });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.totalDeleted, 0);
    assert.ok(preview.items.find(item => item.key === 'outbox-sent-events').eligibleCount >= 2);
    assert.equal(await prisma.outboxEvent.count({ where: { type: fixture } }), 4);
    const verifyKept = () => prisma.integrationDeadLetter.findUniqueOrThrow({ where: { id: replayed.id } });
    const cleanup = () => asAdmin('POST', path + '/run', { dryRun: false, batchSize: 10 });
    await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM outbox_events WHERE id = $1::uuid FOR UPDATE', locked.id);
      const run = await cleanup();
      assert.equal(run.dryRun, false);
      assert.ok(run.items.find(item => item.key === 'outbox-sent-events').deletedCount >= 1);
      await verifyKept();
      const remaining = await prisma.outboxEvent.findMany({ where: { type: fixture }, select: { id: true } });
      assert.deepEqual(remaining.map(row => row.id).sort(), [locked.id, pending.id, recent.id].sort());
    });
    const completed = await cleanup();
    assert.equal(await prisma.outboxEvent.count({ where: { id: { in: [stale.id, locked.id] } } }), 0);
    assert.equal(await prisma.outboxEvent.count({ where: { type: fixture } }), 2);
    await verifyKept();
    const status = await asAdmin('GET', path);
    assert.equal(status.lastRun.finishedAt, completed.finishedAt);
    assert.equal(status.preview.dryRun, true);
  });

  await scenario('yard check-in links one appointment and rejects missing or conflicting references', async () => {
    const yard = '/enterprise-ops/yard';
    const appointment = await own('POST', yard + '/appointments', {
      appointmentNumber: `CHECKIN-${suffix}`, direction: 'INBOUND',
      plannedStartAt: '2030-02-01T12:00:00Z', plannedEndAt: '2030-02-01T13:00:00Z',
    });
    const dock = await own('POST', yard + '/dock-doors', { code: `CHECKIN-DOOR-${suffix}` });
    const checkIn = yard + '/trailers/check-in';
    const input = { trailerNumber: `T-${suffix}`, carrier: 'Fixture carrier', appointmentId: appointment.id, dockDoorId: dock.id };
    const [checkedIn, repeated] = await Promise.all([own('POST', checkIn, input), own('POST', checkIn, input)]);
    assert.equal(checkedIn.trailer.status, 'CHECKED_IN');
    assert.equal(checkedIn.appointment.trailerId, checkedIn.trailer.id);
    assert.equal(checkedIn.appointment.dockDoorId, dock.id);
    assert.equal(repeated.appointment.trailerId, checkedIn.trailer.id);
    assert.equal(repeated.trailer.id, checkedIn.trailer.id);
    assert.equal(repeated.trailer.checkedInAt, checkedIn.trailer.checkedInAt);
    await own('POST', checkIn, { ...input, trailerNumber: input.trailerNumber + '-OTHER' }, 409);
    await own('POST', checkIn, { ...input, trailerNumber: input.trailerNumber + '-MISSING', appointmentId: randomUUID() }, 404);
    assert.equal(await prisma.yardTrailer.count({ where: { trailerNumber: { startsWith: input.trailerNumber } } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: checkedIn.trailer.id, action: 'yard_trailer.checked_in' } }), 1);
  });

  await scenario('cross-dock rolls back unknown lines and releases each plan once', async () => {
    const { sku } = await createSku('CROSS-DOCK');
    const path = '/enterprise-ops/cross-dock/plans';
    const body = { reasonCode: `CROSS-${suffix}`, priority: 90, lines: [{ skuId: sku.id, quantity: 4 }] };
    await asWorker('POST', warehouse + path, body, 403);
    const plan = await own('POST', path, body);
    assert.equal(plan.status, 'PLANNED');
    const line = await prisma.crossDockPlanLine.findFirstOrThrow({ where: { planId: plan.id } });
    assert.deepEqual([line.skuId, line.expectedQuantity, line.allocatedQuantity], [sku.id, 4, 0]);
    const release = `${path}/${plan.id}/release`;
    assert.equal((await own('PATCH', release, {})).status, 'RELEASED');
    await own('PATCH', release, {}, 409);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: plan.id, action: 'cross_dock_plan.released' } }), 1);
    await own('POST', path, {
      ...body, reasonCode: body.reasonCode + '-BAD', lines: [...body.lines, { skuId: randomUUID(), quantity: 1 }],
    }, 404);
    assert.equal(await prisma.crossDockPlan.count({ where: { reasonCode: body.reasonCode + '-BAD' } }), 0);
  });

  await scenario('value-added services preserve kit versions and complete a task only once', async () => {
    const vas = '/enterprise-ops/vas';
    const code = `VAS-${suffix}`;
    const service = await own('POST', vas + '/services', { code, name: 'Fixture labelling', serviceType: 'LABEL', defaultDurationSeconds: 90 });
    assert.equal((await own('POST', vas + '/services', {
      code, name: 'Updated labelling', serviceType: 'LABEL', defaultDurationSeconds: 100,
    })).id, service.id);
    const { sku: kitSku } = await createSku('KIT');
    const { sku: componentSku } = await createSku('KIT-COMPONENT');
    const kitBody = { kitSkuId: kitSku.id, code, lines: [{ componentSkuId: componentSku.id, quantityPerKit: 2 }] };
    const kit = await own('POST', vas + '/kits', kitBody);
    const revisedKit = await own('POST', vas + '/kits', { ...kitBody, version: 2 });
    assert.notEqual(kit.id, revisedKit.id);
    const line = await prisma.kitBomLine.findFirstOrThrow({ where: { bomId: kit.id } });
    assert.deepEqual([line.componentSkuId, line.quantityPerKit], [componentSku.id, 2]);
    const taskBody = { serviceId: service.id, targetResourceType: 'SKU', targetResourceId: kitSku.id, quantity: 2 };
    const task = await own('POST', vas + '/tasks', taskBody);
    assert.equal(task.status, 'OPEN');
    const confirmation = `${vas}/tasks/${task.id}/confirm`;
    const done = await own('PATCH', confirmation, { result: { labelled: 2 } });
    assert.equal(done.status, 'COMPLETED');
    assert.deepEqual(done.metadata.result, { labelled: 2 });
    await own('PATCH', confirmation, { result: { labelled: 3 } }, 409);
    assert.equal(await prisma.auditLog.count({ where: { resourceId: task.id, action: 'vas_task.completed' } }), 1);
    await own('POST', vas + '/kits', { ...kitBody, lines: [{ componentSkuId: kitSku.id, quantityPerKit: 1 }] }, 400);
    assert.equal((await prisma.kitBomLine.findFirstOrThrow({ where: { bomId: kit.id } })).id, line.id);
    await own('POST', vas + '/tasks', { ...taskBody, serviceId: randomUUID() }, 404);
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
