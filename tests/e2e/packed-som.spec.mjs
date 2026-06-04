/**
 * tests/e2e/packed-som.spec.mjs
 *
 * End-to-end check for packed Set-of-Marks (slice 1): drive the whole path —
 * MCP/HTTP → SW → collectElements + captureVisibleTab → canvas crop+pack → back —
 * against a real browser + extension, and assert a packed image plus a marks map
 * for the page's real interactive elements comes back.
 *
 * Run with: npm run test:e2e -- --grep "Packed Set-of-Marks"  (Chromium only).
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  httpPost,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

test.describe('Packed Set-of-Marks capture', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension loading requires Chromium');

  test('packs interactive elements into one image with a marks map', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const testPage = await context.newPage();
      const html = '<!doctype html><html><body>'
        + '<button id="b1">Login</button> <button id="b2">Sign Up</button> '
        + '<a id="l1" href="/x">Help</a> <input id="i1" placeholder="email">'
        + '</body></html>';
      await testPage.route('**/__packed_som__*', (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await testPage.goto(HTTP_URL + '/__packed_som__', { waitUntil: 'domcontentloaded' });

      // Discover the tab whiskor assigned (poll the session list — no push signal).
      // The test-cache can hold stale __packed_som__ sessions from earlier runs with
      // dead tabIds, so pick the most recent match (highest tabId = newest tab).
      let tabId = null;
      for (let i = 0; i < 40 && tabId == null; i++) {
        const { body } = await httpGet(page, '/api/sessions');
        const sessions = Array.isArray(body) ? body : (body && body.sessions) || [];
        const matches = sessions.filter((x) => (x.url || '').includes('__packed_som__'));
        if (matches.length) tabId = Math.max(...matches.map((s) => s.tabId));
        else await page.waitForTimeout(250);
      }
      expect(tabId, 'whiskor should register a session for the test page').not.toBeNull();

      // Let the initial collection settle so no DOM/text-coords change lands
      // between the two captures below (which would invalidate the cache). The
      // page is static, and collection is event-driven (no polling), so it goes
      // quiet quickly.
      await page.waitForTimeout(1500);

      const { status, body } = await httpPost(page, '/api/packed-som', { tabId });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      // A mark per interactive element, each with a selector + rect.
      expect(body.marks.length).toBeGreaterThan(0);
      const texts = body.marks.map((m) => m.text || '').join(' ');
      expect(texts).toMatch(/Login/);
      for (const m of body.marks) {
        expect(typeof m.n).toBe('number');
        expect(typeof m.selector).toBe('string');
        expect(typeof m.rect.w).toBe('number');
      }
      // The packed image is a real data URL (the canvas packer ran)...
      expect(body.dataUrl).toMatch(/^data:image\//);
      // ...and a real, non-empty bitmap sized to hold the crops. A blank/0-size
      // pack would mean the crop/DPR math collapsed.
      const png = pngSize(body.dataUrl);
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
      expect(png.bytes).toBeGreaterThan(100);

      // The freshness cache now lives on the worker (server/screenshot-manager),
      // so the plain HTTP path surfaces _cached — and the proxy, which forwards to
      // this same path, gets it too (the regression this guards against). A second
      // capture of the unchanged page must be served from cache.
      const second = await httpPost(page, '/api/packed-som', { tabId });
      expect(second.status).toBe(200);
      expect(second.body._cached).toBe(true);

      // Per-element thumbnail (T2): the extension downscales the crop to maxPx, and
      // a repeat reference to the unchanged element comes from the worker cache.
      const tSmall = await httpPost(page, '/api/element-thumbnail', { tabId, selector: 'body', maxPx: 48 });
      expect(tSmall.status).toBe(200);
      expect(tSmall.body.ok).toBe(true);
      expect(tSmall.body._cached).toBe(false);
      // Proof the downscale ran: a full-page 'body' crop re-encoded at 48px is tiny
      // (hundreds of bytes); a non-downscaled viewport capture would be tens of KB.
      const smallBytes = b64Bytes(tSmall.body.dataUrl);
      expect(smallBytes).toBeGreaterThan(0);
      expect(smallBytes).toBeLessThan(4000);

      // A repeat reference to the unchanged element is served from the worker cache.
      const tCached = await httpPost(page, '/api/element-thumbnail', { tabId, selector: 'body', maxPx: 48 });
      expect(tCached.body._cached).toBe(true);

      await testPage.close();
    } finally {
      await context.close();
    }
  });
});

// Read width/height from a PNG data URL without an image library (IHDR sits at a
// fixed offset after the 8-byte signature + 4-byte length + "IHDR").
function pngSize(dataUrl) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 24) return { width: 0, height: 0, bytes: buf.length };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// Approx decoded byte size of a data URL (base64 is ~4/3 of the bytes).
function b64Bytes(dataUrl) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  return Math.round(b64.length * 0.75);
}
