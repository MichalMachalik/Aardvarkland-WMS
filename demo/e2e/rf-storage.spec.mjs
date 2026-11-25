import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';

const productUrl = process.env.PRODUCT_UI_URL ?? 'http://127.0.0.1:4000/';
const fixtureUrl = new URL('/rf-storage-fixture/', productUrl);
const moduleUrl = new URL('queue.js', fixtureUrl);
const source = await readFile(new URL('../../frontend/src/core/scanning/rfOfflineQueue.ts', import.meta.url), 'utf8');
const script = stripTypeScriptTypes(source);

for (const useFallback of [false, true]) {
  test(`two tabs keep offline scans and acknowledgments with ${useFallback ? 'fallback storage' : 'IndexedDB'}`, async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      if (useFallback) {
        await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
      }
      await context.route(url => url.pathname.startsWith(fixtureUrl.pathname), route => {
        if (route.request().url() === moduleUrl.href) {
          return route.fulfill({ contentType: 'text/javascript', body: script });
        }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline scanner fixture</title>' });
      });
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const tab of [first, second]) {
        await tab.goto(fixtureUrl.href);
        await tab.evaluate(async url => { window.queueFixture = await import(url); }, moduleUrl.pathname);
      }
      if (useFallback) await first.evaluate(() => window.queueFixture.saveRfOfflineQueue('MAIN', []));

      const append = (tab, id) => tab.evaluate(idempotencyKey => window.queueFixture.appendRfOfflineScan('MAIN', {
        idempotencyKey, warehouseId: 'MAIN', scannedValue: idempotencyKey,
        recordedAt: '2026-01-01T00:00:00.000Z', metadata: {},
      }), id);
      const keys = () => first.evaluate(async () => (await window.queueFixture.loadRfOfflineQueue('MAIN'))
        .map(scan => scan.idempotencyKey).sort());

      await Promise.all([append(first, 'first-scan'), append(second, 'second-scan')]);
      expect(await keys()).toEqual(['first-scan', 'second-scan']);
      await Promise.all([
        second.evaluate(() => window.queueFixture.applyRfOfflineResults('MAIN', ['first-scan'])),
        append(first, 'third-scan'),
      ]);
      expect(await keys()).toEqual(['second-scan', 'third-scan']);
    } finally {
      await context.close();
    }
  });
}
