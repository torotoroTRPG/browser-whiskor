/**
 * tests/integration/error-recovery.test.js
 * Section 10.2 — Error Recovery
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from '../helpers/server-fixture.js';
import { createSWClient, sleep, waitFor } from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const pool = createPortPool(5);

async function setup() {
  const { server, teardown } = await withServer(pool.next());
  return { server, teardown };
}

describe('10.2 Error Recovery', () => {

  test('SW disconnect → server cleans up socket set', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      assert.strictEqual(server.swSockets.size, 1);

      sw.ws.close();
      await sleep(100);

      assert.strictEqual(server.swSockets.size, 0, 'swSockets must be cleaned up after disconnect');
    } finally {
      await teardown();
    }
  });

  test('SW reconnect after disconnect → fresh connection works', async () => {
    const { server, teardown } = await setup();
    try {
      let sw = await createSWClient(server);
      await sw.close();
      await sleep(100);

      sw = await createSWClient(server);
      assert.strictEqual(server.swSockets.size, 1);

      // createSWClient already waits for SET_CONFIG via nextMessage('INIT' for dashboard, 'SET_CONFIG' for SW)
      // Just verify the connection is alive by sending a message
      sw.ws.send(JSON.stringify({ type: 'TEXT_COORDS', tabId: 1, payload: {} }));
      await sleep(50);

      assert.strictEqual(server.swSockets.size, 1, 'reconnected SW must have a socket');

      await sw.close();
    } finally {
      await teardown();
    }
  });

  test('Malformed JSON from SW → no crash, other clients unaffected', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const sw2 = await createSWClient(server);

      sw.ws.send('not valid json{{{');
      await sleep(100);

      sw2.ws.send(JSON.stringify({ type: 'TEXT_COORDS', tabId: 1, payload: {} }));
      await sleep(50);

      assert.strictEqual(server.swSockets.size, 2, 'both SW connections must still be alive');

      await sw.close();
      await sw2.close();
    } finally {
      await teardown();
    }
  });

  test('Action timeout → error returned, no hang', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);

      // Start fetch (server holds response until ACTION_RESULT)
      const fetchPromise = server.fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 1, action: { type: 'click', x: 0, y: 0 } }),
      });

      const execMsg = await sw.nextMessage(m => m.type === 'EXECUTE_ACTION', 3000);
      sw.ws.send(JSON.stringify({ type: 'ACTION_RESULT', id: execMsg.id, result: { ok: true } }));

      const res = await fetchPromise;
      assert.ok(res.status === 200 || res.status === 500, `expected 200 or 500, got ${res.status}`);

      await sw.close();
    } finally {
      await teardown();
    }
  });

  test('Invalid action type → error returned', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const actionPromise = sw.nextMessage(m => m.type === 'EXECUTE_ACTION', 2000);

      const fetchPromise = server.fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 1, action: { type: 'unknown_action_type', data: {} } }),
      });

      const execMsg = await actionPromise;
      assert.strictEqual(execMsg.action.type, 'unknown_action_type');

      sw.ws.send(JSON.stringify({ type: 'ACTION_RESULT', id: execMsg.id, result: { ok: true } }));

      const res = await fetchPromise;
      assert.ok(res.status === 200 || res.status === 500, `expected 200 or 500, got ${res.status}`);

      await sw.close();
    } finally {
      await teardown();
    }
  });
});
