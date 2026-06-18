/**
 * tests/unit/mcp-read.test.js
 * Section 4.2 — Read Tools
 *
 * Exercises the REAL read-tool handlers (server/mcp/tools/read-basic.js) by
 * capturing them through a lightweight registry and driving them with a mock
 * `cb.cache`. This verifies the actual extraction / warning / error logic —
 * not an inline re-implementation of it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Capture the tools a register function emits into a name→tool map.
function captureTools(registerFn) {
  const map = {};
  const registry = {
    registerTools(arr) { for (const t of arr) map[t.definition.name] = t; },
    registerTool(def, handler) { map[def.name] = { definition: def, handler }; },
  };
  registerFn(registry);
  return map;
}

const readTools = captureTools(require('../../server/mcp/tools/read-basic'));

// Build a cb whose cache returns whatever the test wants.
function cbWith(cache) {
  return { cache, _config: {}, _toolManager: null };
}

describe('4.2 get_sessions', () => {
  it('returns a NO_ACTIVE_SESSIONS warning (not just an empty array) when nothing is connected', async () => {
    const res = await readTools['get_sessions'].handler({}, cbWith({
      getSessionList: async () => [],
    }));
    assert.deepStrictEqual(res.sessions, []);
    assert.ok(Array.isArray(res._warnings));
    assert.strictEqual(res._warnings[0].code, 'NO_ACTIVE_SESSIONS');
  });

  it('returns the live session list as a bare (relevance-sorted) array when no query params', async () => {
    // With no q/page/tabId, get_sessions keeps the legacy bare-array contract,
    // now relevance-sorted via session-list.selectSessions (a copy, not the
    // original reference, since it sorts without mutating the caller's array).
    const list = [
      { tabId: 1, url: 'https://x', title: 'X', updatedAt: 100, isStale: false, keep: false },
      { tabId: 2, url: 'https://y', title: 'Y', updatedAt: 200, isStale: false, keep: true  },
    ];
    const res = await readTools['get_sessions'].handler({}, cbWith({
      getSessionList: async () => list,
    }));
    assert.ok(Array.isArray(res), 'must remain a bare array');
    assert.deepStrictEqual(res.map(s => s.tabId), [2, 1], 'pinned tab first');
  });

  it('wraps the result with paging metadata when a query param is given', async () => {
    const list = [
      { tabId: 1, url: 'https://github.com', title: 'GitHub', updatedAt: 100, isStale: false, keep: false },
      { tabId: 2, url: 'https://gmail.com',  title: 'Gmail',  updatedAt: 200, isStale: false, keep: false },
    ];
    const res = await readTools['get_sessions'].handler({ q: 'github' }, cbWith({
      getSessionList: async () => list,
    }));
    assert.ok(!Array.isArray(res), 'enhanced query returns an object');
    assert.strictEqual(res.total, 1);
    assert.strictEqual(res.sessions[0].tabId, 1);
  });
});

describe('4.2 get_index', () => {
  it('errors (mentioning the tabId) when the session is unknown', async () => {
    const res = await readTools['get_index'].handler({ tabId: 99 }, cbWith({
      getSessionData: async () => null,
    }));
    assert.match(res.error, /99/);
  });

  it('returns the session index when present', async () => {
    const data = { tabId: 7, files: ['raw/visual/text-coords.json'] };
    const res = await readTools['get_index'].handler({ tabId: 7 }, cbWith({
      getSessionData: async (id) => (id === 7 ? data : null),
    }));
    assert.strictEqual(res, data);
  });
});

describe('4.2 get_text_coords', () => {
  it('errors with a refresh hint when TEXT_COORDS has not been collected', async () => {
    const res = await readTools['get_text_coords'].handler({ tabId: 1 }, cbWith({
      readSessionFile: async () => null,
    }));
    assert.match(res.error, /TEXT_COORDS|refresh_data/);
  });
});
