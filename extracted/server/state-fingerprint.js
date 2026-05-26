/**
 * server/state-fingerprint.js
 *
 * Unified hash engine for browser-whiskor v3 state tracking.
 *
 * Provides deterministic, non-deterministic-filtered hashes for:
 *   - DOM state (URL + interactive elements)
 *   - React state (component tree shape + router + store keys)
 *   - Composite hash (combines both, React-priority)
 *
 * Algorithm: FNV-1a 32bit → base-36 string (7 chars)
 */
'use strict';

// ── FNV-1a 32bit ─────────────────────────────────────────────────────────────

function fnv32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

// ── Canonical JSON (sorted keys, deterministic) ──────────────────────────────

function canonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'boolean') return obj ? '1' : '0';
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  if (typeof obj !== 'object') return String(obj);
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

// ── Non-Deterministic Filter ─────────────────────────────────────────────────

const TS_PATTERN = /^\d{13}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_RANDOM_PATTERN = /^[a-zA-Z0-9_-]{32,}$/;

const DEFAULT_EXCLUDE_KEYS = new Set([
  'createdAt', 'updatedAt', 'timestamp', 'lastSeen', 'capturedAt',
  'requestId', 'nonce', 'csrf', 'expiresAt', 'lastModified', '_id',
  'firstSeen', 'visitCount',
]);

function filterNd(obj, config = {}, depth = 0) {
  if (depth > 5) return '__DEEP__';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    if (TS_PATTERN.test(String(obj))) return '__TS__';
    return obj;
  }
  if (typeof obj === 'string') {
    if (UUID_PATTERN.test(obj)) return '__UUID__';
    if (LONG_RANDOM_PATTERN.test(obj)) return '__RAND__';
    return obj;
  }
  if (typeof obj === 'boolean') return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.slice(0, 20).map(item => filterNd(item, config, depth + 1));
  }

  const excludeKeys = config.excludeKeys
    ? new Set([...DEFAULT_EXCLUDE_KEYS, ...config.excludeKeys])
    : DEFAULT_EXCLUDE_KEYS;

  const out = {};
  for (const k of Object.keys(obj)) {
    if (excludeKeys.has(k)) continue;
    out[k] = filterNd(obj[k], config, depth + 1);
  }
  return out;
}

// ── DOM Hash ─────────────────────────────────────────────────────────────────
// Must match the logic in explorer.js:computeDomHash() exactly.

function computeDomHash(pathname, search, interactiveElements) {
  const parts = [(pathname || '') + (search || '')];
  const domSig = (interactiveElements || []).slice(0, 50)
    .map(el => (el.tag || '') + ':' + (el.text || '').slice(0, 20));
  parts.push(domSig.join('|'));
  return fnv32(parts.join('|||'));
}

// ── React Hash ───────────────────────────────────────────────────────────────

function computeReactHash(treeShape, routerPathname, reduxKeys, config = {}) {
  const slim = {
    tree: treeShape || null,
    router: routerPathname || '/',
    reduxKeys: (reduxKeys || []).sort(),
  };
  const filtered = filterNd(slim, config);
  return fnv32(canonicalize(filtered));
}

// ── Composite Hash ───────────────────────────────────────────────────────────

function computeCompositeHash(reactHash, domHash) {
  if (reactHash) return fnv32(reactHash + '|' + domHash);
  return domHash;
}

// ── Get tree shape from serialized Fiber node (lightweight) ──────────────────

function getTreeShape(node) {
  if (!node) return null;
  const props = {};
  if (node.p) {
    for (const k in node.p) {
      const v = node.p[k];
      if (typeof v !== 'object' && typeof v !== 'function') {
        props[k] = v;
      }
    }
  }
  return {
    n: node.n,
    p: props,
    c: node.c ? node.c.map(child => getTreeShape(child)) : [],
  };
}

// ── Extract Redux/Zustand top-level keys ─────────────────────────────────────

function getStoreKeys(snapshot) {
  const keys = [];
  if (snapshot.redux && typeof snapshot.redux === 'object') {
    keys.push(...Object.keys(snapshot.redux).map(k => 'redux:' + k));
  }
  if (Array.isArray(snapshot.zustand)) {
    snapshot.zustand.forEach((store, i) => {
      if (store && typeof store === 'object') {
        keys.push(...Object.keys(store).map(k => 'zustand[' + i + ']:' + k));
      }
    });
  }
  return keys;
}

module.exports = {
  fnv32,
  canonicalize,
  filterNd,
  computeDomHash,
  computeReactHash,
  computeCompositeHash,
  getTreeShape,
  getStoreKeys,
};
