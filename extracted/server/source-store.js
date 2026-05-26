/**
 * server/source-store.js
 *
 * Intelligence Layer: Source Layer — server-side store.
 *
 * ソースファイルのテキストコンテンツをキャッシュし、
 * クロスセッションのURL→ハッシュ対応表を管理する。
 *
 * Storage layout:
 *   cache/sources/hashes.json          — cross-session { url → { sha256, byteLength, acquiredAt, sessionId } }
 *   cache/sessions/.../raw/sources/
 *     content/{hash[0..7]}.css         — CSS source text
 *     content/{hash[0..7]}.js          — JS source text (if storeJs=true)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SOURCES_ROOT  = path.join(__dirname, '..', 'cache', 'sources');
const HASHES_FILE   = path.join(SOURCES_ROOT, 'hashes.json');

// In-memory store
let _hashes = {}; // url → { hash, byteLength, acquiredAt, sessionId }
let _loaded  = false;
let _dirty   = false;
let _saveTimer = null;

// ── Persistence ───────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadHashes() {
  if (_loaded) return;
  _loaded = true;
  ensureDir(SOURCES_ROOT);
  try {
    if (fs.existsSync(HASHES_FILE)) {
      _hashes = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[source-store] Failed to load hashes.json:', e.message);
    _hashes = {};
  }
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty) return;
    try {
      ensureDir(SOURCES_ROOT);
      fs.writeFileSync(HASHES_FILE, JSON.stringify(_hashes, null, 2), 'utf8');
      _dirty = false;
    } catch (e) {
      console.error('[source-store] Failed to save hashes.json:', e.message);
    }
  }, 2000);
}

// ── Source content storage ────────────────────────────────────────────────────

function storeContent(sessionDir, hash, kind, content) {
  if (!content || !hash) return null;
  const contentDir = path.join(sessionDir, 'raw', 'sources', 'content');
  try {
    ensureDir(contentDir);
    const fname = path.join(contentDir, `${hash.slice(0, 8)}.${kind}`);
    fs.writeFileSync(fname, content, 'utf8');
    return fname;
  } catch (e) {
    console.error('[source-store] Failed to store content:', e.message);
    return null;
  }
}

function readContent(sessionDir, hash, kind) {
  if (!hash) return null;
  const fname = path.join(sessionDir, 'raw', 'sources', 'content', `${hash.slice(0, 8)}.${kind}`);
  try {
    if (fs.existsSync(fname)) return fs.readFileSync(fname, 'utf8');
  } catch (_) {}
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process SOURCE_CONTENT message from extension.
 * Returns array of SOURCE_CHANGED events (if any).
 */
function handleSourceContent(msg, sessionDir, sessionId) {
  loadHashes();
  const payload = msg.payload || {};
  const files   = Array.isArray(payload.files) ? payload.files : [];
  const changed = [];

  for (const file of files) {
    const { url, kind, hash, byteLength, stored, content } = file;
    if (!url || !hash) continue;

    const prev = _hashes[url];
    const isChanged = prev && prev.hash !== hash;

    if (isChanged) {
      changed.push({
        type:               'SOURCE_CHANGED',
        url,
        previousHash:       prev.hash,
        currentHash:        hash,
        previousAcquiredAt: prev.acquiredAt,
        detectedAt:         Date.now(),
        byteLength: {
          previous: prev.byteLength || null,
          current:  byteLength      || null,
        },
      });
    }

    // Update hash registry
    _hashes[url] = {
      hash,
      byteLength:  byteLength || null,
      acquiredAt:  Date.now(),
      sessionId:   sessionId || 'unknown',
      kind:        kind || null,
    };
    _dirty = true;
    scheduleSave();

    // Persist content if provided
    if (stored && content && sessionDir) {
      storeContent(sessionDir, hash, kind || 'css', content);
    }
  }

  return changed;
}

/**
 * Retrieve source content for a URL.
 * Returns { url, kind, hash, content, acquiredAt } or null.
 */
function getSourceFile(url, sessionDir) {
  loadHashes();
  const entry = _hashes[url];
  if (!entry) return null;

  let content = null;
  if (sessionDir && entry.hash) {
    content = readContent(sessionDir, entry.hash, entry.kind || 'css');
  }

  return {
    url,
    kind:       entry.kind,
    hash:       entry.hash,
    byteLength: entry.byteLength,
    acquiredAt: entry.acquiredAt,
    sessionId:  entry.sessionId,
    content,    // null if hash-only or file not on disk
  };
}

/**
 * List all tracked URLs and their metadata (no content).
 */
function listTrackedUrls() {
  loadHashes();
  return Object.entries(_hashes).map(([url, meta]) => ({ url, ...meta, content: undefined }));
}

/**
 * Get SOURCE_CHANGED events from hashes stored in a previous session.
 * Used by detect_site_updates MCP tool.
 */
function getRecentChanges(sinceMs) {
  loadHashes();
  const cutoff = Date.now() - (sinceMs || 86400000); // default 24h
  // We don't store change history separately; return all entries recently updated
  // that differ from the first-seen record. This is a best-effort implementation.
  return Object.entries(_hashes)
    .filter(([, meta]) => meta.acquiredAt >= cutoff)
    .map(([url, meta]) => ({ url, ...meta }));
}

/**
 * Return hashes map for passing to extension (for update detection).
 * Only sends URL→hash pairs, not content.
 */
function getHashMap() {
  loadHashes();
  const map = {};
  for (const [url, meta] of Object.entries(_hashes)) {
    map[url] = meta.hash;
  }
  return map;
}

module.exports = {
  handleSourceContent,
  getSourceFile,
  listTrackedUrls,
  getRecentChanges,
  getHashMap,
  // For testing
  _reset() { _hashes = {}; _loaded = false; _dirty = false; },
};
