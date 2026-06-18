/**
 * tests/unit/session-search.test.js
 * Cross-session text search — exercises the REAL server/session-search.js, the
 * module shared by the HTTP GET /api/search route and the search_all_tabs MCP tool.
 *
 * Uses a tiny in-memory cache stub matching the (getSessionList, readSessionFile)
 * shape both real caches expose, so the matching/ranking logic is tested directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { searchSessions } = require('../../server/session-search');

// Cache stub: tab 1 holds "Login"/"iwabi", tab 2 holds unrelated words.
function makeCache(files) {
  const list = Object.keys(files).map(Number).map(tabId => ({
    tabId, url: `https://tab${tabId}.test`, title: `Tab ${tabId}`, isStale: false,
  }));
  return {
    getSessionList: () => list,
    readSessionFile: async (tabId) => files[tabId] || null,
  };
}

const CACHE = makeCache({
  1: { words: [
    { text: 'Login',  left: 10, top: 20 },
    { text: 'iwabi',  left: 30, top: 40 },
    { text: 'Submit', left: 50, top: 60 },
  ] },
  2: { words: [
    { text: 'unrelated', left: 1, top: 2 },
    { text: 'content',   left: 3, top: 4 },
  ] },
});

describe('session-search — exact mode', () => {
  it('returns only the tab containing the query, with coordinates', async () => {
    const out = await searchSessions(CACHE, { q: 'iwabi', mode: 'exact' });
    assert.equal(out.tabsScanned, 2);
    assert.equal(out.hitCount, 1);
    assert.equal(out.results[0].tabId, 1);
    const m = out.results[0].matches[0];
    assert.equal(m.text, 'iwabi');
    assert.equal(m.x, 30);
    assert.equal(m.y, 40);
  });

  it('is case-insensitive', async () => {
    const out = await searchSessions(CACHE, { q: 'LOGIN', mode: 'exact' });
    assert.equal(out.hitCount, 1);
    assert.equal(out.results[0].matches[0].text, 'Login');
  });

  it('requires a query', async () => {
    const out = await searchSessions(CACHE, { q: '   ' });
    assert.equal(out.error, 'q (query) is required');
    assert.equal(out.hitCount, 0);
  });
});

describe('session-search — fuzzy mode', () => {
  it('scores and sorts matches, honouring minScore', async () => {
    const out = await searchSessions(CACHE, { q: 'login', mode: 'fuzzy', minScore: 0.3 });
    assert.equal(out.hitCount, 1);
    const top = out.results[0].matches[0];
    assert.ok(top.score > 0, 'fuzzy match carries a score');
    assert.equal(top.text, 'Login');
  });
});

describe('session-search — semantic fallback', () => {
  it('falls back to fuzzy with a note when no backend is supplied', async () => {
    const out = await searchSessions(CACHE, { q: 'login', mode: 'semantic', minScore: 0.3 });
    assert.match(out.note || '', /Semantic backend unavailable/);
    assert.equal(out.hitCount, 1);
  });

  it('uses a supplied backend.batchFuzzyScore when present (no fallback note)', async () => {
    // Fake MiniLM backend: scores by index so we can assert it was consulted.
    const backend = {
      batchFuzzyScore: async (_q, texts) => texts.map(t => (t === 'iwabi' ? 0.9 : 0.0)),
    };
    const out = await searchSessions(CACHE, { q: 'anything', mode: 'semantic', minScore: 0.5, backend });
    assert.equal(out.note, undefined);
    assert.equal(out.hitCount, 1);
    assert.equal(out.results[0].matches[0].text, 'iwabi');
    assert.equal(out.results[0].matches[0].score, 0.9);
  });
});

describe('session-search — ranking', () => {
  it('orders tabs by top match score', async () => {
    const cache = makeCache({
      1: { words: [{ text: 'apple', left: 0, top: 0 }] },
      2: { words: [{ text: 'apple', left: 0, top: 0 }, { text: 'apple pie', left: 1, top: 1 }] },
    });
    const out = await searchSessions(cache, { q: 'apple', mode: 'exact' });
    assert.equal(out.hitCount, 2);
    // Exact mode ranks by matchCount → tab 2 (two matches) first.
    assert.equal(out.results[0].tabId, 2);
  });
});
