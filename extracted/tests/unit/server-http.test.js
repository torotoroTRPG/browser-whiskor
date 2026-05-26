/**
 * tests/unit/server-http.test.js
 * Section 1.2 — HTTP API
 *
 * Tests all REST endpoints:
 *   GET /health, /api/config, /api/sessions
 *   POST /api/config, /api/collect, /api/action
 *   OPTIONS preflight (CORS)
 */

import { describe, test } from 'node:test';
import assert             from 'node:assert/strict';
import { withServer }     from '../helpers/server-fixture.js';
import {
  createSWClient,
  createDashboardClient,
  sleep,
} from '../helpers/ws-client.js';
import { createPortPool } from '../helpers/port-pool.js';

const ports = createPortPool(1); // file ID 1 → ports 18100–18199

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup(opts = {}) {
  const { server, teardown } = await withServer({ ...ports.next(), ...opts });
  return { server, teardown };
}

async function json(res) {
  return res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
describe('1.2 HTTP API', () => {

  // ── GET /health ─────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    test('returns 200 with ok:true', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/health');
        assert.strictEqual(res.status, 200);
        const body = await json(res);
        assert.strictEqual(body.ok, true);
      } finally {
        await teardown();
      }
    });

    test('wsConnections reflects connected sockets', async () => {
      const { server, teardown } = await setup();
      try {
        // No connections yet
        const r1 = await server.fetch('/health');
        const b1 = await json(r1);
        assert.strictEqual(b1.wsConnections, 0);

        // Add one SW + one dashboard
        const sw   = await createSWClient(server);
        const dash = await createDashboardClient(server);

        const r2 = await server.fetch('/health');
        const b2 = await json(r2);
        assert.strictEqual(b2.wsConnections, 2, 'SW + dashboard = 2');

        await sw.close();
        await dash.close();
      } finally {
        await teardown();
      }
    });

    test('sessions is an array', async () => {
      const { server, teardown } = await setup();
      try {
        const body = await json(await server.fetch('/health'));
        assert.ok(Array.isArray(body.sessions));
      } finally {
        await teardown();
      }
    });
  });

  // ── GET /api/config ─────────────────────────────────────────────────────────

  describe('GET /api/config', () => {
    test('returns 200 with config object', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/api/config');
        assert.strictEqual(res.status, 200);
        const body = await json(res);
        assert.ok(typeof body === 'object' && body !== null);
      } finally {
        await teardown();
      }
    });

    test('config contains mode and plugins fields', async () => {
      const { server, teardown } = await setup();
      try {
        const body = await json(await server.fetch('/api/config'));
        assert.ok('mode'    in body, 'config must have mode');
        assert.ok('plugins' in body, 'config must have plugins');
      } finally {
        await teardown();
      }
    });
  });

  // ── POST /api/config ─────────────────────────────────────────────────────────

  describe('POST /api/config', () => {
    test('returns { ok: true }', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/api/config', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ mode: 'manual' }),
        });
        assert.strictEqual(res.status, 200);
        const body = await json(res);
        assert.strictEqual(body.ok, true);
      } finally {
        await teardown();
      }
    });

    test('broadcasts SET_CONFIG to all connected SWs', async () => {
      const { server, teardown } = await setup();
      try {
        const sw = await createSWClient(server);

        const msgP = sw.nextMessage(m => m.type === 'SET_CONFIG', 2_000);

        await server.fetch('/api/config', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ mode: 'manual', custom: true }),
        });

        const msg = await msgP;
        assert.strictEqual(msg.type, 'SET_CONFIG');
        assert.ok(msg.config !== undefined, 'SET_CONFIG payload must be present');

        await sw.close();
      } finally {
        await teardown();
      }
    });

    test('broadcasts to ALL connected SWs (multi-SW)', async () => {
      const { server, teardown } = await setup();
      try {
        const sw1 = await createSWClient(server);
        const sw2 = await createSWClient(server);

        const p1 = sw1.nextMessage(m => m.type === 'SET_CONFIG', 2_000);
        const p2 = sw2.nextMessage(m => m.type === 'SET_CONFIG', 2_000);

        await server.fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'off' }),
        });

        await Promise.all([p1, p2]);

        await sw1.close();
        await sw2.close();
      } finally {
        await teardown();
      }
    });
  });

  // ── GET /api/sessions ───────────────────────────────────────────────────────

  describe('GET /api/sessions', () => {
    test('returns 200 with an array', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/api/sessions');
        assert.strictEqual(res.status, 200);
        const body = await json(res);
        assert.ok(Array.isArray(body), 'sessions must be an array');
      } finally {
        await teardown();
      }
    });

    test('returns empty array when no sessions exist', async () => {
      const { server, teardown } = await setup();
      try {
        const body = await json(await server.fetch('/api/sessions'));
        assert.strictEqual(body.length, 0);
      } finally {
        await teardown();
      }
    });
  });

  // ── POST /api/collect ───────────────────────────────────────────────────────

  describe('POST /api/collect', () => {
    test('returns { ok: true }', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/api/collect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tabId: 42 }),
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await json(res)).ok, true);
      } finally {
        await teardown();
      }
    });

    test('sends MANUAL_COLLECT to SW with correct tabId', async () => {
      const { server, teardown } = await setup();
      try {
        const sw   = await createSWClient(server);
        const msgP = sw.nextMessage(m => m.type === 'MANUAL_COLLECT', 2_000);

        await server.fetch('/api/collect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tabId: 99 }),
        });

        const msg = await msgP;
        assert.strictEqual(msg.type, 'MANUAL_COLLECT');
        assert.strictEqual(msg.tabId, 99);

        await sw.close();
      } finally {
        await teardown();
      }
    });
  });

  // ── POST /api/action ────────────────────────────────────────────────────────

  describe('POST /api/action', () => {
    test('sends EXECUTE_ACTION to SW, resolves when ACTION_RESULT received', async () => {
      const { server, teardown } = await setup();
      try {
        const sw = await createSWClient(server);

        // SW echoes back ACTION_RESULT when it receives EXECUTE_ACTION
        sw.ws.on('message', raw => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'EXECUTE_ACTION') {
            sw.send({ type: 'ACTION_RESULT', id: msg.id, result: { success: true } });
          }
        });

        const actionRes = await server.fetch('/api/action', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tabId: 1, action: { type: 'click', x: 100, y: 200 } }),
        });

        assert.strictEqual(actionRes.status, 200);
        const body = await json(actionRes);
        assert.strictEqual(body.ok, true);
        assert.deepStrictEqual(body.result, { success: true });

        await sw.close();
      } finally {
        await teardown();
      }
    });

    test('EXECUTE_ACTION includes tabId and action payload', async () => {
      const { server, teardown } = await setup();
      try {
        const sw = await createSWClient(server);
        const msgP = sw.nextMessage(m => m.type === 'EXECUTE_ACTION', 2_000);

        // Trigger without waiting for result
        server.fetch('/api/action', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tabId: 5, action: { type: 'scroll', deltaY: 300 } }),
        }).catch(() => {});

        const msg = await msgP;
        assert.strictEqual(msg.tabId, 5);
        assert.deepStrictEqual(msg.action, { type: 'scroll', deltaY: 300 });
        assert.ok(msg.id, 'EXECUTE_ACTION must have an id');

        // Clean up pending action to avoid server timeout
        sw.send({ type: 'ACTION_RESULT', id: msg.id, result: {} });

        await sw.close();
      } finally {
        await teardown();
      }
    });
  });

  // ── CORS preflight ──────────────────────────────────────────────────────────

  describe('OPTIONS preflight', () => {
    test('OPTIONS /api/config returns 204 with CORS headers', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/api/config', { method: 'OPTIONS' });
        assert.strictEqual(res.status, 204);
        assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
        assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
      } finally {
        await teardown();
      }
    });

    test('CORS header present on GET /health', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/health');
        assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      } finally {
        await teardown();
      }
    });
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  describe('Unknown routes', () => {
    test('GET /does-not-exist returns 404', async () => {
      const { server, teardown } = await setup();
      try {
        const res = await server.fetch('/does-not-exist');
        assert.strictEqual(res.status, 404);
        const body = await json(res);
        assert.strictEqual(body.ok, false);
      } finally {
        await teardown();
      }
    });
  });
});
