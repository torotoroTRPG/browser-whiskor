/**
 * server/session-search.js
 *
 * Cross-session text search: scan every whiskor-active tab's collected text and
 * report which tabs contain a query — in one call, instead of fetching each tab's
 * text-coords.json and grepping it by hand.
 *
 * Reuses the same three matching layers as get_text_coords:
 *   - exact    : case-insensitive substring
 *   - fuzzy    : read-helpers.fuzzyScore (token/bigram similarity, no model)
 *   - semantic : MiniLM backend.batchFuzzyScore (when a backend is supplied)
 *
 * Shared by the HTTP endpoint (GET /api/search) and the MCP tool (search_all_tabs),
 * so both behave identically.
 */
'use strict';

const { fuzzyScore } = require('./mcp/tools/read-helpers');

// text-coords items carry absolute coords under a few historical field names
// (Tesseract-style left/top, plus absoluteX/absoluteY). Mirror secret-guard.rectOf.
function coordsOf(it) {
  const x = it.absoluteX ?? it.left ?? it.x ?? it.viewportX ?? it.rect?.x;
  const y = it.absoluteY ?? it.top ?? it.y ?? it.viewportY ?? it.rect?.y;
  return (typeof x === 'number' && typeof y === 'number') ? { x, y } : {};
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * @param {object} cache  - cache-writer-like ({ getSessionList, readSessionFile })
 * @param {object} opts   - { q, mode, level, minScore, maxPerTab, backend }
 * @returns {Promise<object>} { query, mode, level, tabsScanned, hitCount, results }
 */
async function searchSessions(cache, opts = {}) {
  const query = String(opts.q || '').trim();
  const mode = ['exact', 'fuzzy', 'semantic'].includes(opts.mode) ? opts.mode : 'exact';
  const level = ['words', 'lines', 'blocks'].includes(opts.level) ? opts.level : 'words';
  const minScore = opts.minScore != null ? Number(opts.minScore) : 0.3;
  const maxPerTab = opts.maxPerTab != null ? Math.max(1, Number(opts.maxPerTab)) : 20;
  const backend = opts.backend || null;

  if (!query) return { query, mode, level, tabsScanned: 0, hitCount: 0, results: [], error: 'q (query) is required' };

  const sessions = (await cache.getSessionList()) || [];
  const results = [];

  for (const s of sessions) {
    const tabId = s.tabId;
    let raw = null;
    try { raw = await cache.readSessionFile(tabId, 'raw/visual/text-coords.json'); } catch (_) { /* skip */ }
    if (!raw) continue;
    const items = raw[level] || raw.words || [];
    if (!items.length) continue;

    let matches = [];
    if (mode === 'exact') {
      const q = query.toLowerCase();
      matches = items
        .filter(i => typeof i.text === 'string' && i.text.toLowerCase().includes(q))
        .slice(0, maxPerTab)
        .map(i => ({ text: i.text, level, ...coordsOf(i) }));
    } else {
      // fuzzy / semantic both produce scored items; semantic uses the MiniLM
      // backend when available, otherwise transparently falls back to fuzzy.
      let scores;
      if (mode === 'semantic' && backend && backend.batchFuzzyScore) {
        scores = await backend.batchFuzzyScore(query, items.map(i => i.text || ''));
      } else {
        scores = items.map(i => fuzzyScore(query, i.text || ''));
      }
      matches = items
        .map((i, idx) => ({ i, score: scores[idx] }))
        .filter(o => o.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPerTab)
        .map(o => ({ text: o.i.text, level, score: round3(o.score), ...coordsOf(o.i) }));
    }

    if (matches.length) {
      results.push({ tabId, url: s.url, title: s.title, isStale: s.isStale, matchCount: matches.length, matches });
    }
  }

  // Most-relevant tab first: by top match score (scored modes) or match count (exact).
  results.sort((a, b) => {
    const sa = a.matches[0]?.score ?? a.matchCount;
    const sb = b.matches[0]?.score ?? b.matchCount;
    return sb - sa;
  });

  const out = { query, mode, level, tabsScanned: sessions.length, hitCount: results.length, results };
  if (mode === 'semantic' && !(backend && backend.batchFuzzyScore)) out.note = 'Semantic backend unavailable — fell back to fuzzy matching.';
  return out;
}

module.exports = { searchSessions };
