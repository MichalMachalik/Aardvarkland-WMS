import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const baseUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const screenshotDir = 'artifacts/ui';

test.beforeAll(() => mkdirSync(screenshotDir, { recursive: true }));
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('the order guide works with keyboard navigation in both languages and themes', async ({ page }) => {
  const url = new URL('database-schema.html', baseUrl);
  const modelLists = [
    ['OutboundOrder', 'OutboundOrderLine'],
    ['OutboundOrderLine', 'PackageContent', 'ShipmentPackage'],
    ['ShipmentPackage', 'Shipment'],
  ];
  await page.goto(url.href);
  const guide = page.locator('#order-guide');
  const steps = guide.getByRole('button');
  const titles = {
    en: ['Pick the items', 'Pack the order', 'Hand the shipment to the carrier'],
    cs: ['Vychystání zboží', 'Zabalení objednávky', 'Předání dopravci'],
  };
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const locale of ['en', 'cs']) {
      if (await page.locator('html').getAttribute('lang') !== locale) {
        await page.locator('[data-language-toggle]').click();
      }
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) {
          await page.locator('[data-theme-toggle]').click();
        }
        await expect(guide).toBeVisible();
        for (const [index, models] of modelLists.entries()) {
          await steps.nth(index).press('Enter');
          await expect(steps.nth(index)).toBeFocused();
          await expect(steps.nth(index)).toHaveAttribute('aria-pressed', 'true');
          await expect(guide.getByRole('heading')).toHaveText(titles[locale][index]);
          await expect(guide.locator('code')).toHaveText(models);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        }
        await expect(page.locator('#guide-demo-link')).toHaveAttribute('href', `./?walkthrough=order&lang=${locale}`);
      }
    }
  }
  await page.locator('#guide-demo-link').click();
  await expect(page).toHaveURL(/walkthrough=order&lang=cs/);
  await expect(page.getByText('DEMO-1042', { exact: true }).first()).toBeVisible();
});

test('guide cards match the schema and open the interactive database diagram', async ({ page, request }) => {
  const url = new URL('database-schema.html', baseUrl);
  const schemaResponse = await request.get(new URL('database-schema.json', url).href);
  expect(schemaResponse.ok()).toBe(true);
  const schema = await schemaResponse.json();
  const model = (name) => schema.models.find((entry) => entry.name === name);
  expect(model('OutboundOrderLine').links).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'OutboundOrder', declared: true })]));
  expect(model('PackageContent').links).toEqual(expect.arrayContaining([
    expect.objectContaining({ target: 'OutboundOrderLine', declared: false }),
    expect.objectContaining({ target: 'ShipmentPackage', declared: false }),
  ]));
  expect(model('ShipmentPackage').links).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'Shipment', declared: false })]));

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(url.href);
  await expect(page.locator('#loading')).toHaveAttribute('hidden', '');
  await page.getByRole('button', { name: '2. Packing' }).click();
  await page.getByRole('link', { name: 'Explore Parcel contents in the database diagram' }).press('Enter');
  await expect(page.locator('.table-node.is-root')).toHaveAttribute('data-model', 'PackageContent');
  await page.getByRole('button', { name: 'Follow an order' }).click();
  await expect(page.locator('#guide-step-title')).toHaveText('Pack the order');
  await page.getByRole('button', { name: 'Explore the database' }).click();
  await page.getByRole('button', { name: 'Show overview' }).click();
  await page.locator('#group-filter').selectOption('Fulfillment');
  const packageNode = page.locator('.table-node[data-model="PackageContent"]');
  const orderLineEdge = page.locator('.edge-group[data-source="OutboundOrderLine"][data-target="PackageContent"]');
  await packageNode.hover();
  await expect(packageNode).toHaveClass(/is-hovered/);
  await expect(orderLineEdge).toHaveClass(/is-logical/);
  await expect(orderLineEdge).toHaveClass(/is-focused/);
  await expect(page.locator('.edge-group.is-focused')).toHaveCount(2);
  await page.getByRole('button', { name: 'Explore the database' }).hover();
  await expect(page.locator('.edge-group.is-focused')).toHaveCount(0);

  url.searchParams.set('table', 'ShipmentPackage');
  await page.goto(url.href);
  await expect(page.locator('#order-guide')).toBeHidden();
  await expect(page.locator('.table-node.is-root')).toHaveAttribute('data-model', 'ShipmentPackage');
});

async function signIn(page, role = 'worker') {
  await page.locator('#demo-login-name').selectOption(role);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#demo-login')).toBeHidden();
}

test('cycle counting releases blind work and updates stock only after approval', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(baseUrl);
  await signIn(page, 'manager');
  await page.getByRole('button', { name: /Cycle counts/ }).first().click();
  const create = page.locator('[data-cycle-form="create"]');
  await create.getByLabel('Plan code').fill('DEMO-COUNT-91');
  await create.getByLabel('Scope reference').fill('A-01-03');
  await create.getByRole('button', { name: 'Create plan' }).click();
  const plan = page.locator('[data-cycle-plan-status]');
  await expect(plan).toHaveText('DEMO-COUNT-91 · Draft');
  await page.getByLabel('Blind count').check();
  await page.getByRole('button', { name: 'Release plan' }).click();
  const task = page.getByRole('row', { name: /SKU-1024/ });
  await expect(task.getByRole('cell').nth(2)).toHaveText('–');
  const count = page.getByRole('textbox', { name: 'Counted quantity' });
  await count.fill('-2');
  await page.getByRole('button', { name: 'Submit count' }).click();
  await expect(plan).toHaveText('DEMO-COUNT-91 · Released');
  await count.fill('39');
  await page.getByRole('button', { name: 'Submit count' }).click();
  await expect(task.getByRole('cell').nth(2)).toHaveText('42');
  await expect(task.getByRole('cell').nth(4)).toHaveText('-3');
  await page.getByRole('button', { name: 'Approve task' }).click();
  await expect(plan).toHaveText('DEMO-COUNT-91 · Approved');
  await expect(page.getByRole('button', { name: 'Approve task' })).toBeDisabled();
  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await expect(page.getByRole('row', { name: /SKU-1024/ }).getByRole('cell').nth(3)).toHaveText('39');
});

async function assertSourceLoginGeometry(page) {
  const card = page.locator('.login-card');
  const visual = page.locator('.login-card__visual');
  const form = page.locator('.login-form');
  const logo = page.locator('.login-logo--image img');

  await expect(card).toBeVisible();
  await expect(card).toHaveCSS('display', 'grid');
  await expect(card).toHaveCSS('border-radius', '12px');
  await expect(card).toHaveCSS('min-height', '620px');

  const cardBox = await card.boundingBox();
  const visualBox = await visual.boundingBox();
  const formBox = await form.boundingBox();
  const logoBox = await logo.boundingBox();

  expect(Math.round(cardBox?.width ?? 0)).toBe(1000);
  expect(Math.round(cardBox?.height ?? 0)).toBeGreaterThanOrEqual(620);
  expect(Math.round(logoBox?.width ?? 0)).toBe(98);
  expect(Math.round(logoBox?.height ?? 0)).toBe(98);
  expect(Math.abs((visualBox?.width ?? 0) / (formBox?.width ?? 1) - (1 / 0.95))).toBeLessThan(0.03);

  await expect(page.locator('.login-brand__name')).toHaveText('Aardvarkland');
  await expect(page.locator('.login-brand__tagline')).toHaveText('warehouse management system');
  await expect(page.locator('#demo-login-name option')).toHaveCount(3);
  await expect(page.locator('#demo-password')).toHaveAttribute('type', 'password');
  await expect(page.locator('#demo-password')).toHaveValue('demo');
  await expect(page.locator('#demo-language-toggle .flag-icon svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#demo-theme-toggle svg')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mobile preview' })).toHaveAttribute('href', './mobile-preview.html');
}

async function assertDesktopShellParity(page, accountName, sectionLabels) {
  await expect(page.locator('.legacy-brand')).toBeHidden();
  await expect(page.locator('.legacy-role-switch')).toBeHidden();
  await expect(page.locator('.sidebar__account')).toBeVisible();
  await expect(page.locator('.sidebar__account')).toContainText(accountName);
  await expect(page.locator('.topbar-brand')).toBeVisible();
  await expect(page.locator('.topbar-brand__copy strong')).toHaveText('Aardvarkland WMS');
  await expect(page.locator('.parity-route-meta')).toBeHidden();
  await expect(page.locator('.parity-sync-control')).toBeHidden();
  await expect(page.locator('.nav__section')).toHaveCount(sectionLabels.length);
  for (const label of sectionLabels) {
    await expect(page.locator('.nav__section-label').filter({ hasText: label })).toBeVisible();
  }
  await expect(page.locator('.nav__item').first()).toBeVisible();
  await expect(page.locator('.nav__item .nav__icon').first()).toBeVisible();
  await expect(page.locator('.mobile-tabbar')).toBeHidden();

  const shellColumns = await page.locator('.shell').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(shellColumns.split(' ').map((value) => Math.round(Number.parseFloat(value)))[0]).toBe(288);
  await expect(page.locator('.content')).toHaveCSS('padding-left', '32px');
  await expect(page.locator('.app-status-strip')).toHaveCSS('border-radius', '6px');
}

test('desktop login and all role shells match the Server source structure', async ({ browser }) => {
  test.setTimeout(60_000);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle(/Aardvarkland WMS Product Preview/);
  await assertSourceLoginGeometry(page);
  await page.screenshot({ path: `${screenshotDir}/01-server-source-login.png`, fullPage: true });

  await signIn(page, 'admin');
  await expect(page.locator('[data-role="admin"]')).toHaveClass(/is-active/);
  await assertDesktopShellParity(page, 'System admin', ['SYSTEM', 'CONNECTIONS']);
  await expect(page.locator('#view-root')).not.toBeEmpty();
  await page.screenshot({ path: `${screenshotDir}/02-server-source-admin.png`, fullPage: true });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#demo-login')).toBeVisible();
  await signIn(page, 'manager');
  await expect(page.locator('[data-role="manager"]')).toHaveClass(/is-active/);
  await assertDesktopShellParity(page, 'Warehouse manager', ['OPERATIONS', 'WAREHOUSE', 'SUPPORT']);
  await page.screenshot({ path: `${screenshotDir}/03-server-source-manager.png`, fullPage: true });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'worker');
  await expect(page.locator('[data-role="worker"]')).toHaveClass(/is-active/);
  await assertDesktopShellParity(page, 'Warehouse worker', ['WORK', 'SUPPORT']);
  await expect(page.locator('[data-lang="en"]')).toHaveClass(/is-active/);
  await expect(page.locator('#api-status')).toHaveText('API ready');
  await page.screenshot({ path: `${screenshotDir}/04-server-source-worker.png`, fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('admin can create a demo user and requeue a failed integration', async ({ page }) => {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await signIn(page, 'admin');

  const settings = page.locator('#demo-user-form');
  await settings.getByLabel('Name', { exact: true }).fill('Demo Tester');
  await settings.getByLabel('Login name').fill('demo-tester');
  await settings.getByLabel('Role').selectOption('manager');
  await settings.getByRole('button', { name: 'Create user' }).click();
  const user = page.getByRole('row', { name: /Demo Tester/ });
  await expect(user).toContainText('Warehouse manager');
  await expect(user).toContainText('demo-tester');

  await settings.getByLabel('Name', { exact: true }).fill('Duplicate Tester');
  await settings.getByLabel('Login name').fill('DEMO-TESTER');
  await settings.getByRole('button', { name: 'Create user' }).click();
  await expect(settings.getByRole('status')).toContainText('already exists');
  await expect(page.getByRole('row', { name: /Duplicate Tester/ })).toHaveCount(0);

  await page.locator('#nav-list [data-view="integrations"]').click();
  const integration = page.getByRole('row', { name: /ERP export/ });
  const replay = page.getByRole('button', { name: 'Replay', exact: true });
  await expect(integration).toContainText('Retry');
  await replay.click();
  await expect(integration).toContainText('Queued');
  await expect(replay).toBeDisabled();
  await page.locator('#nav-list [data-view="settings"]').click();
  await expect(user).toBeVisible();
});

test('the RF form resolves a code entered with the keyboard or submit button', async ({ page }) => {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await signIn(page, 'worker');
  await page.getByText('Standalone code lookup', { exact: true }).click();

  const code = page.locator('#scan-input');
  const result = page.locator('.scan-result');
  await code.fill('AARD1:TASK:TASK-88');
  await code.press('Enter');
  await expect(result).toContainText('TASK-88');
  await expect(result).toContainText('Code resolved');

  await code.fill('DEMO-UNRECOGNIZED');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(result).toContainText('DEMO-UNRECOGNIZED');
  await expect(result).toContainText('Code waiting for manual review');
});

test('guided RF picking validates each step, restores the offline queue and updates stock once', async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator('.shell')).toHaveJSProperty('inert', true);
  await signIn(page, 'worker');
  await expect(page.locator('.shell')).toHaveJSProperty('inert', false);
  await page.getByRole('button', { name: 'Go offline' }).click();

  const scanner = page.locator('#pick-input');
  await scanner.fill('WRONG-TASK');
  await scanner.press('Enter');
  await expect(page.locator('#pick-feedback')).toContainText('does not match');
  await expect(scanner).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('[aria-current="step"]')).toContainText('Scan the task');
  const steps = ['Scan the task', 'Confirm the source location', 'Scan the product', 'Enter the quantity', 'Confirm the destination'];
  for (const step of steps) {
    await expect(page.locator('[aria-current="step"]')).toContainText(step);
    await page.getByRole('button', { name: 'Use sample code' }).click();
    await expect(scanner).toBeFocused();
    await expect(scanner).not.toHaveAttribute('aria-invalid');
    await scanner.press('Enter');
  }

  const send = page.getByRole('button', { name: 'Send queue (1)', exact: true });
  await expect(send).toBeDisabled();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('discard the unsent task');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Run demo again' }).click();
  await expect(send).toBeDisabled();
  await page.reload();
  await signIn(page, 'worker');
  await expect(send).toBeDisabled();
  const nav = page.locator('#nav-list');
  await nav.locator('[data-view="inventory"]').click();
  const stock = page.getByRole('row', { name: /SKU-2048/ }).getByRole('cell').nth(3);
  await expect(stock).toHaveText('148');
  await nav.locator('[data-view="rf"]').click();
  await page.getByRole('button', { name: 'Go online' }).click();
  await send.click();
  await expect(page.getByRole('button', { name: 'Send queue (0)', exact: true })).toBeDisabled();
  await nav.locator('[data-view="tasks"]').click();
  await expect(page.getByRole('row', { name: /TASK-88/ })).toContainText('Completed');
  await nav.locator('[data-view="inventory"]').click();
  await expect(stock).toHaveText('144');
  const stockSearch = page.getByRole('searchbox', { name: 'Search by SKU, product or location' });
  await stockSearch.fill('ret-01');
  await expect(page.getByRole('row', { name: /SKU-8801/ })).toBeVisible();
  await expect(stock).toHaveCount(0);
  await expect(stockSearch).toBeFocused();
  await stockSearch.fill('unknown-location');
  await expect(page.getByText('No items', { exact: true })).toBeVisible();
  await stockSearch.clear();
  await expect(stock).toHaveText('144');
});

test('the same demo print queue drives packing, printer rows and the status strip', async ({ page }) => {
  await page.goto(baseUrl);
  await signIn(page, 'worker');
  const nav = page.locator('#nav-list');
  await expect(page.locator('#print-status')).toHaveText('2 print jobs waiting');
  await nav.locator('[data-view="packing"]').click();
  const print = page.getByRole('button', { name: 'Print next' });
  await print.click();
  await expect(page.getByRole('row', { name: /SHIP-2026-0421/ })).toContainText('Printed');
  await expect(page.locator('#print-status')).toHaveText('1 print job waiting');
  await nav.locator('[data-view="print-stations"]').click();
  await expect(page.getByRole('row', { name: /JOB-7101/ })).toContainText('Printed');
  await print.click();
  await expect(page.getByRole('row', { name: /JOB-7102/ })).toContainText('Printed');
  await expect(page.locator('#print-status')).toHaveText('Print queue empty');
  await expect(print).toBeDisabled();
});

test('the sample order validates picking, packing and handoff, and resumes after refresh', async ({ page }) => {
  const requests = [];
  const pageErrors = [];
  page.on('request', (request) => requests.push(request));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole('link', { name: 'Try a sample order' }).click();
  await expect(page).toHaveURL(/walkthrough=order/);
  await expect(page.getByRole('heading', { name: 'Order walkthrough' })).toBeVisible();
  await expect(page.locator('#demo-login')).toBeHidden();
  await expect(page.getByText('DEMO-1042', { exact: true })).toBeVisible();

  const stages = page.getByRole('list', { name: 'Order walkthrough' });
  const picking = page.locator('.rf-guide');
  const pickInput = picking.getByRole('textbox', { name: 'Code or quantity' });
  const orderDetails = page.locator('.order-details');
  const stock = orderDetails.locator('.order-locations > div').filter({ hasText: 'Units at pick location' }).locator('dd');
  await expect(stock).toHaveText('148');
  await expect(stages.getByRole('button', { name: 'Packing' })).toBeDisabled();
  await expect(stages.getByRole('button', { name: 'Dispatch' })).toBeDisabled();

  await pickInput.fill('WRONG-TASK');
  await pickInput.press('Enter');
  await expect(pickInput).toHaveAttribute('aria-invalid', 'true');
  await picking.getByRole('button', { name: 'Simulate scan' }).click();
  await page.reload();
  await expect(picking.locator('[aria-current="step"]')).toHaveText(/Confirm the source location/);
  await picking.getByRole('button', { name: 'Simulate scan' }).click();
  await picking.getByRole('button', { name: 'Simulate scan' }).click();
  await picking.getByRole('button', { name: 'Use expected quantity' }).click();
  await picking.getByRole('button', { name: 'Simulate scan' }).click();
  await expect(stock).toHaveText('144');
  await picking.getByRole('button', { name: 'Continue to packing' }).click();

  const quantity = page.getByRole('textbox', { name: 'Units in parcel' });
  await quantity.fill('3');
  await page.getByRole('button', { name: 'Seal parcel' }).click();
  await expect(quantity).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'packed quantity' })).toBeVisible();
  await expect(stages.getByRole('button', { name: 'Dispatch' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Sample shipping label' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Use expected quantity' }).click();
  await expect(quantity).toHaveValue('4');
  await page.getByRole('button', { name: 'Seal parcel' }).click();
  await expect(orderDetails.locator('.order-label')).toContainText('DEMO-PARCEL-1042');
  await expect(page.getByRole('button', { name: 'Continue to dispatch' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dispatch the parcel' })).toBeVisible();

  const parcel = page.getByRole('textbox', { name: 'Parcel code' });
  await parcel.fill('DEMO-PARCEL-OTHER');
  await parcel.press('Enter');
  await expect(parcel).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'does not match the parcel label' })).toBeVisible();
  await page.getByRole('button', { name: 'Use label code' }).click();
  await page.getByRole('button', { name: 'Confirm handoff' }).click();
  await expect(page.getByRole('heading', { name: 'Order dispatched' })).toBeVisible();
  await expect(stages.getByRole('button', { name: /Dispatch.*Complete/ })).toBeVisible();
  await expect(stock).toHaveText('144');
  await page.screenshot({ path: `${screenshotDir}/10-order-dispatched-desktop.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Order dispatched' })).toBeVisible();

  await page.getByRole('link', { name: 'Full WMS preview' }).click();
  await signIn(page, 'worker');
  await expect(page.locator('.rf-guide [aria-current="step"]')).toHaveText(/Scan the task/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Order dispatched' })).toBeVisible();
  await page.getByRole('button', { name: 'Restart walkthrough' }).click();
  await expect(picking.locator('[aria-current="step"]')).toHaveText(/Scan the task/);
  await expect(stock).toHaveText('148');
  await expect(stages.getByRole('button', { name: 'Dispatch' })).toBeDisabled();
  expect(pageErrors).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET' || new URL(request.url()).origin !== new URL(baseUrl).origin)).toEqual([]);
});

test('the direct order walkthrough link works on a narrow touch screen in Czech', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  await page.goto(new URL('?walkthrough=order&lang=cs', baseUrl).href);
  await expect(page.getByRole('heading', { name: 'Průchod objednávkou' })).toBeVisible();
  await expect(page.locator('#demo-login')).toBeHidden();
  await expect(page.locator('#mobile-tabbar')).toBeHidden();
  const assertContentFits = async () => {
    expect(await page.locator('.content').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  };
  await assertContentFits();
  await page.screenshot({ path: `${screenshotDir}/11-order-picking-mobile.png`, fullPage: true });
  const simulateScan = page.locator('#pick-form [name="sample"]');
  for (let step = 0; step < 5; step += 1) await simulateScan.tap();
  await page.getByRole('button', { name: 'Pokračovat k balení' }).tap();
  await assertContentFits();
  await page.getByRole('button', { name: 'Použít očekávané množství' }).tap();
  await page.getByRole('button', { name: 'Uzavřít balík' }).tap();
  await page.getByRole('button', { name: 'Pokračovat k expedici' }).tap();
  await assertContentFits();
  await page.getByRole('button', { name: 'Použít kód ze štítku' }).tap();
  await page.getByRole('button', { name: 'Potvrdit předání' }).tap();
  await expect(page.getByRole('heading', { name: 'Objednávka vyexpedována' })).toBeVisible();
});

test('localized mobile navigation dismisses More and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl);
  await page.locator('#demo-language-toggle').click();
  await page.locator('[data-login-language="cs"]').click();
  await page.locator('#demo-login-submit').click();

  const navigation = page.getByRole('navigation', { name: 'Mobilní navigace' });
  const more = navigation.getByRole('button', { name: 'Další' });
  await more.click();
  const close = navigation.getByRole('button', { name: 'Zavřít nabídku' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  await close.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await expect(more).not.toHaveClass(/is-active/);
});

test('mobile shell uses the five-slot tabbar with a More drawer', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('#demo-login')).toBeVisible();
  await expect(page.locator('.login-card')).toHaveCSS('grid-template-columns', /.+/);
  await page.screenshot({ path: `${screenshotDir}/05-server-mobile-login.png` });

  await signIn(page, 'worker');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.mobile-tabbar')).toBeVisible();
  await expect(page.locator('.mobile-tabbar > .mobile-tabbar__button')).toHaveCount(5, { timeout: 15_000 });
  const confirm = await page.getByRole('button', { name: 'Confirm scan' }).boundingBox();
  const sample = await page.getByRole('button', { name: 'Use sample code' }).boundingBox();
  const tabbar = await page.locator('.mobile-tabbar').boundingBox();
  expect(Math.max(confirm.y + confirm.height, sample.y + sample.height)).toBeLessThan(tabbar.y);
  await expect(page.locator('.mobile-tabbar__more-toggle')).toContainText('More');
  await expect(page.locator('#view-root')).not.toBeEmpty();
  await page.screenshot({ path: `${screenshotDir}/06-server-mobile-worker.png` });

  await page.locator('.mobile-tabbar__more-toggle').click();
  await expect(page.locator('.mobile-tabbar__more')).toBeVisible();
  await expect(page.locator('.mobile-tabbar__more .mobile-tabbar__button')).toHaveCount(3);
  await page.screenshot({ path: `${screenshotDir}/07-server-mobile-more.png` });

  await page.locator('#mobile-tabbar [data-view="inventory"]').click();
  await expect(page.locator('.mobile-tabbar__more')).toBeHidden();
  const inventoryContent = page.locator('.workspace > .content');
  await expect(inventoryContent).toHaveCSS('overflow-y', 'auto');
  const contentBox = await inventoryContent.boundingBox();
  expect(contentBox.y + contentBox.height).toBeLessThan(tabbar.y);
  const stockSearch = page.getByRole('searchbox', { name: 'Search by SKU, product or location' });
  await stockSearch.click();
  await stockSearch.fill('RET-01');
  await expect(page.getByRole('row', { name: /SKU-8801/ })).toBeVisible();
  const searchBox = await stockSearch.boundingBox();
  expect(searchBox.y + searchBox.height).toBeLessThan(tabbar.y);
  expect((await page.locator('#mobile-tabbar').boundingBox()).y).toBe(tabbar.y);
  const tableScroller = page.locator('#inventory-results .table-wrap');
  expect(await tableScroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await tableScroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const tableBox = await tableScroller.boundingBox();
  const statusBox = await tableScroller.locator('thead th').last().boundingBox();
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width);
  await tableScroller.evaluate(element => { element.scrollLeft = 0; });
  await page.screenshot({ path: `${screenshotDir}/08-server-mobile-inventory.png` });

  expect(pageErrors).toEqual([]);
});

test('dedicated 411x868 phone frame remains available and runs the same source-parity UI', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}mobile-preview.html`, { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle(/mobile preview/);
  await expect(page.getByText('Mobile preview')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open standalone' })).toBeVisible();

  const phoneBox = await page.locator('.phone').boundingBox();
  expect(Math.round(phoneBox?.width ?? 0)).toBe(411);
  expect(Math.round(phoneBox?.height ?? 0)).toBe(868);

  const app = page.frameLocator('iframe[title="Aardvarkland WMS mobile preview"]');
  await expect(app.locator('#demo-login')).toBeVisible({ timeout: 15_000 });
  await expect(app.locator('#demo-mobile-link')).toBeHidden();
  await app.locator('#demo-login-name').selectOption('manager');
  await app.getByRole('button', { name: 'Sign in' }).click();
  await expect(app.locator('[data-role="manager"]')).toHaveClass(/is-active/, { timeout: 15_000 });
  await expect(app.locator('.mobile-tabbar')).toBeVisible();
  await expect(app.locator('#view-root')).not.toBeEmpty();
  await page.screenshot({ path: `${screenshotDir}/08-server-phone-frame-manager.png`, fullPage: true });

  expect(pageErrors).toEqual([]);
});
