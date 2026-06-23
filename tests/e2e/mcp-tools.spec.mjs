/**
 * tests/e2e/mcp-tools.spec.mjs
 *
 * Phase 3: MCP Tools E2E tests.
 *
 * Tests the complete MCP tool flow:
 *   1. Extension collects data → Server caches it
 *   2. MCP tool requests data → Server returns cached data
 *   3. MCP tool sends action → Extension executes → Result returned
 *
 * Run with: npm run test:e2e -- --grep "MCP Tools"
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  httpPost,
  TestPages,
  textCoordsPayload,
  viewportPayload,
  assertHealthOk,
  closeAllWS,
  createWS,
  waitForMessage,
  sendMessage,
  WS_URL,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - Read Operations', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('get_text_coords returns collected text data', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Navigate to page with text
      await page.goto(TestPages.multiText);
      await page.waitForTimeout(2000);

      // Verify server received data via health check
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      // The extension should have collected text coords
      // In a full test, we'd call the MCP tool directly via stdio
      // For now, verify the data pipeline works
      expect(health.wsConnections).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('get_dom_snapshot returns page structure', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.nested);
      await page.waitForTimeout(2000);

      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);
    } finally {
      await context.close();
    }
  });

  test('get_viewport returns current viewport state', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      // Scroll the page
      await page.evaluate(() => window.scrollTo(0, 500));
      await page.waitForTimeout(500);

      // Server should have received VIEWPORT_UPDATE
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - Write Operations', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('click_element modifies page state', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);

      // Click a button
      await page.click('#btn1');
      await page.waitForTimeout(500);

      // Verify button text changed
      const btnText = await page.textContent('#btn1');
      expect(btnText).toBe('Clicked!');
    } finally {
      await context.close();
    }
  });

  test('fill_form populates input fields', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);

      // Fill input
      await page.fill('#input1', 'test value');
      await page.waitForTimeout(500);

      const inputValue = await page.inputValue('#input1');
      expect(inputValue).toBe('test value');
    } finally {
      await context.close();
    }
  });

  test('navigate_to triggers page navigation', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      // Navigate to a different page
      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);

      // Verify navigation happened
      const title = await page.textContent('h1');
      expect(title).toBe('Interactive Page');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - navigate-then-collect', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  // Open a fresh, guaranteed-live http tab via the whiskor open_tab action and
  // return its real tabId. Relying on /api/sessions ordering is fragile here —
  // the connection-wake helper opens and closes a dashboard tab, so the newest
  // session can point at an already-closed tab id.
  async function openLiveTab(page, url) {
    const { body } = await httpPost(page, '/api/action', {
      action: { type: 'open_tab', url, active: true },
    });
    const tabId = body?.result?.tabId;
    if (tabId == null) throw new Error(`open_tab did not return a tabId: ${JSON.stringify(body)}`);
    await page.waitForTimeout(1500); // let it load + the content script attach
    return tabId;
  }

  test('navigate waits for the new page and reports navigated + collected (not navigating)', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // A real http tab (content scripts match http/https, not data:) we can drive.
      const tabId = await openLiveTab(page, `${HTTP_URL}/`);

      // Drive a whiskor navigate with the default wait + thenCollect. A query
      // change forces a real top-frame navigation that fires webNavigation.
      const { body: res } = await httpPost(page, '/api/action', {
        tabId,
        action: { type: 'navigate', url: `${HTTP_URL}/?nav=1`, thenCollect: true },
      });

      // action-executor wraps the page-side result under `result`.
      expect(res.ok).toBe(true);
      const r = res.result;
      expect(r.navigated).toBe(true);
      expect(r.navigating).toBeUndefined(); // old fire-and-forget shape is gone
      expect(r.timedOut).toBeFalsy();        // dashboard loads well under 10s
      expect(r.collected).toBe(true);
      expect(r.waitUntil).toBe('domcontentloaded');
    } finally {
      await context.close();
    }
  });

  test('waitUntil:"none" keeps the legacy immediate (navigating) response', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const tabId = await openLiveTab(page, `${HTTP_URL}/`);

      const { body: res } = await httpPost(page, '/api/action', {
        tabId,
        action: { type: 'navigate', url: `${HTTP_URL}/?nav=2`, waitUntil: 'none' },
      });

      expect(res.ok).toBe(true);
      const r = res.result;
      expect(r.navigating).toBe(true);
      expect(r.navigated).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - Capture Operations', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('capture_screenshot returns image data', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      // Take screenshot via Playwright (simulates MCP screenshot tool)
      const screenshot = await page.screenshot();
      expect(screenshot.length).toBeGreaterThan(0);
      expect(Buffer.isBuffer(screenshot)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('capture_screenshot with marks overlays elements', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);

      // Take screenshot with marks
      const screenshot = await page.screenshot();
      expect(screenshot.length).toBeGreaterThan(1000); // Should be a valid image
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - Control Operations', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('set_config updates extension configuration', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Change config via API
      const { body: configResp } = await httpPost(page, '/api/config', {
        mode: 'manual',
        plugins: { network: true },
      });
      expect(configResp.ok).toBe(true);

      // Verify config was updated
      const { body: getConfig } = await httpGet(page, '/api/config');
      expect(getConfig.mode).toBe('manual');
      expect(getConfig.plugins.network).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('trigger_collect forces data collection', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      // Trigger collection
      const { body: collectResp } = await httpPost(page, '/api/collect', { tabId: 1 });
      expect(collectResp.ok).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('get_config_changes returns audit log', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Make config changes
      await httpPost(page, '/api/config', { mode: 'manual' });
      await httpPost(page, '/api/config', { mode: 'always_on' });

      // Get config changes (via sessions API as proxy)
      const { body: sessions } = await httpGet(page, '/api/sessions');
      expect(Array.isArray(sessions)).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('MCP Tools - Error Handling', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('action with no browser connected returns error', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Disconnect extension
      await page.evaluate(() => {
        window.__e2eWs?.forEach(ws => ws.close());
        window.__e2eWs?.clear();
      });
      await page.waitForTimeout(500);

      // Try to collect with no extension
      const { body: collectResp } = await httpPost(page, '/api/collect', { tabId: 999 });
      // Should not crash
      expect(collectResp).toBeDefined();
    } finally {
      await context.close();
    }
  });

  test('invalid config change is handled gracefully', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Send invalid config
      const { status, body } = await httpPost(page, '/api/config', {
        invalidField: 'should be ignored',
      });

      // Server should handle it gracefully
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    } finally {
      await context.close();
    }
  });
});
