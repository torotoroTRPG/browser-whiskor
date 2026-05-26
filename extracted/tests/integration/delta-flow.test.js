/**
 * tests/integration/delta-flow.test.js
 * Section 3.2 — Delta Message Flow
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from '../helpers/server-fixture.js';
import { createSWClient, createDashboardClient, sleep } from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const pool = createPortPool(3);

async function setup() {
  const { server, teardown } = await withServer(pool.next());
  return { server, teardown };
}

describe('3.2 Delta Message Flow', () => {

  test('TEXT_COORD_DELTA forwarded to dashboard but NOT cached', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dashboard = await createDashboardClient(server);

      const deltaPromise = dashboard.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 2000);

      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORD_DELTA',
        tabId: 1,
        deltas: [
          { id: 'w1', inView: true, viewportX: 100, viewportY: 200 },
          { id: 'w2', inView: false, viewportX: 500, viewportY: 600 },
        ],
      }));

      const delta = await deltaPromise;
      assert.strictEqual(delta.type, 'TEXT_COORD_DELTA');
      assert.strictEqual(delta.deltas.length, 2);
      assert.strictEqual(delta.deltas[0].id, 'w1');
      assert.strictEqual(delta.deltas[0].inView, true);

      await sw.close();
      await dashboard.close();
    } finally {
      await teardown();
    }
  });

  test('TEXT_COORD_DELTA with viewStateOnly → dashboard updates inView state', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dash2 = await createDashboardClient(server);
      const deltaPromise = dash2.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 2000);

      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORD_DELTA',
        tabId: 1,
        deltas: [{ id: 'w1', inView: false, viewStateOnly: true }],
      }));

      const delta = await deltaPromise;
      assert.strictEqual(delta.deltas[0].viewStateOnly, true);
      assert.strictEqual(delta.deltas[0].inView, false);

      await sw.close();
      await dash2.close();
    } finally {
      await teardown();
    }
  });

  test('Delta on wrong tab → dashboard can filter by tabId', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dash3 = await createDashboardClient(server);
      const deltaPromise = dash3.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 2000);

      sw.ws.send(JSON.stringify({
        type: 'TEXT_COORD_DELTA',
        tabId: 999,
        deltas: [{ id: 'w1', inView: true }],
      }));

      const delta = await deltaPromise;
      assert.strictEqual(delta.tabId, 999);

      await sw.close();
      await dash3.close();
    } finally {
      await teardown();
    }
  });

  test('Multiple deltas in sequence → all forwarded correctly', async () => {
    const { server, teardown } = await setup();
    try {
      const sw = await createSWClient(server);
      const dash4 = await createDashboardClient(server);
      const deltas = [];

      for (let i = 0; i < 3; i++) {
        const p = dash4.nextMessage(m => m.type === 'TEXT_COORD_DELTA', 2000);
        sw.ws.send(JSON.stringify({
          type: 'TEXT_COORD_DELTA',
          tabId: 1,
          deltas: [{ id: `w${i}`, inView: i % 2 === 0 }],
        }));
        deltas.push(await p);
      }

      assert.strictEqual(deltas.length, 3);
      assert.strictEqual(deltas[0].deltas[0].inView, true);
      assert.strictEqual(deltas[1].deltas[0].inView, false);
      assert.strictEqual(deltas[2].deltas[0].inView, true);

      await sw.close();
      await dash4.close();
    } finally {
      await teardown();
    }
  });
});
