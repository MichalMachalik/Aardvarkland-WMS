import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.WMS_LIVE_UI_URL;
const roles = {
  system: {
    email: 'admin@example.com',
    password: 'Local-Seed-42!',
    routes: ['settings', 'reliability', 'overview', 'products', 'locations', 'cycle-counts', 'quality', 'integrations', 'print-stations'],
  },
  manager: {
    email: 'demo-vedouci@aardvarkland.local',
    password: 'Demo-Local-42!',
    routes: ['overview', 'control-tower', 'outbound', 'tasks', 'waves', 'products', 'locations', 'inbound', 'inventory', 'cycle-counts', 'quality', 'rf', 'packing', 'carriers', 'print-stations', 'integrations'],
  },
  worker: {
    email: 'demo-skladnik@aardvarkland.local',
    password: 'Demo-Local-42!',
    routes: ['rf', 'tasks', 'inbound', 'packing', 'inventory', 'locations', 'print-stations'],
  },
};
const pages = {
  settings: ['Nastavení', /^Nastavení$/],
  reliability: ['Stabilita', /^Stabilita$/],
  overview: ['Přehled', /^(Správa systému|Řízení skladu)\.?$/],
  products: ['Produkty', /^Produkty a SKU$/],
  locations: ['Lokace', /^Lokace a zaskladnění$/],
  'cycle-counts': ['Inventury', /^Inventury$/],
  quality: ['Kvalita', /^Kvalita a vratky$/],
  integrations: ['Integrace', /^Integrace$/],
  'print-stations': ['Tiskárny', /^Tiskárny$/],
  'control-tower': ['Provoz', /^Provoz$/],
  outbound: ['Objednávky', /^Objednávky$/],
  tasks: ['Úkoly', /^Úkoly$/],
  waves: ['Vlny', /^Uvolnění vlny$/],
  inbound: ['Příjem', /^Příjem$/],
  inventory: ['Zásoby', /^Zásoby$/],
  rf: ['Skenování', /^RF skener$/],
  packing: ['Balení', /^Balení$/],
  carriers: ['Doprava', /^Doprava$/],
};

test.skip(!base, 'Set WMS_LIVE_UI_URL to a loopback WMS seeded with local demo accounts.');
test.use({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' });

async function login(page, role) {
  const url = new URL(base);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
  await page.addInitScript(() => localStorage.setItem('aardvarkland-ui-language', 'cs'));
  await page.goto(url.href);
  await page.locator('input[autocomplete="username"]').fill(role.email);
  await page.locator('input[autocomplete="current-password"]').fill(role.password);
  const authentication = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
  await page.locator('.login-form button[type="submit"]').click();
  expect((await authentication).ok()).toBe(true);
  await expect(page.locator('.shell')).toBeVisible();
}

const desktopNav = page => page.getByRole('navigation', { name: 'Hlavní navigace' });
const mobileNav = page => page.getByRole('navigation', { name: 'Mobilní navigace' });

async function liveApi(page, path, { token, data } = {}) {
  const url = new URL(path, base).href;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = data === undefined
    ? await page.request.get(url, { headers })
    : await page.request.post(url, { data, headers: { ...headers, 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), `${response.status()} ${path}`).toBe(true);
  const body = await response.json();
  return body.data ?? body;
}

for (const [name, role] of Object.entries(roles)) {
  test(`${name} can open each permitted screen at desktop and phone sizes`, async ({ page }) => {
    test.setTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const { pathname } = new URL(response.url());
      if (pathname.startsWith('/api/') && response.status() >= 400) errors.push(`${response.status()} ${pathname}`);
    });
    await login(page, role);
    const nav = desktopNav(page);
    await expect(nav.getByRole('button')).toHaveText(role.routes.map(route => pages[route][0]));

    for (const route of role.routes) {
      const [label, heading] = pages[route];
      await test.step(route, async () => {
        await page.setViewportSize({ width: 1440, height: 950 });
        await nav.getByRole('button', { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`#/${route}$`));
        await expect(page.locator('.content').getByRole('heading', { name: heading }).first()).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(mobileNav(page)).toBeVisible();
        await expect(page.locator('.content').getByRole('heading', { name: heading }).first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      });
    }
    expect(errors).toEqual([]);
  });
}

test('print stations only offer retry after failure and return the job to the queue', async ({ page }) => {
  const api = '/api/warehouses/MAIN';
  const { email, password } = roles.system;
  const auth = await liveApi(page, '/api/auth/login', { data: { email, password } });
  const token = auth.accessToken;
  const fixture = randomUUID().slice(0, 8).toUpperCase();
  const printerCode = `UI-PRINTER-${fixture}`;
  const agentCode = `UI-AGENT-${fixture}`;
  const scannerCode = `UI-SCANNER-${fixture}`;
  const agent = { agentCode, token: randomUUID() };
  await liveApi(page, api + '/printers', {
    token, data: { code: printerCode, name: 'Browser fixture printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' },
  });
  await liveApi(page, api + '/print-agents', {
    token, data: { code: agentCode, name: 'Browser fixture agent', token: agent.token, printerCodes: [printerCode] },
  });
  const savedScanner = await liveApi(page, api + '/scanners', {
    token, data: { code: scannerCode, name: 'Browser fixture scanner', batteryLevel: 0 },
  });
  const job = await liveApi(page, api + '/print-jobs', {
    token, data: { printerCode, agentCode, maxAttempts: 1, renderedZpl: '^XA^FO40,40^FDFixture^FS^XZ' },
  });
  const claimed = await liveApi(page, api + '/print-agent/jobs/claim', { data: agent });
  expect(claimed.jobs.map(item => item.id)).toEqual([job.id]);

  await login(page, roles.system);
  await desktopNav(page).getByRole('button', { name: 'Tiskárny', exact: true }).click();
  const scanner = page.getByRole('row').filter({ has: page.getByRole('cell', { name: scannerCode, exact: true }) });
  await expect(scanner.getByRole('cell', { name: '0% / Nenastaveno', exact: true })).toBeVisible();
  const scannerPath = `${api}/scanners/${savedScanner.id}`;
  const telemetry = await page.request.patch(new URL(scannerPath + '/telemetry', base).href, {
    headers: { Authorization: `Bearer ${token}` },
    data: { batteryLevel: 65, signalStrength: 91 },
  });
  expect(telemetry.ok()).toBe(true);
  const statusChange = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === scannerPath);
  await scanner.getByRole('button', { name: 'Servis', exact: true }).click();
  const changed = await statusChange;
  expect(changed.request().postDataJSON()).toEqual({ status: 'MAINTENANCE' });
  expect(changed.ok()).toBe(true);
  const scannerBody = await changed.json();
  const updatedScanner = scannerBody.data ?? scannerBody;
  expect(updatedScanner).toMatchObject({ status: 'MAINTENANCE', batteryLevel: 65, signalStrength: 91 });
  await expect(scanner.getByRole('cell', { name: '65% / 91%', exact: true })).toBeVisible();
  const code = page.getByTestId('print-label-code');
  await code.fill(`LABEL-${fixture}`);
  const previews = page.locator('.barcode-preview-grid');
  for (const symbol of ['QR', 'Code 128', 'DataMatrix']) {
    const preview = previews.getByRole('img', { name: symbol, exact: true });
    await expect(preview).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect.poll(() => preview.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  }
  await code.clear();
  await expect(previews.getByRole('img')).toHaveCount(0);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: printerCode, exact: true }) });
  const retry = row.getByRole('button', { name: 'Opakovat tisk' });
  const reassign = row.getByRole('button', { name: 'Přesměrovat' });
  await expect(retry).toBeDisabled();
  await expect(reassign).toBeDisabled();
  await liveApi(page, `${api}/print-agent/jobs/${job.id}/result`, {
    data: { ...agent, status: 'FAILED', errorMessage: 'Fixture failure' },
  });
  await page.reload();
  await expect(retry).toBeEnabled();
  const retried = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith(`/print-jobs/${job.id}/retry`));
  await retry.click();
  expect((await retried).ok()).toBe(true);
  await expect(retry).toBeDisabled();
  await expect(reassign).toBeEnabled();
  await expect(row.getByRole('cell', { name: '0/1', exact: true })).toBeVisible();
  expect((await liveApi(page, api + '/print-agent/jobs/claim', { data: agent })).jobs.map(item => item.id)).toEqual([job.id]);
});

test('Base.com gives actionable feedback for import and dispatch on a phone', async ({ page }) => {
  let imported = false;
  let dispatched = false;
  let synced = false;
  let observedOrderId;
  await page.route(/\/api\/warehouses\/[^/]+\/integrations\/base-com(?:\/orders\/(?:import|sync-dispatch))?$/, async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({ json: { configured: true, dispatchSyncConfigured: true } });
    }
    observedOrderId = request.postDataJSON().orderId;
    const orderNumber = `BASE-${observedOrderId}`;
    if (new URL(request.url()).pathname.endsWith('/import')) {
      const created = !imported;
      imported = true;
      return route.fulfill({ json: { created, order: { orderNumber } } });
    }
    if (!dispatched) {
      return route.fulfill({ status: 422, json: { message: 'Dispatch the order in WMS before sending its status.' } });
    }
    const updated = !synced;
    synced = true;
    return route.fulfill({ json: { updated, orderNumber } });
  });

  await login(page, roles.system);
  await desktopNav(page).getByRole('button', { name: 'Integrace', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Base.com', exact: true }) });
  const orderId = card.getByRole('textbox', { name: 'ID objednávky v Base.com' });
  const importOrder = card.getByRole('button', { name: 'Importovat objednávku' });
  const sync = card.getByRole('button', { name: 'Odeslat stav expedice' });
  await expect(importOrder).toBeDisabled();
  await orderId.fill('9007199254740992');
  await expect(sync).toBeDisabled();
  await orderId.fill(' 1042 ');
  await expect(orderId).toHaveValue('1042');
  await importOrder.click();
  await expect(card.getByRole('status')).toContainText('Objednávka importována do WMS');
  expect(observedOrderId).toBe(1042);
  await importOrder.click();
  await expect(card.getByRole('status')).toContainText('Objednávka už je ve WMS');
  await sync.click();
  await expect(card.getByRole('alert')).toContainText('Zkontrolujte, že je objednávka odeslaná ve WMS a potvrzená v Base.com.');
  dispatched = true;
  await sync.click();
  await expect(card.getByRole('status')).toContainText('Stav expedice odeslán do Base.com');
  await sync.click();
  await expect(card.getByRole('status')).toContainText('Base.com už má stav expedice');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('phone navigation groups secondary pages and restores focus on Escape', async ({ page }) => {
  const isQueue = url => new URL(url).pathname.endsWith('/rf/queue');
  let releaseQueue;
  const pendingQueue = new Promise(resolve => { releaseQueue = resolve; });
  await page.route(url => isQueue(url.href), async route => {
    await pendingQueue;
    await route.continue();
  }, { times: 1 });
  const requested = page.waitForRequest(request => isQueue(request.url()));
  const nav = mobileNav(page);
  const more = nav.getByRole('button', { name: 'Další' });
  const support = nav.getByRole('region', { name: 'PODPORA' });
  const stock = support.getByRole('button', { name: 'Zásoby' });
  try {
    await login(page, roles.worker);
    await requested;
    await page.setViewportSize({ width: 320, height: 750 });
    await expect(nav.getByRole('button', { name: 'Skenování' })).toBeVisible();
    await more.click();
    await expect(stock).toBeFocused();
  } finally {
    releaseQueue();
  }
  await expect(page.getByTestId('rf-scan-input')).toBeEnabled();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(stock).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(support).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await stock.click();
  await expect(page).toHaveURL(/#\/inventory$/);
  await expect(support).toHaveCount(0);
  const stockTable = page.locator('.inventory-minimal-page .data-table');
  await expect(stockTable).toBeVisible();
  const tableBox = await stockTable.boundingBox();
  expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(321);
  await page.locator('.account-button__gear').click();
  const box = await page.locator('.account-panel').boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
});

test('system search keeps keyboard focus in the dialog and opens a result on Enter', async ({ page }) => {
  await login(page, roles.manager);
  const previousControl = desktopNav(page).getByRole('button', { name: 'Přehled', exact: true });
  await previousControl.focus();
  const dialog = page.getByRole('dialog', { name: 'Vyhledávání v systému' });
  const search = dialog.getByRole('textbox', { name: 'Hledat v systému' });

  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await previousControl.evaluate(element => element.focus());
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(previousControl).toBeFocused();

  await page.setViewportSize({ width: 320, height: 590 });
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(590);
  await search.fill('nenalezeny-vysledek');
  await expect(dialog.getByRole('status')).toBeVisible();
  await search.fill('zasoby');
  await search.press('Enter');
  await expect(page).toHaveURL(/#\/inventory$/);
  await expect(dialog).toBeHidden();
});

test('inventory distinguishes no matches and blocks invalid moves and unauthorized corrections', async ({ page }) => {
  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Zásoby' }).click();
  const search = page.getByTestId('inventory-search');
  await search.fill('inventory-match-that-does-not-exist');
  await expect(page.getByText('Žádné výsledky', { exact: true })).toBeVisible();
  await expect(page.locator('[data-e2e-action="inventory-receive"]')).toHaveCount(0);

  await search.fill('ABC-123');
  await page.getByRole('radio', { name: /ABC-123 · A-01-01/ }).first().check();
  const reserved = page.getByRole('columnheader', { name: 'Rezervované' });
  expect(await reserved.evaluate(element => {
    const textRange = document.createRange();
    textRange.selectNodeContents(element);
    return textRange.getClientRects().length;
  })).toBe(1);
  await expect(page.locator('[data-e2e-action="inventory-adjust"]')).toHaveCount(0);
  const move = page.locator('[data-e2e-action="inventory-move"]');
  const quantity = page.getByTestId('inventory-quantity');
  const destination = page.getByTestId('inventory-target-location');
  await destination.fill('A-01-01');
  await expect(move).toBeDisabled();
  await expect(page.getByText('Zadejte jinou cílovou lokaci.')).toBeVisible();
  await destination.fill('PACK-01');
  await quantity.fill('0');
  await expect(move).toBeDisabled();
  await quantity.fill('1.5');
  await expect(move).toBeDisabled();
  await quantity.fill('2000000000');
  await expect(move).toBeDisabled();
  await expect(page.getByText('Zadejte množství, které je v této lokaci dostupné.')).toBeVisible();
  await quantity.fill('1');
  await page.route('**/inventory/quants/move', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ quantity: 1, toLocationReference: 'PACK-01' });
    await route.fulfill({ json: { status: 'AVAILABLE' } });
  });
  const moved = page.waitForResponse(response => response.url().endsWith('/inventory/quants/move'));
  await move.click();
  expect((await moved).ok()).toBe(true);
});

test('inventory moves exactly the serial numbers entered by the operator', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const own = (path, data) => liveApi(page, '/api/warehouses/MAIN' + path, { token: admin, data });
  const code = `UI-SERIAL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = await liveApi(page, '/api/products', { token: admin, data: { code, name: 'Serialized test product' } });
  const sku = await liveApi(page, '/api/products/skus', {
    token: admin, data: { code, productReference: product.id, name: 'Serialized test SKU' },
  });
  const { quant: source } = await own('/inventory/quants/receive', {
    skuReference: code, locationReference: 'A-01-01', quantity: 2,
  });
  const serials = [];
  for (const label of ['A', 'B']) {
    serials.push(await own('/traceability/serial-numbers', {
      skuReference: sku.id, stockQuantId: source.id, serialNumber: `${code}-${label}`,
    }));
  }
  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Zásoby' }).click();
  await page.getByTestId('inventory-search').fill(code);
  await page.locator(`[data-e2e-row="quant"][data-e2e-value^="${source.id} "]`).check();
  await page.getByTestId('inventory-target-location').fill('PACK-01');
  await page.getByText('Sériová čísla', { exact: true }).click();
  const labels = page.getByRole('textbox', { name: 'Sériová čísla' });
  const move = page.locator('[data-e2e-action="inventory-move"]');
  await labels.fill(serials.map(item => item.serialNumber).join('\n'));
  await expect(move).toBeDisabled();
  await labels.fill(serials[1].serialNumber);
  await move.click();
  await expect.poll(() => own(`/inventory/quants/${source.id}`)).toMatchObject({ quantity: 1 });
  const stayed = await own(`/traceability/serial-numbers/${serials[0].id}`);
  const transferred = await own(`/traceability/serial-numbers/${serials[1].id}`);
  expect(stayed.stockQuantId).toBe(source.id);
  expect(transferred.stockQuantId).not.toBe(source.id);
  const destination = await own(`/inventory/quants/${transferred.stockQuantId}`);
  expect(destination.location.code).toBe('PACK-01');
  expect(destination.quantity).toBe(1);
});

test('manager inventory includes manual correction and wave details are keyboard accessible', async ({ page }) => {
  await login(page, roles.manager);
  await desktopNav(page).getByRole('button', { name: 'Zásoby' }).click();
  await expect(page.locator('[data-e2e-action="inventory-adjust"]')).toBeVisible();

  await page.route('**/api/warehouses/*/pick-waves', route => route.fulfill({
    json: [{ waveNumber: 'WAVE-TEST-FOCUS', status: 'DRAFT', orderCount: 1, lineCount: 2 }],
  }));
  await desktopNav(page).getByRole('button', { name: 'Vlny' }).click();
  const trigger = page.getByRole('button', { name: 'WAVE-TEST-FOCUS' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'WAVE-TEST-FOCUS' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Zavřít' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('outbound actions stay on a visible order and a new allocation can reserve added stock', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const run = randomUUID().slice(0, 8).toUpperCase();
  const sku = `OUT-${run}`;
  const warehouse = '/api/warehouses/MAIN';
  const own = (path, data) => liveApi(page, warehouse + path, { token: admin, data });
  const product = await liveApi(page, '/api/products', { token: admin, data: { code: sku, name: 'Outbound test product' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { productReference: product.id, code: sku, name: 'Outbound test SKU' } });
  const receive = quantity => own('/inventory/quants/receive', { skuReference: sku, locationReference: 'A-01-01', quantity });
  await receive(2);
  const shipped = await own('/outbound-orders', { orderNumber: `OUT-SHIPPED-${run}`, status: 'SHIPPED' });
  const order = await own('/outbound-orders', {
    orderNumber: sku, lines: [{ lineNumber: '10', sku, orderedQuantity: 2 }],
  });

  await login(page, roles.manager);
  await desktopNav(page).getByRole('button', { name: 'Objednávky', exact: true }).click();
  const allocate = page.getByRole('button', { name: 'Alokovat vybranou' });
  const release = page.getByRole('button', { name: 'Uvolnit picking' });
  const currentOrder = page.getByRole('radio', { name: order.orderNumber, exact: true });
  await expect(currentOrder).toBeVisible();
  await expect(allocate).toBeDisabled();
  await currentOrder.check();
  await expect(allocate).toBeEnabled();
  await expect(release).toBeDisabled();

  await page.getByRole('button', { name: 'Odeslané', exact: true }).click();
  await expect(currentOrder).toHaveCount(0);
  await expect(allocate).toBeDisabled();
  await page.getByRole('radio', { name: shipped.orderNumber }).check();
  await expect(allocate).toBeDisabled();
  await expect(release).toBeDisabled();
  await page.getByRole('button', { name: 'Aktivní', exact: true }).click();
  await currentOrder.check();

  const allocationPath = `${warehouse}/outbound-orders/${order.id}/allocate`;
  async function allocateOnce() {
    const response = page.waitForResponse(item => new URL(item.url()).pathname === allocationPath && item.request().method() === 'POST');
    await allocate.click();
    const result = await response;
    expect(result.ok()).toBe(true);
    const body = await result.json();
    return { key: result.request().headers()['idempotency-key'], lines: (body.data ?? body).lines };
  }
  const first = await allocateOnce();
  expect(first.lines[0].allocatedQuantity).toBe(2);
  await expect(release).toBeEnabled();
  const changed = await page.request.patch(new URL(`${warehouse}/outbound-orders/${order.id}`, base).href, {
    headers: { Authorization: `Bearer ${admin}`, 'Idempotency-Key': randomUUID() },
    data: { lines: [{ lineReference: '10', orderedQuantity: 5 }] },
  });
  expect(changed.ok()).toBe(true);
  await receive(3);
  const second = await allocateOnce();
  expect(second.key).not.toBe(first.key);
  expect(second.lines[0]).toMatchObject({ allocatedQuantity: 3, remainingQuantity: 0 });
  await release.click();
  await expect(page.getByRole('row').filter({ has: currentOrder })).toContainText('Vychystává se');
  await expect(allocate).toBeDisabled();
  await expect(release).toBeDisabled();
  expect((await own(`/outbound-orders/${shipped.id}`)).status).toBe('SHIPPED');
});

test('worker deep links to restricted pages return to the scanner', async ({ page }) => {
  await login(page, roles.worker);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page).toHaveURL(/#\/rf$/);
  await expect(page.locator('.content').getByRole('heading', { name: 'RF skener' })).toBeVisible();
  await expect(desktopNav(page).getByRole('button', { name: 'Nastavení' })).toHaveCount(0);
});

test('receiving uses actual shipment lines, routes to the correct dock and retries without adding stock twice', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Enable writes only on a disposable database.');
  test.setTimeout(60000);
  await login(page, roles.worker);
  const api = (path, options) => liveApi(page, path, options);
  const warehouse = '/api/warehouses/MAIN';
  const path = warehouse + '/inbound-shipments';
  const id = randomUUID().slice(0, 8).toUpperCase();
  const sku = `RECEIPT-${id}`;
  const { accessToken: admin } = await api('/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const product = await api('/api/products', { token: admin, data: { code: sku, name: 'Receiving browser fixture' } });
  await api('/api/products/skus', { token: admin, data: { code: sku, name: 'Receiving browser SKU', productReference: product.id } });
  const dock = await api(warehouse + '/locations', {
    token: admin, data: { code: `DOCK-${id}`, name: 'Receiving browser dock', type: 'RECEIVING' },
  });
  const create = (label, lines, extra = {}) => api(path, {
    token: admin, data: { shipmentNumber: `ASN-${label}-${id}`, lines, ...extra },
  });
  const multi = await create('DEFAULT', [
    { lineNumber: '20', sku, expectedQuantity: 4 },
    { lineNumber: '90', sku, expectedQuantity: 1 },
  ]);
  const assigned = await create('DOCK', [{ lineNumber: '55', sku, expectedQuantity: 1 }], { dockLocationReference: dock.code });
  const cancelled = await create('CANCELLED', [{ lineNumber: '30', sku, expectedQuantity: 1 }], { status: 'CANCELLED' });
  const row = shipment => page.getByRole('radio', { name: shipment.shipmentNumber });
  const count = page.getByTestId('inbound-quantity');
  const line = page.getByTestId('inbound-line-reference');
  const submit = page.locator('[data-e2e-action="inbound-receive"]');
  const receipt = shipment => `${path}/${shipment.id}/receive`;
  const isReceipt = (response, shipment) => response.request().method() === 'POST' && new URL(response.url()).pathname === receipt(shipment);
  const state = shipment => api(`${path}/${shipment.id}`, { token: admin });
  const quant = id => api(warehouse + '/inventory/quants/' + id, { token: admin });

  await desktopNav(page).getByRole('button', { name: 'Příjem', exact: true }).click();
  await expect(row(multi)).toBeVisible();
  await expect(row(cancelled)).toHaveCount(0);
  await expect(submit).toHaveCount(0);
  await row(multi).check();
  await expect(count).toBeDisabled();
  const [first, second] = multi.lines;
  await line.selectOption(first.id);
  for (const invalid of ['-1', '0', '1.5', '5', '1e0', '2147483648']) {
    await count.fill(invalid);
    await expect(submit).toBeDisabled();
  }
  expect((await state(multi)).lines.map(item => item.receivedQuantity)).toEqual([0, 0]);

  let lostReceipt;
  let sentKey;
  await page.route(`**${receipt(multi)}`, async route => {
    const request = route.request();
    sentKey = request.headers()['idempotency-key'];
    expect(request.postDataJSON()).toMatchObject({ lineReference: first.id, quantity: 2 });
    expect(request.postDataJSON()).not.toHaveProperty('locationReference');
    const saved = await route.fetch();
    expect(saved.ok()).toBe(true);
    lostReceipt = await saved.json();
    await route.abort();
  }, { times: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await count.fill('2');
  await submit.click();
  await expect(page.getByText(/Přijmout řádek selhalo/)).toBeVisible();
  expect((await state(multi)).lines.map(item => item.receivedQuantity)).toEqual([2, 0]);
  expect(await quant(lostReceipt.quant.id)).toMatchObject({ quantity: 2, location: { code: 'RCV-01' } });

  const retry = page.waitForResponse(response => isReceipt(response, multi));
  await submit.click();
  const replay = await retry;
  expect(replay.ok()).toBe(true);
  expect(replay.request().headers()['idempotency-key']).toBe(sentKey);
  expect((await replay.json()).movement.id).toBe(lostReceipt.movement.id);
  await expect(count).toHaveValue('');
  await expect(count).toHaveAttribute('max', '2');
  expect(await quant(lostReceipt.quant.id)).toMatchObject({ quantity: 2 });

  await line.selectOption(second.id);
  await count.fill('1');
  const secondSaved = page.waitForResponse(response => isReceipt(response, multi));
  await submit.click();
  expect((await secondSaved).ok()).toBe(true);
  await expect(line.locator('option')).toHaveCount(2);
  await expect(line).toHaveValue(first.id);
  await expect(count).toHaveValue('');
  await count.fill('2');
  await submit.click();
  await expect(row(multi)).toHaveCount(0);
  expect(await state(multi)).toMatchObject({ status: 'RECEIVED' });
  expect(await quant(lostReceipt.quant.id)).toMatchObject({ quantity: 5 });

  await row(assigned).check();
  await expect(line).toHaveValue(assigned.lines[0].id);
  await count.fill('1');
  const toDock = page.waitForResponse(response => isReceipt(response, assigned));
  await submit.click();
  const received = await toDock;
  expect(received.ok()).toBe(true);
  expect(received.request().postDataJSON()).toMatchObject({ locationReference: dock.code });
  expect(await quant((await received.json()).quant.id)).toMatchObject({ quantity: 1, location: { code: dock.code } });

  await page.getByRole('button', { name: 'Vše', exact: true }).click();
  await expect(row(multi)).toBeVisible();
  await row(cancelled).check();
  const cancelledRow = page.getByRole('row').filter({ has: row(cancelled) });
  await expect(cancelledRow.getByText('Zrušeno', { exact: true })).toBeVisible();
  await expect(submit).toHaveCount(0);
});

test('packing keeps orders separate and resumes packages, labels and dispatch from the server', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Enable writes only on a disposable database.');
  test.setTimeout(90000);
  await login(page, roles.worker);
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const warehouse = '/api/warehouses/MAIN';
  const run = randomUUID().slice(0, 8).toUpperCase();
  const sku = `PACK-${run}`;
  const barcode = `BAR-${run}`;
  const own = (path, data) => liveApi(page, warehouse + path, { token: admin, data });
  const product = await liveApi(page, '/api/products', { token: admin, data: { code: sku, name: 'Packing fixture' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { productReference: product.id, code: sku, name: 'Packing fixture SKU', barcode } });
  await own('/inventory/quants/receive', { skuReference: sku, locationReference: 'A-01-01', quantity: 5 });

  async function pick(label, quantities, { prepack = true, carrier = 'EXPRESS_CARRIER' } = {}) {
    const order = await own('/outbound-orders', {
      orderNumber: `PACK-${label}-${run}`, carrier,
      lines: quantities.map((orderedQuantity, index) => ({ sku, lineNumber: String((index + 1) * 10), orderedQuantity })),
    });
    await own(`/outbound-orders/${order.id}/allocate`, {});
    await own(`/outbound-orders/${order.id}/release-picking`, {});
    const tasks = (await own(`/tasks?type=PICK&sku=${encodeURIComponent(sku)}`))
      .filter(task => task.outboundOrderId === order.id);
    expect(tasks).toHaveLength(quantities.length);
    for (const task of tasks) {
      await own(`/tasks/${task.id}/confirm-pick`, { orderReference: order.id, quantity: task.quantity });
    }
    if (!prepack) return { order };
    const shipment = await own('/shipments', {
      shipmentNumber: `SHP-${label}-${run}`, outboundOrderReference: order.id, packingStationReference: 'PACK-01',
    });
    const initial = await own(`/shipments/${shipment.id}/packages`, {
      packageCode: `BOX-${label}-${run}`,
      contents: [{ sku, outboundOrderLineReference: order.lines[0].id, quantity: 1 }],
    });
    return { order, shipment, initial };
  }

  const older = await pick('OLDER', [2, 1]);
  const newer = await pick('NEWER', [1]);
  const pickup = await pick('PICKUP', [1], { prepack: false, carrier: 'PICKUP' });
  const packagesPath = fixture => `/shipments/${fixture.shipment.id}/packages`;
  const packages = fixture => own(packagesPath(fixture));
  const shipments = fixture => own(`/shipments?outboundOrderReference=${fixture.order.id}`);
  const expectNoWrite = (button) => expect(button).toBeDisabled();

  await desktopNav(page).getByRole('button', { name: 'Balení', exact: true }).click();
  const orders = page.getByRole('combobox', { name: 'Objednávka' });
  await expect(orders.locator('option').filter({ hasText: older.order.orderNumber })).toHaveCount(1);
  await expect(orders.locator('option').filter({ hasText: newer.order.orderNumber })).toHaveCount(1);
  await expect(orders).toHaveValue('');
  await orders.selectOption(older.order.id);
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.getByTestId('packing-scan-input');
  const packButton = page.getByRole('button', { name: 'Vytvořit balík', exact: true });
  const shipButton = page.getByRole('button', { name: 'Odeslat zásilku', exact: true });
  const line = number => page.locator('.packing-lines article').filter({ has: page.getByText(`Řádek ${number}`, { exact: true }) });
  const packageRow = code => page.locator('.packing-lines article').filter({ hasText: code });
  const scan = async code => {
    await input.fill(code);
    await input.press('Enter');
  };
  await expect(packageRow(older.initial.packageCode)).toBeVisible();
  await expect(line(10)).toContainText('1/2');
  await expectNoWrite(shipButton);
  await scan('UNKNOWN-' + run);
  await expect(page.getByRole('alert')).toHaveText('Kód nepatří k vybrané objednávce.');
  await expectNoWrite(packButton);
  await scan(sku);
  await expect(line(10)).toContainText('Naskenováno 1');
  await expect(line(20)).toContainText('Naskenováno 0');
  await orders.selectOption(newer.order.id);
  await expect(packageRow(newer.initial.packageCode)).toBeVisible();
  await expect(packButton).toHaveCount(0);
  await orders.selectOption(older.order.id);
  await expect(line(10)).toContainText('Naskenováno 0');
  await scan(sku);
  await scan(barcode);
  await expect(line(10)).toContainText('Naskenováno 1');
  await expect(line(20)).toContainText('Naskenováno 1');
  const weight = page.getByRole('spinbutton', { name: 'Hmotnost balíku v g (volitelně)' });
  await weight.fill('-1');
  await expectNoWrite(packButton);
  await weight.fill('620');
  await packButton.click();
  await expect(line(10)).toContainText('2/2');
  await expect(line(20)).toContainText('1/1');
  const saved = await packages(older);
  expect(saved).toHaveLength(2);
  const added = saved.find(pack => pack.id !== older.initial.id);
  expect(added.weightGrams).toBe(620);
  expect(added.contents).toEqual(expect.arrayContaining(older.order.lines.map(item => ({
    sku, outboundOrderLineId: item.id, quantity: 1,
  }))));
  expect(await shipments(older)).toHaveLength(1);
  expect(await packages(newer)).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expectNoWrite(shipButton);
  for (const pack of saved) {
    await packageRow(pack.packageCode).getByRole('button', { name: 'Vygenerovat štítek' }).click();
    await expect(packageRow(pack.packageCode)).toContainText('Štítek připraven');
  }

  const firstPack = packageRow(saved[0].packageCode);
  const downloaded = page.waitForEvent('download');
  await firstPack.getByRole('button', { name: 'Stáhnout štítek' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.zpl$/);
  const zpl = await readFile(await file.path(), 'utf8');
  expect(zpl).toMatch(/^\^XA[\s\S]*\^XZ$/);
  expect(zpl).toContain(saved[0].trackingNumber);

  const printerCode = `PACK-PRINTER-${run}`;
  const agentCode = `PACK-AGENT-${run}`;
  const token = randomUUID();
  await own('/printers', { code: printerCode, name: 'Packing test printer', protocol: 'WINDOWS_RAW', windowsPrinterName: 'Test-only printer' });
  await own('/print-agents', { code: agentCode, name: 'Packing test agent', token, printerCodes: [printerCode] });
  await page.reload();
  await orders.selectOption(older.order.id);
  const printer = page.getByRole('combobox', { name: 'Tiskárna' });
  await expect(printer.getByRole('option', { name: new RegExp(printerCode) })).toBeAttached();
  await printer.selectOption(printerCode);
  const queueResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/print-jobs'));
  await firstPack.getByRole('button', { name: 'Zařadit štítek k tisku' }).click();
  const queued = await queueResponse;
  expect(queued.ok()).toBe(true);
  const job = await queued.json();
  expect(job).toMatchObject({ printerCode, status: 'QUEUED', renderedZpl: zpl });
  await expect(firstPack).toContainText('Čeká na potvrzení tisku');
  await expect(firstPack.getByRole('button', { name: 'Zařadit štítek k tisku' })).toBeDisabled();
  expect((await packages(older)).find(pack => pack.id === saved[0].id).label.status).toBe('GENERATED');
  const claimed = await own('/print-agent/jobs/claim', { agentCode, token, limit: 1 });
  expect(claimed.jobs.map(item => item.id)).toEqual([job.id]);
  const resultPath = `/print-agent/jobs/${job.id}/result`;
  await own(resultPath, { agentCode, token, status: 'PRINTED' });
  await own(resultPath, { agentCode, token, status: 'PRINTED' });
  await page.reload();
  await orders.selectOption(older.order.id);
  await expect(firstPack).toContainText('Štítek vytištěn');
  const labelsAfterPrint = await packages(older);
  expect(labelsAfterPrint.find(pack => pack.id === saved[0].id).label.status).toBe('PRINTED');
  expect(labelsAfterPrint.find(pack => pack.id === saved[1].id).label.status).toBe('GENERATED');

  await expect(shipButton).toBeEnabled();
  await page.route(`**/shipments/${older.shipment.id}/ship`, route => route.abort(), { times: 1 });
  await shipButton.click();
  await expect(page.getByText(/Odeslat zásilku selhalo/)).toBeVisible();
  expect((await shipments(older))[0].status).toBe('STAGED');

  await page.reload();
  await orders.selectOption(older.order.id);
  await expect(firstPack).toContainText('Štítek vytištěn');
  await expect(packageRow(saved[1].packageCode)).toContainText('Štítek připraven');
  await expect(shipButton).toBeEnabled();
  const dispatch = page.waitForResponse(response => response.url().endsWith(`/shipments/${older.shipment.id}/ship`));
  await shipButton.click();
  expect((await dispatch).ok()).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: older.order.orderNumber })).toBeVisible();
  expect((await shipments(older))[0].status).toBe('SHIPPED');
  expect((await shipments(newer))[0].status).toBe('PACKING');
  expect((await packages(older)).find(pack => pack.id === saved[1].id).label.status).toBe('GENERATED');

  await orders.selectOption(pickup.order.id);
  expect(await shipments(pickup)).toHaveLength(0);
  let packageResponseLost = false;
  await page.route('**/shipments/*/packages', async route => {
    if (route.request().method() !== 'POST' || packageResponseLost) {
      await route.continue();
      return;
    }
    packageResponseLost = true;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort();
  });
  await scan(sku);
  await packButton.click();
  await expect(shipButton).toBeEnabled();
  expect(packageResponseLost).toBe(true);
  const [pickupShipment] = await shipments(pickup);
  const pickupPackages = await own(`/shipments/${pickupShipment.id}/packages`);
  expect(pickupPackages).toHaveLength(1);
  expect(pickupPackages[0]).toMatchObject({ weightGrams: null, labelReady: false });
  await shipButton.click();
  await expect(page.getByRole('status').filter({ hasText: pickup.order.orderNumber })).toBeVisible();
  expect((await shipments(pickup))[0].status).toBe('SHIPPED');
});

test('the tasks page confirms putaway by moving the planned stock', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const own = (path, data) => liveApi(page, '/api/warehouses/MAIN' + path, { token: admin, data });
  const code = `UI-PUTAWAY-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = await liveApi(page, '/api/products', { token: admin, data: { code, name: 'Putaway test product' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { code, productReference: product.id, name: 'Putaway test SKU' } });
  const location = await own('/locations', { code, name: 'Putaway test target', type: 'STORAGE', parentReference: 'A-01' });
  const { quant: source } = await own('/inventory/quants/receive', {
    skuReference: code, locationReference: 'A-01-01', quantity: 6,
  });
  const { task } = await own('/putaway/tasks', { stockQuantReference: source.id, toLocationReference: location.id, quantity: 2 });

  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Úkoly', exact: true }).click();
  const taskRow = page.locator(`[data-e2e-row="task"][data-e2e-value="${task.id}"]`);
  await taskRow.check();
  const start = page.locator('[data-e2e-action="task-start-selected"]');
  const confirm = page.locator('[data-e2e-action="task-confirm-selected"]');
  await expect(confirm).toBeDisabled();
  await start.click();
  await expect(confirm).toBeEnabled();
  await page.getByRole('button', { name: 'Hotové', exact: true }).click();
  await expect(taskRow).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Otevřené', exact: true }).click();
  await expect(taskRow).toBeChecked();
  await expect(confirm).toBeEnabled();

  const confirmation = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith(`/putaway/tasks/${task.id}/confirm`));
  await confirm.click();
  const response = await confirmation;
  expect(response.status()).toBe(201);
  const body = await response.json();
  const data = body.data ?? body;
  expect(data.task.status).toBe('DONE');
  expect(data.movement).toMatchObject({ quantity: 2, toLocationId: location.id, taskId: task.id });
  expect((await own(`/inventory/quants/${source.id}`)).quantity).toBe(4);
  expect((await own(`/inventory/quants/${data.targetQuant.id}`)).quantity).toBe(2);
  await expect(taskRow).toHaveCount(0);
});

test('the tasks page moves the planned stock to its destination', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const own = (path, data) => liveApi(page, '/api/warehouses/MAIN' + path, { token: admin, data });
  const code = `UI-MOVE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = await liveApi(page, '/api/products', { token: admin, data: { code, name: 'Movement test product' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { code, productReference: product.id, name: 'Movement test SKU' } });
  const target = await own('/locations', {
    code: `${code}-TARGET`, name: 'Movement test bin', type: 'STORAGE', parentReference: 'A-01',
  });
  const { quant: stock } = await own('/inventory/quants/receive', {
    skuReference: code, locationReference: 'A-01-01', quantity: 6, batch: 'UI-MOVE',
  });
  const task = await own('/tasks', {
    type: 'MOVE', sku: code, fromLocationReference: 'A-01-01', toLocationReference: target.id, quantity: 2,
  });

  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Úkoly', exact: true }).click();
  await page.locator(`[data-e2e-row="task"][data-e2e-value="${task.id}"]`).check();
  const confirm = page.locator('[data-e2e-action="task-confirm-selected"]');
  await expect(confirm).toBeDisabled();
  await page.locator('[data-e2e-action="task-start-selected"]').click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => own(`/tasks/${task.id}`)).toMatchObject({ status: 'DONE', quantity: 2 });
  expect((await own(`/inventory/quants/${stock.id}`)).quantity).toBe(4);
  const destination = await own(`/inventory/quants?skuReference=${code}&locationReference=${target.code}`);
  expect(destination).toHaveLength(1);
  expect(destination[0]).toMatchObject({ quantity: 2, batch: 'UI-MOVE' });
});

test('the tasks page records an explicit zero when confirming a count order', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const own = (path, data) => liveApi(page, '/api/warehouses/MAIN' + path, { token: admin, data });
  const order = await own('/warehouse-orders', {
    orderType: 'COUNT', orderNumber: `UI-COUNT-${randomUUID().slice(0, 8)}`,
    fromLocationReference: 'A-01-01', lines: [{ lineNumber: '1', requestedQuantity: 5 }],
  });
  const orderPath = `/warehouse-orders/${order.id}`;
  const released = await own(orderPath + '/release', {});
  const taskId = released.taskLinks[0].warehouseTaskId;
  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Úkoly', exact: true }).click();
  await page.locator(`[data-e2e-row="task"][data-e2e-value="${taskId}"]`).check();
  await page.locator('[data-e2e-action="task-start-selected"]').click();
  const count = page.getByLabel('Spočítané množství');
  const confirm = page.locator('[data-e2e-action="task-confirm-selected"]');
  await expect(count).toBeVisible();
  await expect(count).toHaveValue('');
  await expect(confirm).toBeDisabled();
  await count.fill('-1');
  await expect(confirm).toBeDisabled();
  await count.fill('0');
  await confirm.click();
  await expect.poll(() => own(`/tasks/${taskId}`)).toMatchObject({ status: 'DONE', quantity: 0 });
  const closed = await own(orderPath + '/complete', {});
  expect(closed.lines[0].completedQuantity).toBe(0);
});

// The service worker can handle these requests before Playwright intercepts them.
const interceptedTest = test.extend({ serviceWorkers: 'block' });
interceptedTest('the RF browser uploads stored scans in order and keeps every unconfirmed scan after an interrupted batch', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const warehouse = '/api/warehouses/MAIN';
  const { accessToken: worker } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.worker.email, password: roles.worker.password },
  });
  const session = await liveApi(page, warehouse + '/rf/sessions', { token: worker, data: { workflow: 'MOVE' } });
  const run = randomUUID();
  const scans = Array.from({ length: 101 }, (_, index) => ({
    idempotencyKey: `${run}-${index}`,
    warehouseId: 'MAIN',
    scannedValue: `OFFLINE-${index}`,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    metadata: {},
    ...(index === 0 ? { sessionReference: session.sessionId, stepKey: session.step.key } : {}),
    ...(index === 1 ? { sessionReference: randomUUID(), stepKey: session.step.key } : {}),
  }));
  await page.addInitScript(items => {
    if (sessionStorage.getItem('rf-test-fixture-loaded')) return;
    localStorage.setItem('wms-rf-offline-queue-v3:MAIN', JSON.stringify(items));
    sessionStorage.setItem('rf-test-fixture-loaded', 'yes');
  }, scans);
  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Skenování', exact: true }).click();
  const queueButton = page.locator('[data-e2e-action="rf-sync-offline"]');
  await expect(queueButton).toContainText('(101)');

  const calls = [];
  await page.route('**/rf/offline/sync', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (calls.length === 2) await route.abort();
    else await route.continue();
  });
  await queueButton.click();
  await expect(queueButton).toContainText('(100)');
  await expect(queueButton).toBeEnabled();
  expect(calls.map(body => body.scans.length)).toEqual([100, 1]);
  expect(calls.flatMap(body => body.scans.map(scan => scan.idempotencyKey))).toEqual(scans.map(scan => scan.idempotencyKey));
  for (const body of calls) {
    expect(Object.keys(body).every(key => ['scans', 'scannerDeviceReference'].includes(key))).toBe(true);
    expect(body.scans.every(scan => !('warehouseId' in scan))).toBe(true);
  }
  const after = await liveApi(page, `${warehouse}/rf/sessions/${session.sessionId}`, { token: worker });
  expect(after.status).toBe('COMPLETED');

  await page.reload();
  await expect(queueButton).toContainText('(100)');
  const retry = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rf/offline/sync'));
  await queueButton.click();
  const response = await retry;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const result = body.data ?? body;
  expect(result).toMatchObject({ synced: 0, duplicates: 0, failed: 1, queued: 99 });
  await expect(queueButton).toContainText('(100)');
  expect(calls[2].scans.map(scan => scan.idempotencyKey)).toEqual(scans.slice(1).map(scan => scan.idempotencyKey));
});

test('RF putaway validates the quantity and moves stock after an offline confirmation is uploaded', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const warehouse = '/api/warehouses/MAIN';
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const own = (path, data) => liveApi(page, warehouse + path, { token: admin, data });
  const code = `RF-BIN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = await liveApi(page, '/api/products', { token: admin, data: { code, name: 'RF putaway product' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { code, productReference: product.id, name: 'RF putaway SKU' } });
  const target = await own('/locations', {
    code: `${code}-TARGET`, name: 'RF putaway test bin', type: 'STORAGE', parentReference: 'A-01',
  });
  const { quant: stock } = await own('/inventory/quants/receive', {
    skuReference: code, locationReference: 'A-01-01', quantity: 6,
  });
  const { task } = await own('/putaway/tasks', { stockQuantReference: stock.id, toLocationReference: target.id, quantity: 3 });

  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Skenování', exact: true }).click();
  await page.locator(`[data-e2e-row="rf-task"][data-e2e-value="${task.id}"]`).click();
  await page.locator('[data-e2e-action="rf-start-resume"]').click();
  const expected = page.getByTestId('rf-expected-scan');
  const input = page.getByTestId('rf-scan-input');
  const confirm = page.locator('[data-e2e-action="rf-confirm-scan"]');
  const sendQueue = page.locator('[data-e2e-action="rf-sync-offline"]');
  for (const value of [code, 'A-01-01', target.code]) {
    await expect(expected).toHaveText(value, { ignoreCase: true });
    await input.fill(value);
    await confirm.click();
    await expect(input).toHaveValue('');
  }
  await expect(expected).toHaveText('3');
  for (const value of ['0', '4']) {
    await input.fill(value);
    await expect(confirm).toBeDisabled();
  }
  await page.context().setOffline(true);
  try {
    await expect(page.locator('[data-e2e-action="rf-toggle-offline"]')).toHaveText('Offline zapnuto');
    await input.fill('2');
    await confirm.click();
    await expect(sendQueue).toContainText('(1)');
  } finally {
    await page.context().setOffline(false);
  }
  expect((await own(`/inventory/quants/${stock.id}`)).quantity).toBe(6);
  await sendQueue.click();
  await expect(page.getByRole('heading', { name: 'Dokončeno', exact: true })).toBeVisible();
  await expect(sendQueue).toHaveCount(0);
  expect(await own(`/tasks/${task.id}`)).toMatchObject({ status: 'DONE', quantity: 2 });
  expect((await own(`/inventory/quants/${stock.id}`)).quantity).toBe(4);
  const stored = await own(`/inventory/quants?skuReference=${code}&locationReference=${target.code}`);
  expect(stored).toHaveLength(1);
  expect(stored[0].quantity).toBe(2);
});

test('an open RF count advances without a connection and submits only after reconnecting', async ({ page }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Requires a disposable warehouse database.');
  const warehouse = '/api/warehouses/MAIN';
  const { accessToken: admin } = await liveApi(page, '/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const sku = `RF-OFFLINE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const own = (path, data) => liveApi(page, warehouse + path, { token: admin, data });
  const product = await liveApi(page, '/api/products', { token: admin, data: { code: sku, name: 'Offline count product' } });
  await liveApi(page, '/api/products/skus', { token: admin, data: { productReference: product.id, code: sku, name: 'Offline count SKU' } });
  await own('/inventory/quants/receive', { skuReference: sku, locationReference: 'A-01-01', quantity: 7 });
  const plan = await own('/cycle-counts', { code: sku, scopeType: 'SKU', scopeReference: sku });
  const tasksPath = `/cycle-counts/${plan.id}/tasks`;
  await own(`/cycle-counts/${plan.id}/release`, {});
  const [task] = await own(tasksPath);

  await login(page, roles.worker);
  await desktopNav(page).getByRole('button', { name: 'Skenování', exact: true }).click();
  await page.locator(`[data-e2e-row="rf-task"][data-e2e-value="${task.warehouseTaskId}"]`).click();
  await page.locator('[data-e2e-action="rf-start-resume"]').click();
  const expected = page.getByTestId('rf-expected-scan');
  const input = page.getByTestId('rf-scan-input');
  const confirm = page.locator('[data-e2e-action="rf-confirm-scan"]');
  const sendQueue = page.locator('[data-e2e-action="rf-sync-offline"]');
  await expect(expected).toHaveText('A-01-01');
  const scan = async value => {
    await input.fill(value);
    await confirm.click();
    await expect(input).toHaveValue('');
  };
  await page.context().setOffline(true);
  try {
    await expect(page.locator('[data-e2e-action="rf-toggle-offline"]')).toHaveText('Offline zapnuto');
    await scan('WRONG-LOCATION');
    await expect(expected).toHaveText('A-01-01');
    await scan('A-01-01');
    await expect(expected).toHaveText(sku);
    await scan(sku);
    await expect(page.locator('.rf-quantity-controls')).toBeVisible();
    await expect(expected).toHaveCount(0);
    await scan('0');
    await expect(page.getByRole('heading', { name: 'Všechny kroky jsou uložené v zařízení.' })).toBeVisible();
    await expect(sendQueue).toContainText('(4)');
    await expect(sendQueue).toBeDisabled();
  } finally {
    await page.context().setOffline(false);
  }
  expect((await own(tasksPath))[0].countedQuantity).toBeNull();
  await expect(page.getByRole('heading', { name: 'Odešlete frontu, abyste mohli pokračovat.' })).toBeVisible();
  await sendQueue.click();
  await expect(sendQueue).toContainText('(1)');
  await expect.poll(async () => (await own(tasksPath))[0]).toMatchObject({ status: 'SUBMITTED', countedQuantity: 0 });
  await expect(page.getByRole('heading', { name: 'Dokončeno', exact: true })).toBeVisible();
});

test('cycle counts isolate plans, hide the RF quantity and write only approved counts to stock', async ({ page, browser }) => {
  test.skip(process.env.WMS_LIVE_UI_WRITE !== 'true', 'Enable writes only on a disposable database.');
  test.setTimeout(60000);
  await login(page, roles.manager);
  const warehouse = '/api/warehouses/MAIN';

  const api = (path, options) => liveApi(page, path, options);

  const { accessToken: admin } = await api('/api/auth/login', {
    data: { email: roles.system.email, password: roles.system.password },
  });
  const { accessToken: worker } = await api('/api/auth/login', {
    data: { email: roles.worker.email, password: roles.worker.password },
  });
  const run = randomUUID().slice(0, 8).toUpperCase();
  async function stock(label) {
    const code = `COUNT-${label}-${run}`;
    const product = await api('/api/products', { token: admin, data: { code, name: 'Inventory browser fixture' } });
    await api('/api/products/skus', { token: admin, data: { productReference: product.id, code, name: 'Inventory browser SKU' } });
    const receipt = await api(warehouse + '/inventory/quants/receive', {
      token: admin, data: { skuReference: code, locationReference: 'A-01-01', quantity: 7 },
    });
    return { code, quantId: receipt.quant.id };
  }
  const first = await stock('A');
  const second = await stock('B');
  const otherPlan = await api(warehouse + '/cycle-counts', {
    token: admin, data: { code: `PLAN-B-${run}`, scopeType: 'SKU', scopeReference: second.code },
  });
  const code = `PLAN-A-${run}`;
  const assertQuantity = async (quantId, quantity) => {
    const quant = await api(warehouse + '/inventory/quants/' + quantId, { token: admin });
    expect(quant.quantity).toBe(quantity);
  };
  const queue = () => api(warehouse + '/rf/queue?workflow=COUNT&limit=50', { token: worker });
  const planButton = planCode => page.getByRole('row').filter({ hasText: planCode }).getByRole('button', { name: 'Vybrat' });
  const countCard = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Úkoly inventury' }) });
  const countForm = page.getByRole('form', { name: 'Počet a schválení' });
  const count = countForm.getByRole('spinbutton', { name: 'Spočtené množství' });
  const submit = countForm.getByRole('button', { name: 'Odevzdat počet' });
  const approve = countForm.getByRole('button', { name: 'Schválit rozdíl' });

  await desktopNav(page).getByRole('button', { name: 'Inventury' }).click();
  await expect(planButton(otherPlan.code)).toBeVisible();
  const create = page.getByRole('form', { name: 'Nový plán inventury' });
  const save = create.getByRole('button', { name: 'Uložit plán' });
  await expect(save).toBeDisabled();
  await create.getByLabel('Kód plánu').fill(code);
  await create.getByRole('combobox').selectOption('SKU');
  await create.getByLabel('Reference rozsahu').fill(first.code);
  await save.click();
  await expect(planButton(code)).toHaveAttribute('aria-pressed', 'true');
  const release = page.getByRole('button', { name: 'Uvolnit do úkolů' });
  const blind = page.getByRole('checkbox', { name: 'Skrýt systémové množství v RF' });
  await expect(blind).toBeChecked();
  await release.click();
  const selectTask = countCard.getByRole('button', { name: 'Vybrat' });
  await expect(selectTask).toHaveCount(1);
  expect((await queue()).tasks.find(task => task.skuCode === first.code)).toMatchObject({ quantity: null });
  await expect(count).toBeDisabled();
  await selectTask.click();
  await expect(count).toHaveValue('');
  await expect(submit).toBeDisabled();
  for (const invalid of ['-1', '1.5', '2147483648', '1e2']) {
    await count.fill(invalid);
    await expect(submit).toBeDisabled();
  }
  await count.fill('4');
  await expect(submit).toBeEnabled();
  await expect(approve).toBeDisabled();

  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const tasksUrl = `**/api/warehouses/*/cycle-counts/${otherPlan.id}/tasks`;
  await page.route(tasksUrl, async route => {
    await pending;
    await route.continue();
  }, { times: 1 });
  const switching = page.waitForRequest(request => request.url().endsWith(`/cycle-counts/${otherPlan.id}/tasks`));
  try {
    await planButton(otherPlan.code).click();
    await switching;
    await expect(selectTask).toHaveCount(0);
    await expect(count).toHaveValue('');
    await expect(submit).toBeDisabled();
    await expect(approve).toBeDisabled();
  } finally {
    resume();
  }
  await blind.uncheck();
  await release.click();
  await expect(selectTask).toHaveCount(1);
  expect((await queue()).tasks.find(task => task.skuCode === second.code)).toMatchObject({ quantity: 7 });

  await planButton(code).click();
  await selectTask.click();
  await expect(count).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await count.fill('0');
  await submit.click();
  await expect(countCard.getByText('Odevzdáno', { exact: true })).toBeVisible();
  await assertQuantity(first.quantId, 7);
  await countForm.getByLabel('Důvod / poznámka').fill('Fyzicky ověřeno');
  await approve.click();
  await expect(countCard.getByText('Schváleno', { exact: true })).toBeVisible();
  await assertQuantity(first.quantId, 0);
  await assertQuantity(second.quantId, 7);
  const movements = await api(warehouse + `/inventory/movements?type=ADJUST&quantReference=${first.quantId}`, { token: admin });
  expect(movements).toEqual([expect.objectContaining({ quantity: 7, quantityDelta: -7 })]);

  const emptyPlan = await api(warehouse + '/cycle-counts', {
    token: admin, data: { code: `ZERO-${run}`, scopeType: 'SKU', scopeReference: first.code },
  });
  await api(warehouse + `/cycle-counts/${emptyPlan.id}/release`, {
    token: admin, data: { metadata: { hideExpectedFromRf: false } },
  });
  const [zeroTask] = await api(warehouse + `/cycle-counts/${emptyPlan.id}/tasks`, { token: admin });
  expect((await queue()).tasks.find(task => task.id === zeroTask.warehouseTaskId)).toMatchObject({ quantity: 0 });
  await api(warehouse + `/cycle-counts/tasks/${zeroTask.id}/submit`, { token: admin, data: { countedQuantity: 0 } });
  await api(warehouse + `/cycle-counts/tasks/${zeroTask.id}/approve`, { token: admin, data: {} });

  const rfPlan = await api(warehouse + '/cycle-counts', {
    token: admin, data: { code: `RF-COUNT-${run}`, scopeType: 'SKU', scopeReference: first.code },
  });
  await api(warehouse + `/cycle-counts/${rfPlan.id}/release`, { token: admin, data: {} });
  const [rfTask] = await api(warehouse + `/cycle-counts/${rfPlan.id}/tasks`, { token: admin });
  const workerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await login(workerPage, roles.worker);
    await mobileNav(workerPage).getByRole('button', { name: 'Skenování', exact: true }).click();
    const taskRow = workerPage.locator(`[data-e2e-row="rf-task"][data-e2e-value="${rfTask.warehouseTaskId}"]`);
    await taskRow.click();
    const starting = workerPage.waitForResponse(response => response.url().endsWith(`/rf/tasks/${rfTask.warehouseTaskId}/start`));
    await workerPage.locator('[data-e2e-action="rf-start-resume"]').click();
    expect((await starting).ok()).toBe(true);
    const input = workerPage.getByTestId('rf-scan-input');
    const confirm = workerPage.locator('[data-e2e-action="rf-confirm-scan"]');
    const expected = workerPage.getByTestId('rf-expected-scan');
    await expect(expected).toHaveText('A-01-01');
    await workerPage.evaluate(() => window.dispatchEvent(new Event('wms:realtime')));
    await expect(taskRow).toHaveCount(0);
    await expect(expected).toHaveText('A-01-01');
    const resuming = workerPage.waitForResponse(response => /\/rf\/sessions\/[^/]+\/resume$/.test(response.url()));
    await workerPage.locator('[data-e2e-action="rf-start-resume"]').click();
    expect((await resuming).ok()).toBe(true);
    await input.fill('A-01-01');
    await confirm.click();
    await expect(expected).toHaveText(first.code);
    await expect(input).toBeFocused();
    await input.fill(first.code);
    await confirm.click();
    await expect(workerPage.locator('.rf-quantity-controls')).toBeVisible();
    await expect(input).toHaveAttribute('inputmode', 'numeric');
    await expect(input).toHaveValue('');
    await expect(expected).toHaveCount(0);
    await expect(workerPage.getByRole('button', { name: 'Použít očekávané' })).toHaveCount(0);
    await expect(confirm).toBeDisabled();
    await input.fill('2147483648');
    await expect(confirm).toBeDisabled();
    await input.fill('3');
    const completion = workerPage.waitForResponse(response =>
      response.request().method() === 'POST' && /\/rf\/sessions\/[^/]+\/scan$/.test(new URL(response.url()).pathname));
    await confirm.click();
    const response = await completion;
    const savedCount = await response.json();
    expect(response.ok(), `RF count submission returned ${response.status()} ${JSON.stringify(savedCount.error ?? savedCount.message ?? '').slice(0, 180)}`).toBe(true);
    expect((savedCount.data ?? savedCount).status).toBe('COMPLETED');
    await expect(input).toBeDisabled();
    await expect(workerPage.getByRole('heading', { name: 'Dokončeno' })).toBeVisible();
    const [submitted] = await api(warehouse + `/cycle-counts/${rfPlan.id}/tasks`, { token: admin });
    expect(submitted).toMatchObject({ status: 'SUBMITTED', countedQuantity: 3, expectedQuantity: 0, varianceQuantity: 3 });
    await assertQuantity(first.quantId, 0);
    await api(warehouse + `/cycle-counts/tasks/${submitted.id}/approve`, { token: admin, data: {} });
    await assertQuantity(first.quantId, 3);
  } finally {
    await workerPage.close();
  }
});
