/**
 * server/mcp/tools/read-helpers.js
 * Helper functions for READ tools: fuzzy matching and freshness wrapping.
 */
'use strict';

// ── Fuzzy text matching ──────────────────────────────────────────────────────
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

function bigramSet(str) {
  const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
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

module.exports = { tokenize, bigramSet, jaccard, fuzzyScore, withFreshness };
