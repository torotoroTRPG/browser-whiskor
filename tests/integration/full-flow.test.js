/**
 * tests/integration/full-flow.test.js
 * Section 10.1 — Full Flow
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from '../helpers/server-fixture.js';
import { createSWClient, createDashboardClient, sleep } from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const pool = createPortPool(4);

async function setup() {
  const { server, teardown } = await withServer(pool.next());
  return { server, teardown };
}

describe('10.1 Full Flow', () => {

  test('Collect → Read → Act: TEXT_COORDS sent, action executed', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORDS',
        tabId: 1,
        payload: {
          words: [{ id: 'w1', text: 'Submit', x: 100, y: 200, width: 60, height: 20 }],
          viewport: { scrollX: 0, scrollY: 0, width: 1280, height: 800 },
        },
      }));

      const dashMsg = await dashboard.nextMessage(m => m.type === 'TEXT_COORDS', 2000);
      assert.ok(dashMsg, 'Dashboard must receive TEXT_COORDS');
      assert.strictEqual(dashMsg.payload.words[0].text, 'Submit');

      // Start HTTP action (server holds response until ACTION_RESULT)
      const actionPromise = sw.nextMessage(m => m.type === 'EXECUTE_ACTION', 3000);
      const fetchPromise = server.fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 1, action: { type: 'click', x: 100, y: 200 } }),
      });

      // SW receives EXECUTE_ACTION
      const execMsg = await actionPromise;
      assert.strictEqual(execMsg.type, 'EXECUTE_ACTION');
      assert.strictEqual(execMsg.action.type, 'click');

      // Send ACTION_RESULT so server can resolve the HTTP response
      sw.ws.send(JSON.stringify({ type: 'ACTION_RESULT', id: execMsg.id, result: { ok: true } }));

      const res = await fetchPromise;
      const actionResult = await res.json();
      assert.strictEqual(actionResult.ok, true);

      await sw.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });

  test('Config change → Effect: mode change broadcast to SW', async () => {
    const { server, teardown } = await setup();
    try {
      const sw2 = await createSWClient(server);
      const configPromise = sw2.nextMessage(m => m.type === 'SET_CONFIG', 2000);

      await server.fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'manual' }),
      });

      const setConfig = await configPromise;
      assert.strictEqual(setConfig.type, 'SET_CONFIG');
      assert.strictEqual(setConfig.config.mode, 'manual');

      await sw2.close();
    } finally {
      await teardown();
    }
  });

  test('Collect trigger: POST /api/collect sends MANUAL_COLLECT to SW', async () => {
    const { server, teardown } = await setup();
    try {
      const sw3 = await createSWClient(server);
      const collectPromise = sw3.nextMessage(m => m.type === 'MANUAL_COLLECT', 2000);

      await server.fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 42 }),
      });

      const collect = await collectPromise;
      assert.strictEqual(collect.type, 'MANUAL_COLLECT');
      assert.strictEqual(collect.tabId, 42);

      await sw3.close();
    } finally {
      await teardown();
    }
  });

  test('VIEWPORT_UPDATE → Dashboard receives live scroll changes', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dash2 = await createDashboardClient(server);
      const vpPromise = dash2.nextMessage(m => m.type === 'VIEWPORT_UPDATE', 2000);

      sw.ws.send(JSON.stringify({
        type: 'VIEWPORT_UPDATE',
        tabId: 1,
        payload: { scrollX: 500, scrollY: 300, width: 1280, height: 800 },
      }));

      const vp = await vpPromise;
      assert.strictEqual(vp.payload.scrollX, 500);
      assert.strictEqual(vp.payload.scrollY, 300);

      await sw.close();
      await dash2.close();
    } finally {
      await teardown();
    }
  });
});
