/**
 * tests/e2e/injected-collection.spec.mjs
 *
 * Deep coverage for the injected MAIN-world pipeline that the (removed) hollow
 * unit tests only pretended to cover: the text-coords analyzer, the seen-text /
 * beacon tracking it feeds, and the ISOLATED-world bridge that relays page data
 * to the service worker and on to the server.
 *
 * Strategy: load a page with KNOWN text, listen on a dashboard WebSocket for the
 * TEXT_COORDS the server re-broadcasts, and assert the page's real words arrive
 * with absolute pixel coordinates. The data could not arrive at all unless the
 * analyzer → collector → bridge → SW → server chain works end to end.
 *
 * Run with: npm run test:e2e -- --grep "Injected pipeline"
 * (Requires Chromium + the e2e-extension sandbox built by global-setup.mjs.)
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  createWS,
  waitForMessage,
  closeAllWS,
  WS_URL,
} from './helpers/e2e-helpers.mjs';

test.describe('Injected pipeline — real data collection', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension loading requires Chromium');

  test('text-coords reports the page\'s actual words with absolute coordinates', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Listen as a dashboard BEFORE navigating so the broadcast isn't missed.
      const { id: wsId } = await createWS(page, WS_URL);

      await page.goto(
        'data:text/html,<html><body><h1>Whiskor Pipeline Test</h1><p>Unique marker FOOBAR123 here</p></body></html>',
        { waitUntil: 'domcontentloaded' },
      );

      // The analyzer collects on load and the server re-broadcasts to dashboards.
      const msg = await waitForMessage(page, wsId, 'TEXT_COORDS', 20000);
      const words = msg.payload?.words || [];
      expect(words.length).toBeGreaterThan(0);

      // The real page text must be present — proves the analyzer + bridge relay.
      const allText = words.map((w) => w.text || '').join(' ');
      expect(allText).toContain('FOOBAR123');

      // The marker word must carry numeric absolute coordinates (left/top/w/h).
      const marker = words.find((w) => (w.text || '').includes('FOOBAR123'));
      expect(marker).toBeTruthy();
      for (const f of ['left', 'top', 'width', 'height']) {
        expect(typeof marker[f]).toBe('number');
      }

      await closeAllWS(page);
    } finally {
      await context.close();
    }
  });

  test('re-collecting a stable page keeps reporting the same text (beacon/seen-text)', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);
      const { id: wsId } = await createWS(page, WS_URL);

      await page.goto(
        'data:text/html,<html><body><p>Persistent BEACONWORD content</p></body></html>',
        { waitUntil: 'domcontentloaded' },
      );

      const first = await waitForMessage(page, wsId, 'TEXT_COORDS', 20000);
      expect(first.payload?.words?.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);

      // A small interaction nudges re-collection; the stable text must persist.
      await page.mouse.move(10, 10);
      await page.waitForTimeout(1500);

      const second = await waitForMessage(page, wsId, 'TEXT_COORDS', 20000);
      expect(second.payload?.words?.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);

      await closeAllWS(page);
    } finally {
      await context.close();
    }
  });
});
