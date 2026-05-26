/**
 * server/conclusion-cache.js
 *
 * In-memory LRU cache for Intelligence Layer conclusions.
 *
 * Avoids redundant re-computation of explain_element when the underlying
 * page state has not changed since the last call.
 *
 * Invalidation key = SHA-256( compositeHash + cssOriginHash + frameworkMapHash )
 *
 * Capacity: 100 entries per tab.  Not persisted; rebuilt on server restart.
 */
'use strict';

const { createHash } = require('crypto');
const fs   = require('fs');

const MAX_ENTRIES_PER_TAB = 100;

// tabId (string/number) → Map<selector, CacheEntry>
// Map preserves insertion order — entries inserted earliest are evicted first.
const _store = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getMap(tabId) {
  const key = String(tabId);
  if (!_store.has(key)) _store.set(key, new Map());
  return _store.get(key);
}

function _evict(map) {
  while (map.size > MAX_ENTRIES_PER_TAB) {
    map.delete(map.keys().next().value);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the invalidation key from three hash components.
 * Any component may be null/undefined; absent components contribute an empty
 * string so missing data doesn't silently reuse a stale result.
 */
function buildInvalidationKey(compositeHash, cssOriginContentHash, frameworkMapContentHash) {
  return createHash('sha256')
    .update(String(compositeHash           || ''))
    .update('\x00')
    .update(String(cssOriginContentHash    || ''))
    .update('\x00')
    .update(String(frameworkMapContentHash || ''))
    .digest('hex');
}

/**
 * Look up a cached result.
 * Returns the cached ExplainElementResponse, or null on miss / stale.
 */
function get(tabId, selector, invalidationKey) {
  const map   = _getMap(tabId);
  const entry = map.get(selector);
  if (!entry)                                       return null;
  if (entry.invalidationKey !== invalidationKey)    return null;

  // Refresh LRU position: delete then re-insert so this entry moves to end.
  map.delete(selector);
  map.set(selector, entry);
  return entry.result;
}

/**
 * Store a result.  Evicts oldest entry if capacity is exceeded.
 */
function set(tabId, selector, invalidationKey, result) {
  const map = _getMap(tabId);
  // Remove any existing entry to refresh LRU position.
  map.delete(selector);
  map.set(selector, {
    invalidationKey,
    computedAt: Date.now(),
    result,
  });
  _evict(map);
}

/**
 * Drop all entries for a tab (e.g. on PAGE_NAVIGATED).
 */
function invalidate(tabId) {
  _store.delete(String(tabId));
}

/**
 * Derive a short content hash from a session file path.
 * Used to build the invalidation key cheaply without reading the full file.
 * Returns null if the file does not exist or cannot be stat'd.
 */
function fileContentHash(filePath) {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    // mtime + size is a fast proxy for content identity.
    // SHA-256 of the actual file would be more robust but slower for large files.
    return createHash('sha256')
      .update(String(stat.mtimeMs))
      .update(String(stat.size))
      .digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

module.exports = { buildInvalidationKey, get, set, invalidate, fileContentHash };
