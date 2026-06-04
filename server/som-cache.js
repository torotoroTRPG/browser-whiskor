/**
 * server/som-cache.js
 *
 * Freshness-aware cache for packed Set-of-Marks results (slice 2). A packed
 * capture is expensive (captureVisibleTab + per-element canvas crops), so when
 * the agent re-requests it on a page that has NOT changed since the last capture,
 * serve the cached image + marks instead of re-capturing.
 *
 * "Changed" is driven by the collection signals the server already receives:
 * DOM mutations, navigations, and fresh text-coords bump the tab's lastChangeAt.
 * A cache entry is fresh only if it was captured at/after that timestamp — so any
 * page change (the exact isolation cache-sensitive flows need) invalidates it.
 *
 * Bounded LRU over tabs; entries are dropped on tab close/navigation.
 */
'use strict';

function createSomCache(opts = {}) {
  const maxTabs = opts.maxTabs || 20;
  const ttlMs   = opts.ttlMs != null ? opts.ttlMs : 5 * 60 * 1000; // hard cap so nothing goes truly stale

  /** @type {Map<number, {dataUrl, marks, filePath, capturedAt}>} */
  const entries = new Map();      // tabId → cached packed result (LRU by insertion/use order)
  const lastChangeAt = new Map(); // tabId → timestamp of the last observed change
  let hits = 0, misses = 0;

  function _touch(tabId) {
    // Move to the most-recently-used position.
    const v = entries.get(tabId);
    if (v !== undefined) { entries.delete(tabId); entries.set(tabId, v); }
  }

  function _evict() {
    while (entries.size > maxTabs) {
      const oldest = entries.keys().next().value; // first = least recently used
      entries.delete(oldest);
    }
  }

  /** Record that a tab's page changed (mutation / navigation / fresh collection). */
  function markChanged(tabId, now = Date.now()) {
    if (tabId == null) return;
    lastChangeAt.set(tabId, now);
  }

  /** Drop a tab's cache entirely (tab closed or navigated away). */
  function evictTab(tabId) {
    entries.delete(tabId);
    lastChangeAt.delete(tabId);
  }

  /**
   * Return a fresh cached result for the tab, or null. Fresh = captured at/after
   * the tab's last change AND within the TTL.
   */
  function get(tabId, now = Date.now()) {
    const e = entries.get(tabId);
    if (!e) { misses++; return null; }
    const changed = lastChangeAt.get(tabId) || 0;
    const stale = e.capturedAt < changed || (ttlMs > 0 && now - e.capturedAt > ttlMs);
    if (stale) { misses++; return null; }
    hits++;
    _touch(tabId);
    return e;
  }

  /** Store a freshly captured packed result for the tab. */
  function set(tabId, value, now = Date.now()) {
    if (tabId == null || !value) return value;
    entries.set(tabId, { ...value, capturedAt: now });
    _touch(tabId);
    _evict();
    return value;
  }

  function stats() { return { tabs: entries.size, hits, misses }; }

  return { get, set, markChanged, evictTab, stats };
}

module.exports = { createSomCache };
