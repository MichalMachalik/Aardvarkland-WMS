import { expect, test } from '@playwright/test';

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

test('phone navigation groups secondary pages and restores focus on Escape', async ({ page }) => {
  await login(page, roles.worker);
  await page.setViewportSize({ width: 320, height: 750 });
  const nav = mobileNav(page);
  await expect(nav.getByRole('button', { name: 'Skenování' })).toBeVisible();
  const more = nav.getByRole('button', { name: 'Další' });
  await more.click();
  const support = nav.getByRole('region', { name: 'PODPORA' });
  await expect(support.getByRole('button', { name: 'Zásoby' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(support).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await support.getByRole('button', { name: 'Zásoby' }).click();
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

test('worker deep links to restricted pages return to the scanner', async ({ page }) => {
  await login(page, roles.worker);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page).toHaveURL(/#\/rf$/);
  await expect(page.locator('.content').getByRole('heading', { name: 'RF skener' })).toBeVisible();
  await expect(desktopNav(page).getByRole('button', { name: 'Nastavení' })).toHaveCount(0);
});
