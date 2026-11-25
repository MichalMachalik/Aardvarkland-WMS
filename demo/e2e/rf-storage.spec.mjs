import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';

const productUrl = process.env.PRODUCT_UI_URL ?? 'http://127.0.0.1:4000/';
const fixtureUrl = new URL('/rf-storage-fixture/', productUrl);
const moduleUrl = new URL('queue.js', fixtureUrl);
const source = await readFile(new URL('../../frontend/src/core/scanning/rfOfflineQueue.ts', import.meta.url), 'utf8');
const script = stripTypeScriptTypes(source);

for (const { storage, useFallback, disableLocks, withLegacy } of [
  { storage: 'IndexedDB' },
  { storage: 'IndexedDB without Web Locks', disableLocks: true },
  { storage: 'fallback storage', useFallback: true },
  { storage: 'fallback storage without Web Locks', useFallback: true, disableLocks: true },
  { storage: 'an existing fallback queue without Web Locks', useFallback: true, disableLocks: true, withLegacy: true },
]) {
  test(`two tabs keep offline scans and acknowledgments with ${storage}`, async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      if (useFallback) {
        await context.addInitScript(() => {
          window.fixtureIndexedDB = window.indexedDB;
          Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        });
      }
      if (disableLocks) {
        await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
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
      const scan = id => ({
        idempotencyKey: id, warehouseId: 'MAIN', scannedValue: id,
        recordedAt: '2026-01-01T00:00:00.000Z', metadata: {},
      });
      const append = (tab, id) => tab.evaluate(entry => window.queueFixture.appendRfOfflineScan('MAIN', entry), scan(id));
      const keys = (tab = first) => tab.evaluate(async () => (await window.queueFixture.loadRfOfflineQueue('MAIN'))
        .map(scan => scan.idempotencyKey).sort());
      const restoreIndexedDB = tab => tab.evaluate(() =>
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.fixtureIndexedDB }));

      const withPrimary = useFallback && disableLocks && !withLegacy;
      if (withPrimary) {
        await restoreIndexedDB(first);
        await append(first, 'confirmed-from-primary');
        await append(first, 'pending-from-primary');
        await first.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
      }
      if (withLegacy) {
        await first.evaluate(entry => localStorage.setItem('wms-rf-offline-queue-v3:MAIN', JSON.stringify([entry])), scan('legacy-scan'));
      }
      expect(await keys()).toEqual(withLegacy ? ['legacy-scan'] : []);
      await Promise.all([append(first, 'first-scan'), append(second, 'second-scan')]);
      expect(await keys()).toEqual(withLegacy ? ['first-scan', 'legacy-scan', 'second-scan'] : ['first-scan', 'second-scan']);
      const confirmed = ['first-scan'];
      if (withLegacy) confirmed.push('legacy-scan');
      if (withPrimary) confirmed.push('confirmed-from-primary');
      await Promise.all([
        second.evaluate(confirmed => window.queueFixture.applyRfOfflineResults('MAIN', confirmed), confirmed),
        append(first, 'third-scan'),
      ]);
      expect(await keys()).toEqual(['second-scan', 'third-scan']);

      if (useFallback && disableLocks) {
        // A recovered IndexedDB in one tab can coexist with another tab still
        // using the fallback. Neither should resurrect data or drop new scans.
        await restoreIndexedDB(second);
        await Promise.all([
          second.evaluate(() => window.queueFixture.applyRfOfflineResults('MAIN', ['second-scan'])),
          append(first, 'fourth-scan'),
        ]);
        await first.reload();
        await first.evaluate(async url => { window.queueFixture = await import(url); }, moduleUrl.pathname);
        expect(await keys()).toEqual(['fourth-scan', 'third-scan']);
        expect(await keys(second)).toEqual(withPrimary
          ? ['fourth-scan', 'pending-from-primary', 'third-scan']
          : ['fourth-scan', 'third-scan']);
      }
    } finally {
      await context.close();
    }
  });
}
