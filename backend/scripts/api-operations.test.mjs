import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { runWriteScenarios } from './api-write-scenarios.mjs';

const loopback = new Set(['127.0.0.1', '[::1]', 'localhost']);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const carrierWebhook = 'POST /api/warehouses/{warehouseId}/carriers/{carrier}/webhooks/tracking';
const externalMappingPath = '/api/integrations/enterprise/external-id-mappings/resolve';
const missingId = '00000000-0000-4000-8000-000000000001';
const extraField = '_unexpectedTestProperty';

test('OpenAPI operations on a disposable PostgreSQL database', { timeout: 180000 }, async (suite) => {
  assert.ok(process.env.WMS_TEST_DATABASE_URL, 'WMS_TEST_DATABASE_URL must point to a migrated and seeded test database');
  const database = new URL(process.env.WMS_TEST_DATABASE_URL);
  assert.ok(loopback.has(database.hostname), 'Use a local PostgreSQL instance');
  assert.match(database.pathname, /test|regression/i, 'Use a database dedicated to tests');
  const connectionOptions = database.searchParams.get('options');
  database.searchParams.set('options', [connectionOptions, '-c timezone=Europe/Prague'].filter(Boolean).join(' '));
  const baseComToken = randomUUID();
  const carrierWebhookSecret = randomUUID();
  const baseComOrders = new Map();
  const baseComShippedStatus = 7200;
  const connector = createServer(async (incoming, outgoing) => {
    const send = (data, status = 200) => {
      outgoing.writeHead(status, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify(data));
    };
    if (incoming.method !== 'POST' || incoming.url !== '/connector.php' || incoming.headers['x-bltoken'] !== baseComToken) {
      return send({ status: 'ERROR' }, 400);
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const parameters = JSON.parse(form.get('parameters') ?? '{}');
    const order = baseComOrders.get(parameters.order_id);
    if (form.get('method') === 'getOrders' && parameters.get_unconfirmed_orders === false) {
      return send({
        status: 'SUCCESS',
        orders: order ? [{
          order_id: parameters.order_id, order_status_id: order.statusId,
          confirmed: order.confirmed, products: order.products,
        }] : [],
      });
    }
    if (order && form.get('method') === 'setOrderStatus' && parameters.status_id === baseComShippedStatus) {
      order.statusWrites++;
      order.statusId = parameters.status_id;
      return send({ status: 'SUCCESS' });
    }
    return send({ status: 'ERROR' }, 400);
  });
  await new Promise((resolve, reject) => connector.listen(0, '127.0.0.1', resolve).once('error', reject));
  suite.after(async () => {
    connector.closeAllConnections();
    await new Promise(resolve => connector.close(resolve));
  });
  Object.assign(process.env, {
    DATABASE_URL: database.href,
    DATABASE_DIRECT_URL: database.href,
    NODE_ENV: 'test',
    CARRIER_ADAPTER_MODE: 'mock',
    CARRIER_CREDENTIAL_ENCRYPTION_KEY: randomUUID(),
    WEBHOOK_SHARED_SECRET: carrierWebhookSecret,
    BASE_COM_API_URL: `http://127.0.0.1:${connector.address().port}/connector.php`,
    BASE_COM_API_TOKEN: baseComToken,
    BASE_COM_SHIPPED_STATUS_ID: String(baseComShippedStatus),
    EXTERNAL_HTTP_ALLOWED_HOSTS: '127.0.0.1',
    OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
    RATE_LIMIT_BACKEND: 'memory',
    RATE_LIMIT_MAX: '5000',
    STRUCTURED_LOGS_ENABLED: 'false',
    PRIVILEGED_MFA_ENFORCEMENT: 'warn',
  });
  const { createWmsApp } = await import('../dist/bootstrap.js');
  const { ConfigService } = await import('@nestjs/config');
  const { PrismaService } = await import('../dist/database/prisma.service.js');
  const { QueueWorkerService } = await import('../dist/jobs/queue-worker.service.js');
  const app = await createWmsApp({ enableSwagger: false });
  const config = app.get(ConfigService);
  suite.after(() => app.close());
  app.useLogger(['error', 'warn']);
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const { paths } = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
  const operations = Object.entries(paths).flatMap(([path, pathItem]) => Object.entries(pathItem)
    .filter(([method]) => methods.has(method))
    .map(([method, spec]) => ({ method: method.toUpperCase(), path, spec, key: `${method.toUpperCase()} ${path}` })));
  const routes = operations
    .map(op => {
      const segments = op.path.split('/').slice(1).map(segment => segment.startsWith('{') ? null : segment);
      return { ...op, segments, staticCount: segments.filter(segment => segment !== null).length };
    })
    .sort((left, right) => right.staticCount - left.staticCount);
  const accepted = new Set();
  const covered = new Set();
  let testedWrites = 0;
  let testedReads = 0;
  let testedBodylessWrites = 0;
  let testedPublicWrites = 0;

  function recordSuccessfulRequest(response, method) {
    if (!response.ok) return;
    const segments = new URL(response.url).pathname.split('/').slice(1);
    const operation = routes.find(route =>
      route.method === method && route.segments.length === segments.length &&
      route.segments.every((segment, index) => segment === null ? Boolean(segments[index]) : segment === segments[index]),
    );
    if (operation) accepted.add(operation.key);
  }

  async function request(method, path, { body, token, key = randomUUID(), expected, headers } = {}) {
    const response = await fetch(origin + path, {
      method,
      redirect: 'error',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    const payload = response.headers.get('content-type')?.includes('json') && raw ? JSON.parse(raw) : raw;
    const message = `${method} ${path} returned ${response.status}`
      + (response.ok ? '' : `: ${JSON.stringify(payload?.error?.message ?? payload?.message ?? '').slice(0, 200)}`);
    if (expected !== undefined) assert.ok([expected].flat().includes(response.status), message);
    recordSuccessfulRequest(response, method);
    return { status: response.status, data: payload?.data ?? payload };
  }

  const login = async (email, password) => (await request('POST', '/api/auth/login', {
    body: { email, password }, expected: 201,
  })).data;
  const admin = await login('admin@example.com', 'Local-Seed-42!');
  const worker = await login('demo-skladnik@aardvarkland.local', 'Demo-Local-42!');
  const manager = await login('demo-vedouci@aardvarkland.local', 'Demo-Local-42!');
  const boundRequest = token => async (method, path, body, expected = method === 'POST' ? 201 : 200, key) =>
    (await request(method, path, { body, token, expected, key })).data;
  const asAdmin = boundRequest(admin.accessToken);

  await suite.test('documented protected operations require authentication', async () => {
    const failures = [];
    for (const op of operations) {
      if (!op.spec.security?.some(requirements => Object.hasOwn(requirements, 'bearer')) || op.key === carrierWebhook) continue;
      try {
        await request(op.method, materialize(op.path), { expected: 401 });
        covered.add(op.key);
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
    suite.diagnostic(`${covered.size} protected operations rejected requests without a session`);
  });

  await suite.test('public entry points and independently authenticated callbacks', async () => {
    const checks = new Map([
      ['GET /', [200]],
      ...['', '/live', '/startup', '/backup', '/ready'].map(path => [`GET /api/health${path}`, [200]]),
      ['POST /api/auth/login', [400, {}]],
      ['POST /api/auth/refresh', [401, { refreshToken: 'invalid-refresh-token-for-test' }]],
      ['POST /api/observability/frontend-events', [400, { [extraField]: true }]],
      ['POST /api/warehouses/{warehouseId}/print-agent/jobs/claim', [400, { [extraField]: true }]],
      ['POST /api/warehouses/{warehouseId}/print-agent/jobs/{jobId}/result', [400, { [extraField]: true }]],
      [carrierWebhook, [400, { [extraField]: true }]],
    ]);
    for (const op of operations.filter(item => !item.spec.security?.length || item.key === carrierWebhook)) {
      const check = checks.get(op.key);
      assert.ok(check, `Declare the public contract for ${op.key}`);
      const [expected, body] = check;
      await request(op.method, materialize(op.path), { expected, body });
      if (op.method !== 'GET') testedPublicWrites++;
      covered.add(op.key);
    }
    const refreshed = await request('POST', '/api/auth/refresh', {
      body: { refreshToken: worker.refreshToken }, expected: 201,
    });
    assert.notEqual(refreshed.data.refreshToken, worker.refreshToken);
    await request('POST', '/api/auth/refresh', {
      body: { refreshToken: worker.refreshToken }, expected: 401,
    });
  });

  await suite.test('authenticated reads handle parameters and unknown references', async () => {
    const failures = [];
    for (const op of operations.filter(item => item.method === 'GET' && item.spec.security?.length)) {
      try {
        const path = materialize(op.path);
        if (op.path.endsWith('/realtime/events')) {
          const signal = new AbortController();
          try {
            const response = await fetch(origin + path, {
              headers: { Authorization: `Bearer ${admin.accessToken}`, Accept: 'text/event-stream' },
              signal: AbortSignal.any([signal.signal, AbortSignal.timeout(5000)]),
            });
            assert.equal(response.status, 200, op.key);
            assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
            const chunk = await response.body.getReader().read();
            assert.match(new TextDecoder().decode(chunk.value), /realtime\.connected/);
            recordSuccessfulRequest(response, 'GET');
          } finally {
            signal.abort();
          }
        } else {
          const expected = path === externalMappingPath ? 400 : path.includes(missingId) ? [404, 200] : 200;
          await request('GET', path, { token: admin.accessToken, expected });
        }
        testedReads++;
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  });

  await suite.test('write endpoints reject properties outside their DTOs', async () => {
    const failures = [];
    for (const op of operations.filter(item => item.method !== 'GET' && item.spec.security?.length && item.spec.requestBody && item.key !== carrierWebhook)) {
      try {
        const body = { [extraField]: true };
        if (op.path.startsWith('/api/users')) body.warehouseCode = 'MAIN';
        const response = await request(op.method, materialize(op.path), {
          token: admin.accessToken, body, expected: 400,
        });
        assert.match(JSON.stringify(response.data), new RegExp(extraField), `${op.key} did not report the unknown field`);
        testedWrites++;
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  });

  await suite.test('writes without a request body handle missing resources or execute a local operation', async () => {
    const expectedResponses = new Map([
      ['POST /api/auth/me/mfa/setup', 201],
      ['POST /api/operations/reliability/alerts/deliver', 201],
      ['POST /api/operations/reliability/startup-preflight/refresh', 201],
      ['POST /api/warehouses/{warehouseId}/enterprise-ops/automation/commands/claim-next', 201],
      ['PATCH /api/warehouses/{warehouseId}/enterprise-ops/cross-dock/plans/{planId}/release', 409],
    ]);
    const failures = [];
    for (const op of operations.filter(item => item.method !== 'GET' && item.spec.security?.length && !item.spec.requestBody)) {
      try {
        let path = materialize(op.path);
        if (path.endsWith('/automation/commands/claim-next')) path += `?deviceId=${missingId}`;
        assert.ok(path.includes(missingId) || expectedResponses.has(op.key), `Declare the behavior of ${op.key}`);
        await request(op.method, path, {
          token: op.path.endsWith('/mfa/setup') ? manager.accessToken : admin.accessToken,
          expected: expectedResponses.get(op.key) ?? 404,
        });
        testedBodylessWrites++;
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  });

  const fixtures = await runWriteScenarios(suite, {
    asAdmin,
    asManager: boundRequest(manager.accessToken),
    asWorker: boundRequest(worker.accessToken),
    bind: boundRequest,
    request,
    login,
    setMfaMode: mode => config.set('PRIVILEGED_MFA_ENFORCEMENT', mode),
    prisma: app.get(PrismaService),
    baseCom: { orders: baseComOrders, shippedStatus: baseComShippedStatus },
    carrierWebhookSecret,
    runQueueCycle: () => app.get(QueueWorkerService).runLoop({
      stopAfterCycles: 1,
      eventType: 'STORAGE_OCCUPANCY_FIXTURE',
    }),
  });

  await suite.test('the OpenAPI operation inventory is fully accounted for', () => {
    assert.deepEqual(operations.map(op => op.key).filter(key => !covered.has(key)), []);
    const checkedWrites = testedWrites + testedBodylessWrites + testedPublicWrites;
    assert.equal(checkedWrites, operations.filter(op => op.method !== 'GET').length);
    suite.diagnostic(`${covered.size} operations, ${testedReads} authenticated reads, ${checkedWrites} write contracts (${testedWrites} DTO checks)`);
    suite.diagnostic(`${fixtures} warehouse and administration scenarios`);
  });

  await suite.test('every documented route accepts a valid HTTP request', () => {
    assert.deepEqual(operations.filter(op => !accepted.has(op.key)).map(op => op.key), []);
    suite.diagnostic(`${accepted.size}/${operations.length} documented operations returned success`);
  });
});

function materialize(path) {
  const references = {
    warehouseId: 'MAIN',
    carrier: 'MOCK',
    productReference: 'PROD-ABC-123',
    skuReference: 'ABC-123',
    skuId: 'ABC-123',
    productId: 'PROD-ABC-123',
    locationId: 'A-01-01',
    entity: 'outbound-order',
    status: 'OPEN',
  };
  return path.replace(/\{([^}]+)\}/g, (_parameter, name) => encodeURIComponent(references[name] ?? missingId));
}
