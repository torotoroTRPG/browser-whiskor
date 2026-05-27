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

module.exports = { tokenize, bigramSet, jaccard, fuzzyScore, classifyIntent, withFreshness, filterByViewport };
