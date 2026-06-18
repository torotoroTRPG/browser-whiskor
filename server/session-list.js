/**
 * server/session-list.js
 *
 * Sort + search + paginate the session list (one entry per whiskor-active tab).
 * This is the "make get_sessions usable when there are many tabs" layer: it turns
 * cache.getSessionList()'s flat array into a relevance-ordered, optionally
 * searched and paged view.
 *
 * Reuses the same three matching layers as get_text_coords / search_all_tabs,
 * but here the haystack is each tab's title + url (cheap metadata) rather than
 * its collected page text:
 *   - exact    : case-insensitive substring
 *   - fuzzy    : read-helpers.fuzzyScore (token/bigram similarity, no model)
 *   - semantic : MiniLM backend.batchFuzzyScore (when a backend is supplied)
 *
 * Shared by the HTTP endpoint (GET /api/sessions) and the MCP tool (get_sessions)
 * so both behave identically.
 *
 * Return shape is backward compatible: with no "enhanced" params (q / page /
 * pageSize / tabId) it returns the *bare array* the old endpoint returned — just
 * relevance-sorted. As soon as any of those params is supplied it returns an
 * object { sessions, total, page, ... } so the caller can page deliberately.
 */
'use strict';

const { fuzzyScore } = require('./mcp/tools/read-helpers');

const VALID_SORTS = new Set(['relevant', 'recent', 'created', 'title', 'url']);
const VALID_MODES = new Set(['exact', 'fuzzy', 'semantic']);

function round3(n) { return Math.round(n * 1000) / 1000; }

// Item 5 searches a tab by what the user recognises it as: its title and URL.
function haystack(s) {
  return `${s.title || ''} ${s.url || ''}`.trim();
}

// "Most relevant first" with only the signals the session list actually carries
// (there is no per-tab "currently focused" signal at this layer): pinned tabs
// first, then fresh before stale, then most-recently-updated.
function byRelevance(a, b) {
  const pin = (b.keep ? 1 : 0) - (a.keep ? 1 : 0);
  if (pin) return pin;
  const stale = (a.isStale ? 1 : 0) - (b.isStale ? 1 : 0);
  if (stale) return stale;
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function comparator(sortKey) {
  switch (sortKey) {
    case 'recent':  return (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    case 'created': return (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    case 'title':   return (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
    case 'url':     return (a, b) => String(a.url || '').localeCompare(String(b.url || ''));
    case 'relevant':
    default:        return byRelevance;
  }
}

/**
 * @param {Array}  rawList - entries from cache.getSessionList()
 *                           ({ tabId, url, title, createdAt, updatedAt, isStale, keep, ... })
 * @param {object} opts    - { q, mode, sort, minScore, page, pageSize, tabId, backend }
 * @returns {Promise<Array|object>} bare array (legacy) when no enhanced params,
 *                                  else { sessions, total, returned, page, pageSize,
 *                                         totalPages, hasMore, sort, query?, mode?, note? }
 */
async function selectSessions(rawList, opts = {}) {
  let list = Array.isArray(rawList) ? rawList.slice() : [];

  const q        = opts.q != null ? String(opts.q).trim() : '';
  const mode     = VALID_MODES.has(opts.mode) ? opts.mode : 'exact';
  const sortKey  = VALID_SORTS.has(opts.sort) ? opts.sort : 'relevant';
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0.3;
  const backend  = opts.backend || null;
  const hasTabId = opts.tabId != null && String(opts.tabId) !== '';
  const pagingRequested = opts.page != null || opts.pageSize != null;

  // Any of these means the caller wants the richer, metadata-wrapped response.
  const enhanced = !!q || pagingRequested || hasTabId;

  let note = null;

  // 1. Direct tabId lookup (item 5: "ID search").
  if (hasTabId) {
    const tid = Number(opts.tabId);
    list = list.filter(s => s.tabId === tid);
  }

  // 2. Search over title + url (item 5: fuzzy / semantic / exact).
  let scored = false;
  if (q) {
    if (mode === 'exact') {
      const needle = q.toLowerCase();
      list = list.filter(s => haystack(s).toLowerCase().includes(needle));
    } else {
      // fuzzy / semantic both score each tab; semantic uses the MiniLM backend
      // when available and otherwise transparently falls back to fuzzy.
      let scores;
      const texts = list.map(haystack);
      if (mode === 'semantic' && backend && backend.batchFuzzyScore) {
        scores = await backend.batchFuzzyScore(q, texts);
      } else {
        scores = texts.map(t => fuzzyScore(q, t));
        if (mode === 'semantic') note = 'Semantic backend unavailable — fell back to fuzzy matching.';
      }
      list = list
        .map((s, idx) => ({ s, score: scores[idx] }))
        .filter(o => o.score >= minScore)
        .map(o => ({ ...o.s, score: round3(o.score) }));
      scored = true;
    }
  }

  // 3. Sort. Scored searches lead with score; everything else uses the chosen key.
  if (scored) {
    list.sort((a, b) => (b.score - a.score) || byRelevance(a, b));
  } else {
    list.sort(comparator(sortKey));
  }

  // 4. Page (item 4). Opt-in: with no paging params we return the whole list so a
  //    discovery call never silently hides tabs. page='all'/'full' also returns all.
  const total = list.length;
  let pageNum = 1;
  let pageSize = opts.pageSize != null ? Math.max(1, Number(opts.pageSize)) : 20;
  let totalPages = 1;
  let hasMore = false;
  let pageItems = list;
  const wantAll = opts.page === 'all' || opts.page === 'full';

  if (pagingRequested && !wantAll) {
    totalPages = Math.max(1, Math.ceil(total / pageSize));
    pageNum = Math.max(1, parseInt(opts.page, 10) || 1);
    if (pageNum > totalPages) pageNum = totalPages;
    const start = (pageNum - 1) * pageSize;
    pageItems = list.slice(start, start + pageSize);
    hasMore = pageNum < totalPages;
  } else if (wantAll) {
    pageSize = total;
  }

  // 5. Shape the response. Bare array keeps every legacy consumer working.
  if (!enhanced) return list;

  return {
    sessions:   pageItems,
    total,
    returned:   pageItems.length,
    page:       pageNum,
    pageSize,
    totalPages,
    hasMore,
    sort:       scored ? 'score' : sortKey,
    ...(q ? { query: q, mode } : {}),
    ...(note ? { note } : {}),
  };
}

module.exports = { selectSessions };
