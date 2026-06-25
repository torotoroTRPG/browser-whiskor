/**
 * server/mcp/tools/read-helpers.js
 * Helper functions for READ tools: fuzzy matching and freshness wrapping.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Fuzzy text matching ──────────────────────────────────────────────────────
// Unicode-aware: \p{L} = any letter, \p{N} = any number (supports CJK, Hangul, etc.)
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
}

function bigramSet(str) {
  const s = str.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) { if (b.has(x)) inter++; }
  return inter / (a.size + b.size - inter);
}

function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (t.includes(q)) return 1.0;
  const qTok = new Set(tokenize(q));
  const tTok = new Set(tokenize(t));
  const tokenSim = jaccard(qTok, tTok);
  const qBi = bigramSet(q);
  const tBi = bigramSet(t);
  const bigramSim = jaccard(qBi, tBi);
  const bw = q.length < 5 ? 0.6 : 0.3;
  return Math.round((tokenSim * (1 - bw) + bigramSim * bw) * 1000) / 1000;
}

// ── Intent classifier ────────────────────────────────────────────────────────
let _anchors = null;

function loadAnchors() {
  if (_anchors) return _anchors;
  try {
    const p = path.join(__dirname, '../../configs/intent-anchors.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    _anchors = {};
    for (const [intent, words] of Object.entries(raw)) {
      if (intent.startsWith('_')) continue;
      _anchors[intent] = words.map(w => normalizeLabel(w));
    }
    return _anchors;
  } catch (e) {
    _anchors = {};
    return _anchors;
  }
}

function normalizeLabel(str) {
  return (str || '').normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function intentFuzzyScore(q, t) {
  if (t === q) return 1.0;
  if (t.includes(q) || q.includes(t)) return 0.95;
  const qBi = bigramSet(q);
  const tBi = bigramSet(t);
  const bSim = jaccard(qBi, tBi);
  const maxLen = Math.max(q.length, t.length) || 1;
  const eSim = 1 - levenshtein(q, t) / maxLen;
  return Math.round((bSim * 0.6 + eSim * 0.4) * 1000) / 1000;
}

/**
 * UIラベルテキストを意味的インテントに分類する。
 * @param {string} label - 任意言語のUIラベル
 * @param {number} threshold - スコアの下限（デフォルト 0.35）
 * @returns {{ intent: string, confidence: number, topAnchor: string } | null}
 */
function classifyIntent(label, threshold = 0.35) {
  const anchors = loadAnchors();
  const normalized = normalizeLabel(label);
  if (!normalized) return null;

  let best = { intent: 'UNKNOWN', score: 0, anchor: '' };

  for (const [intent, words] of Object.entries(anchors)) {
    for (const anchor of words) {
      const score = intentFuzzyScore(normalized, anchor);
      if (score > best.score) {
        best = { intent, score, anchor };
      }
      if (score >= 1.0) break;
    }
  }

  if (best.score < threshold) return null;
  return { intent: best.intent, confidence: best.score, topAnchor: best.anchor };
}

/**
 * Filter elements by viewport intersection.
 * @param {Array} elements - Array of elements with x, y, width, height properties
 * @param {Object} viewport - { scrollX, scrollY, width, height }
 * @returns {Array} Filtered elements within viewport
 */
function filterByViewport(elements, viewport) {
  if (!viewport || !elements) return elements;
  return elements.filter(el => {
    const x = el.x ?? el.left ?? el.absoluteX ?? 0;
    const y = el.y ?? el.top ?? el.absoluteY ?? 0;
    const w = el.width ?? el.w ?? 0;
    const h = el.height ?? el.h ?? 0;
    return !(x + w < viewport.scrollX || x > viewport.scrollX + viewport.width ||
             y + h < viewport.scrollY || y > viewport.scrollY + viewport.height);
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function withFreshness(tabId, pluginId, data, cache) {
  if (!data) return null;
  const info = cache.freshnessInfo(tabId, pluginId);
  const warnings = [];

  if (info && info.isStale) {
    warnings.push({
      code: 'STALE_DATA',
      ageMs: info.ageMs,
      message: `Data is ${Math.round(info.ageMs / 1000)}s old (threshold: 30s). Consider calling refresh_data.`,
    });
  }

  if (data.note) {
    warnings.push({ code: 'ADAPTER_LIMITED', message: data.note });
  }

  if (pluginId === 'solid' && data) {
    if (!data.ownerTree && !data.stores && !data.signals && data.hydrationKeys?.length === 0) {
      warnings.push({ code: 'PARTIAL_TREE', message: 'SolidJS:only hydration markers found. Owner tree, stores, and signals not available (likely production build).' });
    }
  }
  if (pluginId === 'svelte' && data) {
    if (!data.components?.length && !data.ownerTree && !data.stores && data.scopedHashes?.length) {
      warnings.push({ code: 'PARTIAL_TREE', message: 'Svelte: only CSS scoping hashes found. Component instances not accessible (production build limitation).' });
    }
  }
  if (pluginId === 'preact' && data) {
    if (!data.componentTree && data.detectionNote) {
      warnings.push({ code: 'PARTIAL_TREE', message: data.detectionNote });
    }
  }

  if (warnings.length > 0) {
    return { ...data, _freshness: info, _warnings: warnings };
  }
  return { ...data, _freshness: info };
}

// ── Source-recovery hint ─────────────────────────────────────────────────────
// When a framework snapshot comes from a production / minified build, the
// component names, file paths, and line numbers an agent wants are NOT in the
// DOM or Fiber tree — they were stripped at build time. But they ARE recoverable
// from the page's shipped JS (and sourcemaps, if served). Agents repeatedly
// conclude "this is impossible" because they don't know capture_sources exists.
// This helper detects the minified case and returns a pointer to that capability.
// The wording names the MCP tool AND the HTTP endpoint so it's useful no matter
// which interface (MCP / HTTP / whk CLI) the agent is driving.

// React built-in / wrapper names that are NOT user components — exclude from the
// minified-ratio so a tree full of Context.Provider doesn't read as "minified".
const REACT_BUILTINS = new Set([
  'Anonymous', 'Context.Provider', 'Context.Consumer', 'Memo', 'Mode',
  'Suspense', 'SuspenseList', 'Offscreen', 'Profiler', 'Fragment',
  'ForwardRef', 'Lazy', 'Portal', 'StrictMode', 'Router', 'Routes', 'Route',
]);

// A real (non-weak) component name that is ≤3 chars and not a known built-in
// looks like a minifier output (e.g. "O", "lH", "Vwe", "Kde").
function _looksMinifiedName(n) {
  if (!n || REACT_BUILTINS.has(n)) return false;
  if (n.indexOf('.') >= 0) return false; // namespaced (e.g. Foo.Provider)
  return /^[A-Za-z_$][\w$]{0,2}$/.test(n);
}

// Walk a serialized component tree (nodes keyed { n, w, c }) and return the
// fraction of real, named components whose names look minified.
function _minifiedRatio(tree) {
  let total = 0, mini = 0, budget = 400;
  const stack = Array.isArray(tree) ? [...tree] : (tree ? [tree] : []);
  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const name = node.n;
    // Count only real names (w flag = derived/fallback, not a true displayName).
    if (name && !node.w && !REACT_BUILTINS.has(name)) {
      total++;
      if (_looksMinifiedName(name)) mini++;
    }
    if (Array.isArray(node.c)) for (const c of node.c) stack.push(c);
  }
  return total >= 4 ? mini / total : 0;
}

// Returns a hint object when `data` (a framework snapshot) is from a minified /
// production build, else null. `pluginId` is the freshness plugin id.
function sourceRecoveryHint(pluginId, data) {
  if (!data || typeof data !== 'object') return null;

  let minified = false;
  if (data.buildType === 'production') {
    minified = true;                       // React: authoritative
  } else if (data.buildType === 'development') {
    return null;                           // names are real — no hint needed
  } else if (_minifiedRatio(data.componentTree || data.tree) > 0.5) {
    minified = true;                       // other frameworks: name heuristic
  }
  if (!minified) return null;

  return {
    code: 'MINIFIED_BUILD',
    message:
      'Production/minified build: component names, file paths, and line numbers ' +
      'are stripped from the DOM/Fiber and cannot be read here. They are still ' +
      'recoverable from the page\'s shipped JS. Capture the bundles (and ' +
      'sourcemaps, if served) with the `capture_sources` tool — equivalently ' +
      '`POST /api/source/capture {"tabId":N}` over HTTP / whk — then read slices ' +
      'with `get_source_context` (`POST /api/source/context`). Requires the ' +
      'browser DevTools panel open on the tab.',
  };
}

module.exports = { tokenize, bigramSet, jaccard, fuzzyScore, classifyIntent, withFreshness, filterByViewport, sourceRecoveryHint };
