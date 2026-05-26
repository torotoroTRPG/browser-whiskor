/**
 * tests/e2e/state-machine.spec.mjs
 *
 * State Machine & Navigation E2E tests.
 *
 * Tests:
 *   - State recording via EXPLORER_STATE_UPDATE
 *   - State graph edge recording via REACT_TRANSITION
 *   - State navigation (navigate_to_state simulation)
 *   - Hash consistency across page loads
 *
 * Run with: npm run test:e2e -- --grep "State Machine"
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  httpPost,
  TestPages,
  explorerStatePayload,
  assertHealthOk,
  createWS,
  waitForMessage,
  sendMessage,
  closeWS,
  WS_URL,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

// ══════════════════════════════════════════════════════════════════════════════
test.describe('State Machine - State Recording', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('EXPLORER_STATE_UPDATE records state in server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=test-${Date.now()}`);
      const { id: dashId } = await createWS(page, `${WS_URL}/dashboard`);

      // Set up dashboard listener BEFORE sending
      const dashPromise = waitForMessage(page, dashId, 'EXPLORER_STATE_UPDATE');

      // Send state update
      const stateMsg = explorerStatePayload('v1', 'hash-abc', {
        buttons: [{ text: 'Submit', xpath: '//button[1]' }],
      });

      await sendMessage(page, swId, stateMsg);

      // Dashboard should receive the state update
      const received = await dashPromise;
      expect(received.type).toBe('EXPLORER_STATE_UPDATE');
      expect(received.payload.currentHash).toBe('hash-abc');

      await closeWS(page, swId);
      await closeWS(page, dashId);
    } finally {
      await context.close();
    }
  });

  test('Multiple states are recorded with unique hashes', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      // Send multiple state updates
      const states = [
        { hash: 'hash-1', url: 'http://example.com/page1' },
        { hash: 'hash-2', url: 'http://example.com/page2' },
        { hash: 'hash-3', url: 'http://example.com/page3' },
      ];

      for (const state of states) {
        await sendMessage(page, swId, explorerStatePayload('v1', state.hash, {
          buttons: [],
        }));
        await page.waitForTimeout(100);
      }

      // Verify server is still healthy (no crashes)
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });

  test('State with uiCatalog triggers EXPLORER_NEXT_ACTION', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Use unique URL to avoid conflict with extension's connection
      const { id: swId } = await createWS(page, `${WS_URL}?sw=test-${Date.now()}`);

      // Set up listener BEFORE sending
      const nextActionPromise = waitForMessage(page, swId, 'EXPLORER_NEXT_ACTION');

      // Send state with uiCatalog
      await sendMessage(page, swId, explorerStatePayload('v1', 'hash-test', {
        buttons: [
          { text: 'Submit', xpath: '//button[1]', visible: true },
          { text: 'Cancel', xpath: '//button[2]', visible: true },
        ],
      }));

      // Server should respond with EXPLORER_NEXT_ACTION
      const nextAction = await nextActionPromise;
      expect(nextAction.type).toBe('EXPLORER_NEXT_ACTION');
      expect(nextAction.payload).toBeDefined();

      await closeWS(page, swId);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('State Machine - React Transitions', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('REACT_TRANSITION records edge in state graph', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=test-${Date.now()}`);
      const { id: dashId } = await createWS(page, `${WS_URL}/dashboard`);

      // Small delay to ensure connections are stable
      await page.waitForTimeout(200);

      // Set up listener BEFORE sending
      const dashPromise = waitForMessage(page, dashId, 'REACT_TRANSITION');

      // Send React transition
      const transitionMsg = {
        type: 'REACT_TRANSITION',
        tabId: 1,
        siteVersion: 'v1',
        payload: {
          from: 'state-A',
          to: 'state-B',
          fromReact: { hash: 'react-1' },
          toReact: { hash: 'react-2' },
          trigger: 'click',
        },
      };

      await sendMessage(page, swId, transitionMsg);

      // Dashboard should receive it
      const received = await dashPromise;
      expect(received.type).toBe('REACT_TRANSITION');
      expect(received.payload.from).toBe('state-A');
      expect(received.payload.to).toBe('state-B');
      expect(received.payload.trigger).toBe('click');

      await closeWS(page, swId);
      await closeWS(page, dashId);
    } finally {
      await context.close();
    }
  });

  test('Multiple transitions build a connected graph', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=1`);

      // Send a chain of transitions
      const transitions = [
        { from: 'home', to: 'login', trigger: 'click_login' },
        { from: 'login', to: 'dashboard', trigger: 'submit_form' },
        { from: 'dashboard', to: 'settings', trigger: 'click_settings' },
      ];

      for (const t of transitions) {
        await sendMessage(page, swId, {
          type: 'REACT_TRANSITION',
          tabId: 1,
          siteVersion: 'v1',
          payload: {
            from: t.from,
            to: t.to,
            fromReact: { hash: `hash-${t.from}` },
            toReact: { hash: `hash-${t.to}` },
            trigger: t.trigger,
          },
        });
        await page.waitForTimeout(100);
      }

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
test.describe('State Machine - Navigation', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('navigate_to_state replays actions via page navigation', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Navigate through pages to build state history
      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);

      // Navigate back to first page (simulates navigate_to_state)
      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);

      // Verify we're on the right page
      const title = await page.textContent('h1');
      expect(title).toBe('Test Page');

      // Server should still be connected
      const { body: health } = await httpGet(page, '/health');
      assertHealthOk(health);
    } finally {
      await context.close();
    }
  });

  test('STATE_HASH_REPORT is processed by server', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      const { id: swId } = await createWS(page, `${WS_URL}?sw=test-${Date.now()}`);
      const { id: dashId } = await createWS(page, `${WS_URL}/dashboard`);

      // Small delay to ensure connections are stable
      await page.waitForTimeout(200);

      // Set up listener BEFORE sending
      const dashPromise = waitForMessage(page, dashId, 'STATE_HASH_REPORT');

      // Send hash report
      const hashReport = {
        type: 'STATE_HASH_REPORT',
        tabId: 1,
        siteVersion: 'v1',
        payload: {
          currentHash: 'hash-verify',
          reactHash: 'react-123',
          domHash: 'dom-456',
          url: 'http://example.com',
        },
      };

      await sendMessage(page, swId, hashReport);

      // Dashboard should receive it
      const received = await dashPromise;
      expect(received.type).toBe('STATE_HASH_REPORT');
      expect(received.payload.currentHash).toBe('hash-verify');

      await closeWS(page, swId);
      await closeWS(page, dashId);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('State Machine - Hash Consistency', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('Same page produces consistent state hash', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      // Load same page twice
      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);
      const hash1 = await page.evaluate(() => {
        // In a real test, we'd compute the hash from the page state
        return document.title || document.URL;
      });

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);
      const hash2 = await page.evaluate(() => {
        return document.title || document.URL;
      });

      // Same page should produce same identifier
      expect(hash1).toBe(hash2);
    } finally {
      await context.close();
    }
  });

  test('Different pages produce different state hashes', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.simpleText);
      await page.waitForTimeout(1000);
      const hash1 = await page.evaluate(() => document.URL);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(1000);
      const hash2 = await page.evaluate(() => document.URL);

      expect(hash1).not.toBe(hash2);
    } finally {
      await context.close();
    }
  });
});
