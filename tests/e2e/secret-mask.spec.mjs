/**
 * tests/e2e/secret-mask.spec.mjs
 *
 * End-to-end check that the secret guard masks redacted regions in screenshots
 * taken over the HTTP path (the path the proxy also forwards through — masking
 * used to be computed only in the MCP tool and was dead there). The server runs
 * with the secret guard enabled (playwright.config webServer); the email pattern
 * catches the test secret. We capture a screenshot and confirm, by decoding it in
 * the browser, that the secret's box is blacked out while a non-secret box is not.
 *
 * Run with: npm run test:e2e -- --grep "secret"  (Chromium, headed).
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  httpPost,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

const SECRET = 'whiskor-e2e-secret-7f3a2b@example.test'; // matches the email pattern

test.describe('Secret guard screenshot masking', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension loading requires Chromium');

  test('blacks out a redacted region but leaves public content visible', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // The guard must be active for this to be a real test.
      const health = await httpGet(page, '/health');
      expect(health.body.secretGuard.active, 'secret guard must be enabled for the webServer').toBe(true);

      const testPage = await context.newPage();
      // Two yellow boxes: the secret (an email → redacted) and a public string.
      // Masked → solid black; unmasked → yellow with black glyphs.
      const html = '<!doctype html><html><body style="margin:0;background:#fff">'
        + `<span id="secret" style="position:absolute;left:24px;top:80px;background:#ffcc00;color:#000;font:20px monospace">${SECRET}</span>`
        + '<span id="public" style="position:absolute;left:24px;top:220px;background:#ffcc00;color:#000;font:20px monospace">public-info-visible</span>'
        + '</body></html>';
      await testPage.route('**/__secret_mask__*', (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await testPage.goto(HTTP_URL + '/__secret_mask__', { waitUntil: 'domcontentloaded' });

      // Discover the tab (newest match — the test-cache can hold stale sessions).
      let tabId = null;
      for (let i = 0; i < 40 && tabId == null; i++) {
        const { body } = await httpGet(page, '/api/sessions');
        const sessions = Array.isArray(body) ? body : (body && body.sessions) || [];
        const matches = sessions.filter((x) => (x.url || '').includes('__secret_mask__'));
        if (matches.length) tabId = Math.max(...matches.map((s) => s.tabId));
        else await page.waitForTimeout(250);
      }
      expect(tabId, 'whiskor should register a session for the test page').not.toBeNull();

      // Let text-coords collect + redact so the server knows the secret's box.
      await page.waitForTimeout(2500);

      const shot = await httpPost(page, '/api/screenshot', { tabId });
      expect(shot.status).toBe(200);
      expect(shot.body.ok).toBe(true);
      expect(shot.body.dataUrl).toMatch(/^data:image\//);

      // Decode the screenshot in the browser and measure how "dark" each box is.
      const sample = await testPage.evaluate(async (dataUrl) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        const darkFrac = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          let dark = 0, n = 0;
          for (let dy = 0.3; dy <= 0.7; dy += 0.2) {            // a few rows
            const y = Math.round((r.top + r.height * dy) * dpr);
            for (let x = Math.round((r.left + 2) * dpr); x < Math.round((r.left + r.width - 2) * dpr); x++) {
              const d = ctx.getImageData(x, y, 1, 1).data;
              n++; if (d[0] + d[1] + d[2] < 120) dark++;
            }
          }
          return n ? dark / n : 0;
        };
        return { secret: darkFrac('secret'), pub: darkFrac('public') };
      }, shot.body.dataUrl);

      // The secret box is fully blacked out; the public yellow box is not.
      expect(sample.secret).toBeGreaterThan(0.9);
      expect(sample.pub).toBeLessThan(0.5);

      await testPage.close();
    } finally {
      await context.close();
    }
  });
});
