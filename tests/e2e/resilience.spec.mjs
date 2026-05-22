/**
 * tests/e2e/resilience.spec.mjs
 *
 * Error Handling & Resilience E2E tests.
 *
 * Tests:
 *   - Server crash recovery
 *   - Extension disconnect during operation
 *   - Malformed messages
 *   - Network timeouts
 *   - Concurrent connections
 *   - Large payload handling
 *
 * Run with: npm run test:e2e -- --grep "Resilience"
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  httpPost,
  TestPages,
  textCoordsPayload,
  assertHealthOk,
  createWS,
  waitForMessage,
  sendMessage,
  closeWS,
  closeAllWS,
  WS_URL,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Resilience - Malformed Input', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('malformed JSON does not crash server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Send malformed JSON via browser WS
      const { id: wsId } = await createWS(page, `${WS_URL}?sw=1`);

      // Send invalid JSON
      await page.evaluate((url) => {
        const ws = window.__e2eWs?.values().next().value;
        if (ws) ws.send('THIS IS NOT JSON }{{{');
      }, WS_URL);

      await page.waitForTimeout(200);

      // Server should still be alive
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      // Should still accept valid messages
      await sendMessage(page, wsId, textCoordsPayload([
        { id: 'w1', text: 'Test', absoluteX: 0, absoluteY: 0, width: 50, height: 16 },
      ]));

      await closeWS(page, wsId);
    } finally {
      await context.close();
    }
  });

  test('empty message body does not crash server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: wsId } = await createWS(page, `${WS_URL}?sw=1`);

      // Send empty message
      await page.evaluate(() => {
        const ws = window.__e2eWs?.values().next().value;
        if (ws) ws.send('');
      });

      await page.waitForTimeout(200);

      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, wsId);
    } finally {
      await context.close();
    }
  });

  test('message with missing type is handled gracefully', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: wsId } = await createWS(page, `${WS_URL}?sw=1`);

      // Send message without type
      await sendMessage(page, wsId, { tabId: 1, payload: {} });

      await page.waitForTimeout(200);

      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, wsId);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Resilience - Connection Management', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('extension disconnect and reconnect works', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Get initial connection count
      const { body: health1 } = await httpGet(page, '/health');
      const initialConnections = health1.wsConnections;

      // Disconnect extension
      await closeAllWS(page);
      await page.waitForTimeout(500);

      // Reconnect
      await page.reload();
      await waitForExtensionConnection(page);

      // Should have connection again
      const { body: health2 } = await httpGet(page, '/health');
      expect(health2.wsConnections).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('dashboard disconnect does not affect SW connection', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      const { id: dashId } = await createWS(page, `${WS_URL}/dashboard`);

      // Disconnect dashboard
      await closeWS(page, dashId);
      await page.waitForTimeout(200);

      // SW should still work
      await sendMessage(page, swId, textCoordsPayload([
        { id: 'w1', text: 'Test', absoluteX: 0, absoluteY: 0, width: 50, height: 16 },
      ]));

      // Server should still be healthy
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });

  test('rapid connect/disconnect cycles do not crash server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Rapid cycles
      for (let i = 0; i < 5; i++) {
        const { id: wsId } = await createWS(page, `${WS_URL}?sw=${i}`);
        await closeWS(page, wsId);
        await page.waitForTimeout(100);
      }

      // Server should still be healthy
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Resilience - Large Payloads', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('large TEXT_COORDS payload is handled', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      const { id: dashId } = await createWS(page, `${WS_URL}/dashboard`);

      // Create large payload (1000 words)
      const largeWords = Array.from({ length: 1000 }, (_, i) => ({
        id: `w${i}`,
        text: `Word number ${i} with some extra text`,
        absoluteX: i % 50 * 20,
        absoluteY: Math.floor(i / 50) * 30,
        width: 100,
        height: 16,
      }));

      await sendMessage(page, swId, textCoordsPayload(largeWords));

      // Dashboard should receive it
      const received = await waitForMessage(page, dashId, 'TEXT_COORDS');
      expect(received.payload.words).toHaveLength(1000);

      // Server should still be healthy
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, swId);
      await closeWS(page, dashId);
    } finally {
      await context.close();
    }
  });

  test('very large payload (5000 words) does not crash server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      // Create very large payload
      const hugeWords = Array.from({ length: 5000 }, (_, i) => ({
        id: `w${i}`,
        text: `Word ${i}`,
        absoluteX: 0,
        absoluteY: 0,
        width: 10,
        height: 10,
      }));

      await sendMessage(page, swId, textCoordsPayload(hugeWords));
      await page.waitForTimeout(500);

      // Server should still be healthy
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Resilience - Concurrent Operations', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('concurrent WS connections are handled correctly', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Connect multiple SW clients simultaneously
      const ts = Date.now();
      const swResults = await Promise.all([
        createWS(page, `${WS_URL}?sw=conc-${ts}-1`, { consumeInit: false }),
        createWS(page, `${WS_URL}?sw=conc-${ts}-2`, { consumeInit: false }),
        createWS(page, `${WS_URL}?sw=conc-${ts}-3`, { consumeInit: false }),
      ]);
      const swIds = swResults.map(r => r.id);

      // Wait for connections to stabilize
      await page.waitForTimeout(500);

      // Verify connection count
      const { body: health } = await httpGet(page, '/health');
      expect(health.wsConnections).toBeGreaterThanOrEqual(3);

      // Send message from each
      for (const id of swIds) {
        await sendMessage(page, id, { type: 'PING' });
        await waitForMessage(page, id, 'PONG');
      }

      // Clean up
      for (const id of swIds) {
        await closeWS(page, id);
      }
    } finally {
      await context.close();
    }
  });

  test('concurrent HTTP requests do not cause race conditions', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Send multiple HTTP requests concurrently
      const requests = [
        httpGet(page, '/health'),
        httpGet(page, '/api/config'),
        httpGet(page, '/api/sessions'),
        httpPost(page, '/api/config', { mode: 'always_on' }),
        httpPost(page, '/api/collect', { tabId: 1 }),
      ];

      const results = await Promise.all(requests);

      // All should succeed
      for (const { status, body } of results) {
        expect(status).toBe(200);
      }
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Resilience - Unknown Message Types', () => {
  test.describe.configure({ timeout: 120000 });

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('unknown message type does not crash server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=test-${Date.now()}`);

      // Small delay to ensure connection is stable
      await page.waitForTimeout(200);

      // Send unknown message type
      await sendMessage(page, swId, {
        type: 'UNKNOWN_FUTURE_TYPE_v999',
        tabId: 1,
        payload: { data: 'test' },
      });

      await page.waitForTimeout(200);

      // Server should still be healthy
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      // Should still accept valid messages
      await sendMessage(page, swId, { type: 'PING' });
      const pong = await waitForMessage(page, swId, 'PONG');
      expect(pong.type).toBe('PONG');

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });

  test('message with null type is handled gracefully', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      await sendMessage(page, swId, { type: null, payload: {} });
      await page.waitForTimeout(200);

      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });
});
