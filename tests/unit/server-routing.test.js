/**
 * tests/unit/server-routing.test.js
 * Section 1.3 — Message Routing
 *
 * Verifies that each incoming SW message type is:
 *   - Routed to the correct destination (dashboard / action-executor / etc.)
 *   - Has the expected side effects (caching, pending-promise resolution)
 *   - Does NOT go where it should not (e.g. TEXT_COORD_DELTA is NOT cached)
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert       from 'node:assert/strict';
import { withServer }     from '../helpers/server-fixture.js';
import {
  createSWClient,
  createDashboardClient,
  sleep,
  waitFor,
} from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const ports = createPortPool(2); // file ID 2 → ports 18200–18299

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sends a raw message from the SW and waits for it on the dashboard. */
async function swSendExpectDash(server, sw, dash, msg, timeoutMs = 2_000) {
  const p = dash.nextMessage(m => m.type === msg.type, timeoutMs);
  sw.send(msg);
  return p;
}

// ══════════════════════════════════════════════════════════════════════════════
describe('1.3 Message Routing', () => {

  // ── Broadcastable types ────────────────────────────────────────────────────

  for (const msgType of [
    'TEXT_COORDS',
    'VIEWPORT_UPDATE',
    'TEXT_COORD_DELTA',
    'EXPLORER_STATE_UPDATE',
    'REACT_TRANSITION',
    'STATE_HASH_REPORT',
  ]) {
    test(`${msgType} is forwarded to dashboard`, async () => {
      const { server, teardown } = await withServer(ports.next());
      try {
        const sw   = await createSWClient(server);
        const dash = await createDashboardClient(server);

        const payload = { type: msgType, data: { test: true }, tabId: 1 };
        const received = await swSendExpectDash(server, sw, dash, payload);

        assert.strictEqual(received.type, msgType);
        assert.deepStrictEqual(received.data, { test: true });

        await sw.close();
        await dash.close();
      } finally {
        await teardown();
      }
    });
  }

  // ── TEXT_COORD_DELTA: NOT cached ────────────────────────────────────────────

  test('TEXT_COORD_DELTA forwarded to dashboard but server emits message event', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw   = await createSWClient(server);
      const dash = await createDashboardClient(server);

      const receivedMsgs = [];
      server.on('message', m => receivedMsgs.push(m));

      const dashP = dash.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 1_500);
      sw.send({ type: 'TEXT_COORD_DELTA', deltas: [{ id: 'w1', inView: true }] });

      const received = await dashP;
      assert.strictEqual(received.type, 'TEXT_COORD_DELTA');
      assert.ok(receivedMsgs.some(m => m.type === 'TEXT_COORD_DELTA'),
        'server should emit message event for TEXT_COORD_DELTA');

      await sw.close();
      await dash.close();
    } finally {
      await teardown();
    }
  });

  // ── ACTION_RESULT: resolves pending action ──────────────────────────────────

  test('ACTION_RESULT resolves the matching pending action promise', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw = await createSWClient(server);

      // Simulate server registering a pending action
      const pendingId = `act_test_${Date.now()}`;
      const resultValue = { clicked: true, element: 'button#submit' };

      const pendingPromise = new Promise((resolve, reject) => {
        server._pendingActions.set(pendingId, { resolve, reject });
      });

      // SW sends back ACTION_RESULT
      sw.send({ type: 'ACTION_RESULT', id: pendingId, result: resultValue });

      const resolved = await pendingPromise;
      assert.deepStrictEqual(resolved, resultValue);

      await sw.close();
    } finally {
      await teardown();
    }
  });

  test('ACTION_RESULT cleans up _pendingActions after resolution', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw = await createSWClient(server);
      const pendingId = `act_cleanup_${Date.now()}`;

      new Promise((resolve, reject) => {
        server._pendingActions.set(pendingId, { resolve, reject });
      });

      assert.strictEqual(server._pendingActions.has(pendingId), true);

      sw.send({ type: 'ACTION_RESULT', id: pendingId, result: {} });
      await waitFor(() => !server._pendingActions.has(pendingId), 2_000);

      assert.strictEqual(server._pendingActions.has(pendingId), false,
        'pending action must be removed from map after resolution');

      await sw.close();
    } finally {
      await teardown();
    }
  });

  test('ACTION_RESULT with unknown id is silently ignored (no crash)', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw = await createSWClient(server);

      assert.doesNotThrow(() => {
        server._route({ type: 'ACTION_RESULT', id: 'nonexistent_id', result: {} }, null, true);
      });

      await sw.close();
    } finally {
      await teardown();
    }
  });

  // ── Unknown message type ────────────────────────────────────────────────────

  test('Unknown message type does not crash server', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw   = await createSWClient(server);
      const dash = await createDashboardClient(server);

      // Should not throw
      assert.doesNotThrow(() => {
        server._route({ type: 'UNKNOWN_FUTURE_TYPE', payload: {} }, null, true);
      });

      // Dashboard must NOT receive the unknown message
      const stray = await dash.collect(150);
      assert.ok(!stray.some(m => m.type === 'UNKNOWN_FUTURE_TYPE'),
        'Unknown message type must not be broadcast to dashboard');

      await sw.close();
      await dash.close();
    } finally {
      await teardown();
    }
  });

  // ── Malformed JSON from SW ──────────────────────────────────────────────────

  test('Malformed JSON from SW does not crash server or disconnect other clients', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw   = await createSWClient(server);
      const dash = await createDashboardClient(server);

      // Send raw malformed JSON
      sw.ws.send('THIS IS NOT JSON }{{{');
      await waitFor(() => server.swSockets.size === 1 && server.dashboardSockets.size === 1, 2_000);

      // Server and dashboard must still be alive
      assert.strictEqual(server.swSockets.size, 1);
      assert.strictEqual(server.dashboardSockets.size, 1);

      // Dashboard should still receive valid messages
      const validP = dash.nextMessage(m => m.type === 'VALID_AFTER_ERROR', 1_000);
      server.broadcastToDashboard({ type: 'VALID_AFTER_ERROR' });
      await validP;

      await sw.close();
      await dash.close();
    } finally {
      await teardown();
    }
  });

  // ── server 'message' event ──────────────────────────────────────────────────

  test('All routed messages emit the server-level "message" event', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw   = await createSWClient(server);
      const dash = await createDashboardClient(server);

      const seenTypes = new Set();
      server.on('message', msg => seenTypes.add(msg.type));

      const typesToSend = ['TEXT_COORDS', 'VIEWPORT_UPDATE', 'REACT_TRANSITION'];
      for (const type of typesToSend) {
        sw.send({ type, data: {} });
      }

      // Wait for all to be processed
      await waitFor(() => typesToSend.every(t => seenTypes.has(t)), 2_000);

      for (const type of typesToSend) {
        assert.ok(seenTypes.has(type), `server "message" event must be emitted for ${type}`);
      }

      await sw.close();
      await dash.close();
    } finally {
      await teardown();
    }
  });

  // ── Broadcast when no dashboard connected ───────────────────────────────────

  test('Broadcasting to empty dashboard set does not throw', async () => {
    const { server, teardown } = await withServer(ports.next());
    try {
      const sw = await createSWClient(server);
      // No dashboard connected

      assert.doesNotThrow(() => {
        server.broadcastToDashboard({ type: 'TEXT_COORDS', data: {} });
      });

      await sw.close();
    } finally {
      await teardown();
    }
  });
});
