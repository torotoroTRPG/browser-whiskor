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
      let tabId = null;
      for (let i = 0; i < 40 && tabId == null; i++) {
        const { body } = await httpGet(page, '/api/sessions');
        const sessions = Array.isArray(body) ? body : (body && body.sessions) || [];
        const s = sessions.find((x) => (x.url || '').includes('__packed_som__'));
        if (s) tabId = s.tabId;
        else await page.waitForTimeout(250);
      }
      expect(tabId, 'whiskor should register a session for the test page').not.toBeNull();

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
      // The packed image is a real data URL (the canvas packer ran).
      expect(body.dataUrl).toMatch(/^data:image\//);

      await testPage.close();
    } finally {
      await context.close();
    }
  });
});
