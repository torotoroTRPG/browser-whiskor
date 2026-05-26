/**
 * tests/integration/multi-tab.test.js
 * Section 10.3 — Multi-Tab & Session Recovery
 *
 * Tests for multiple simultaneous connections, session persistence, and recovery scenarios.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from '../helpers/server-fixture.js';
import { createSWClient, createDashboardClient, sleep } from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const pool = createPortPool(8); // multi-tab file ID

async function setup() {
  const { server, teardown } = await withServer(pool.next());
  return { server, teardown };
}

describe('10.3 Multi-Tab & Session Recovery', () => {

  test('Multiple SWs connect → each receives independent SET_CONFIG', async () => {
    const { server, teardown } = await setup();
    try {
      const sw1 = await createSWClient(server);
      const sw2 = await createSWClient(server);
      const sw3 = await createSWClient(server);

      assert.strictEqual(server.swSockets.size, 3);

      // Broadcast to SW must reach all 3
      const p1 = sw1.nextMessage(m => m.type === 'SET_CONFIG', 2000);
      const p2 = sw2.nextMessage(m => m.type === 'SET_CONFIG', 2000);
      const p3 = sw3.nextMessage(m => m.type === 'SET_CONFIG', 2000);

      server.broadcastToSW({ type: 'SET_CONFIG', config: { mode: 'test' } });

      const [msg1, msg2, msg3] = await Promise.all([p1, p2, p3]);
      assert.strictEqual(msg1.config.mode, 'test');
      assert.strictEqual(msg2.config.mode, 'test');
      assert.strictEqual(msg3.config.mode, 'test');

      await sw1.close();
      await sw2.close();
      await sw3.close();
    } finally {
      await teardown();
    }
  });

  test('SW disconnect → dashboard still receives broadcasts from remaining SW', async () => {
    const { server, teardown } = await setup();
    try {
      const sw1 = await createSWClient(server);
      const sw2 = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      // Disconnect sw1
      sw1.ws.close();
      await sleep(100);

      assert.strictEqual(server.swSockets.size, 1);

      // sw2 sends message, dashboard must receive
      const dashPromise = dashboard.nextMessage(m => m.type === 'TEXT_COORDS', 2000);
      sw2.ws.send(JSON.stringify({ type: 'TEXT_COORDS', tabId: 2, payload: { words: [] } }));

      const msg = await dashPromise;
      assert.strictEqual(msg.type, 'TEXT_COORDS');
      assert.strictEqual(msg.tabId, 2);

      await sw2.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });

  test('Multiple dashboards → all receive same broadcast', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dash1 = await createDashboardClient(server);
      const dash2 = await createDashboardClient(server);

      assert.strictEqual(server.dashboardSockets.size, 2);

      // SW sends message, both dashboards must receive
      const p1 = dash1.nextMessage(m => m.type === 'VIEWPORT_UPDATE', 2000);
      const p2 = dash2.nextMessage(m => m.type === 'VIEWPORT_UPDATE', 2000);

      sw.ws.send(JSON.stringify({
        type: 'VIEWPORT_UPDATE',
        tabId: 1,
        payload: { scrollX: 100, scrollY: 200, width: 1280, height: 800 },
      }));

      const [msg1, msg2] = await Promise.all([p1, p2]);
      assert.strictEqual(msg1.payload.scrollX, 100);
      assert.strictEqual(msg2.payload.scrollX, 100);

      await sw.close();
      await dash1.close();
      await dash2.close();
    } finally {
      await teardown();
    }
  });

  test('TEXT_COORDS → VIEWPORT_UPDATE → TEXT_COORD_DELTA: continuous flow', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      // Phase 1: Initial TEXT_COORDS
      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORDS',
        tabId: 1,
        payload: {
          words: [{ id: 'w1', text: 'Hello', x: 100, y: 100, width: 50, height: 16 }],
          viewport: { scrollX: 0, scrollY: 0, width: 1280, height: 800 },
        },
      }));

      const tcMsg = await dashboard.nextMessage(m => m.type === 'TEXT_COORDS', 2000);
      assert.strictEqual(tcMsg.payload.words[0].text, 'Hello');

      // Phase 2: VIEWPORT_UPDATE (user scrolls)
      sw.ws.send(JSON.stringify({
        type: 'VIEWPORT_UPDATE',
        tabId: 1,
        payload: { scrollX: 0, scrollY: 500, width: 1280, height: 800 },
      }));

      const vpMsg = await dashboard.nextMessage(m => m.type === 'VIEWPORT_UPDATE', 2000);
      assert.strictEqual(vpMsg.payload.scrollY, 500);

      // Phase 3: TEXT_COORD_DELTA (beacon scan result)
      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORD_DELTA',
        tabId: 1,
        deltas: [{ id: 'w1', inView: false, viewportX: 100, viewportY: -400 }],
      }));

      const deltaMsg = await dashboard.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 2000);
      assert.strictEqual(deltaMsg.deltas[0].inView, false);

      await sw.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });

  test('Rapid SW reconnect (5×) → no crash, consistent state', async () => {
    const { server, teardown } = await setup();
    try {
      for (let i = 0; i < 5; i++) {
        const sw = await createSWClient(server);
        assert.strictEqual(server.swSockets.size, 1, `reconnect ${i + 1}: must have 1 socket`);

        // createSWClient already waits for SET_CONFIG, just verify connection
        await sleep(20);

        await sw.close();
        await sleep(50);
      }

      // After all reconnects, server must be clean
      assert.strictEqual(server.swSockets.size, 0, 'all sockets must be cleaned up');
    } finally {
      await teardown();
    }
  });

  test('EXPLORER_STATE_UPDATE → dashboard receives state graph changes', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      const explorerPromise = dashboard.nextMessage(m => m.type === 'EXPLORER_STATE_UPDATE', 2000);

      sw.ws.send(JSON.stringify({
        type: 'EXPLORER_STATE_UPDATE',
        tabId: 1,
        payload: {
          node: { hash: 'abc123', url: 'https://example.com', label: 'Home' },
          edge: { from: 'root', to: 'abc123', action: { type: 'click' } },
        },
      }));

      const explorerMsg = await explorerPromise;
      assert.strictEqual(explorerMsg.payload.node.hash, 'abc123');
      assert.strictEqual(explorerMsg.payload.edge.to, 'abc123');

      await sw.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });

  test('REACT_TRANSITION → dashboard receives state transition', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      const reactPromise = dashboard.nextMessage(m => m.type === 'REACT_TRANSITION', 2000);

      sw.ws.send(JSON.stringify({
        type: 'REACT_TRANSITION',
        tabId: 1,
        payload: {
          from: 'state_a',
          to: 'state_b',
          trigger: { type: 'click', selector: '#btn' },
        },
      }));

      const reactMsg = await reactPromise;
      assert.strictEqual(reactMsg.payload.from, 'state_a');
      assert.strictEqual(reactMsg.payload.to, 'state_b');

      await sw.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });
});
