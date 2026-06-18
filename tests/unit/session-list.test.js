/**
 * tests/unit/session-list.test.js
 * Session list sort + search + paging — exercises the REAL server/session-list.js,
 * the module shared by GET /api/sessions and the get_sessions MCP tool.
 *
 * selectSessions is a pure transform over the array cache.getSessionList() returns,
 * so the logic is tested directly with plain objects (no cache/server needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectSessions } = require('../../server/session-list');

// updatedAt values are spaced so "recent" ordering is unambiguous.
const LIST = [
  { tabId: 1, url: 'https://mail.google.com/inbox', title: 'Gmail — Inbox',   updatedAt: 100, createdAt: 10, isStale: true,  keep: false },
  { tabId: 2, url: 'https://github.com/acme/repo',  title: 'acme/repo',       updatedAt: 300, createdAt: 30, isStale: false, keep: false },
  { tabId: 3, url: 'https://example.com/dashboard', title: 'Admin Dashboard', updatedAt: 200, createdAt: 20, isStale: false, keep: true  },
];

describe('session-list — default (no enhanced params)', () => {
  it('returns a BARE ARRAY (legacy contract), relevance-sorted', async () => {
    const res = await selectSessions(LIST);
    assert.ok(Array.isArray(res), 'must stay a bare array for backward compat');
    // relevance = pinned first (tab 3), then fresh-by-recency (tab 2), then stale (tab 1)
    assert.deepStrictEqual(res.map(s => s.tabId), [3, 2, 1]);
  });

  it('does not mutate the caller\'s array', async () => {
    const input = LIST.slice();
    await selectSessions(input);
    assert.deepStrictEqual(input.map(s => s.tabId), [1, 2, 3]);
  });

  it('sort=recent orders by updatedAt desc', async () => {
    const res = await selectSessions(LIST, { sort: 'recent' });
    assert.ok(Array.isArray(res));
    assert.deepStrictEqual(res.map(s => s.tabId), [2, 3, 1]);
  });
});

describe('session-list — search (item 5)', () => {
  it('exact mode filters by title/url substring and wraps the result', async () => {
    const res = await selectSessions(LIST, { q: 'github' });
    assert.ok(!Array.isArray(res), 'enhanced query returns an object');
    assert.strictEqual(res.total, 1);
    assert.strictEqual(res.sessions[0].tabId, 2);
    assert.strictEqual(res.query, 'github');
  });

  it('fuzzy mode scores and sorts; honours minScore', async () => {
    // token-oriented fuzzyScore (same as get_text_coords): partial words score
    // high, so "admin dash" isolates tab 3 while others fall below minScore.
    const res = await selectSessions(LIST, { q: 'admin dash', mode: 'fuzzy', minScore: 0.3 });
    assert.strictEqual(res.total, 1);
    assert.strictEqual(res.sessions[0].tabId, 3);
    assert.ok(typeof res.sessions[0].score === 'number');
    assert.strictEqual(res.sort, 'score');
  });

  it('semantic falls back to fuzzy with a note when no backend', async () => {
    const res = await selectSessions(LIST, { q: 'dashboard', mode: 'semantic' });
    assert.match(res.note || '', /fell back to fuzzy/i);
  });

  it('semantic uses a supplied backend (no fallback note)', async () => {
    const backend = { batchFuzzyScore: async (q, texts) => texts.map(t => (t.includes('Gmail') ? 0.9 : 0.0)) };
    const res = await selectSessions(LIST, { q: 'email', mode: 'semantic', backend });
    assert.strictEqual(res.sessions[0].tabId, 1);
    assert.strictEqual(res.note, undefined);
  });

  it('tabId does a direct lookup', async () => {
    const res = await selectSessions(LIST, { tabId: 2 });
    assert.strictEqual(res.total, 1);
    assert.strictEqual(res.sessions[0].tabId, 2);
  });
});

describe('session-list — paging (item 4)', () => {
  it('pages with page/pageSize and reports metadata', async () => {
    const res = await selectSessions(LIST, { sort: 'recent', page: 1, pageSize: 2 });
    assert.deepStrictEqual(res.sessions.map(s => s.tabId), [2, 3]);
    assert.strictEqual(res.total, 3);
    assert.strictEqual(res.totalPages, 2);
    assert.strictEqual(res.hasMore, true);
  });

  it('returns the last page and clamps page numbers past the end', async () => {
    const res = await selectSessions(LIST, { sort: 'recent', page: 9, pageSize: 2 });
    assert.strictEqual(res.page, 2);
    assert.deepStrictEqual(res.sessions.map(s => s.tabId), [1]);
    assert.strictEqual(res.hasMore, false);
  });

  it('page=all returns everything in one page', async () => {
    const res = await selectSessions(LIST, { page: 'all' });
    assert.strictEqual(res.total, 3);
    assert.strictEqual(res.sessions.length, 3);
    assert.strictEqual(res.totalPages, 1);
    assert.strictEqual(res.hasMore, false);
  });
});
