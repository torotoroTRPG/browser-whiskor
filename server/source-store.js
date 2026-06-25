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

// Persist one source file. encoding='base64' is written as raw bytes (binary
// assets — images/fonts captured via the DevTools getResources path); anything
// else is written as UTF-8 text.
function storeContent(sessionDir, hash, kind, content, encoding) {
  if (!content || !hash) return null;
  const contentDir = path.join(sessionDir, 'raw', 'sources', 'content');
  try {
    ensureDir(contentDir);
    const fname = path.join(contentDir, `${hash.slice(0, 8)}.${kind}`);
    if (encoding === 'base64') fs.writeFileSync(fname, Buffer.from(content, 'base64'));
    else                       fs.writeFileSync(fname, content, 'utf8');
    return fname;
  } catch (e) {
    console.error('[source-store] Failed to store content:', e.message);
    return null;
  }
}

function _contentPath(sessionDir, hash, kind) {
  return path.join(sessionDir, 'raw', 'sources', 'content', `${hash.slice(0, 8)}.${kind}`);
}

function readContent(sessionDir, hash, kind) {
  if (!hash) return null;
  try {
    const fname = _contentPath(sessionDir, hash, kind);
    if (fs.existsSync(fname)) return fs.readFileSync(fname, 'utf8');
  } catch (_) {}
  return null;
}

// Raw bytes for a stored file (any kind, incl. binary) — used by the ZIP export.
function readContentBuffer(sessionDir, hash, kind) {
  if (!hash) return null;
  try {
    const fname = _contentPath(sessionDir, hash, kind);
    if (fs.existsSync(fname)) return fs.readFileSync(fname);
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

  const manifestRows = [];

  for (const file of files) {
    const { url, kind, hash, byteLength, stored, content, encoding } = file;
    if (!url || !hash) continue;
    const enc = encoding === 'base64' ? 'base64' : 'utf-8';

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

    // Update cross-session hash registry
    _hashes[url] = {
      hash,
      byteLength:  byteLength || null,
      acquiredAt:  Date.now(),
      sessionId:   sessionId || 'unknown',
      kind:        kind || null,
      encoding:    enc,
    };
    _dirty = true;
    scheduleSave();

    // Persist content if provided (base64 → raw bytes for binary assets)
    if (stored && content && sessionDir) {
      storeContent(sessionDir, hash, kind || 'css', content, enc);
    }

    manifestRows.push({
      url, kind: kind || 'css', hash,
      byteLength: byteLength || null,
      stored: !!(stored && content),
      encoding: enc,
      acquisitionLevel: file.acquisition_level ?? null,
      capped: !!file.capped,
    });
  }

  // Per-session manifest powers listing + the folder-structured ZIP export.
  if (sessionDir && manifestRows.length) updateSessionManifest(sessionDir, manifestRows);

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
  // Don't read binary assets back as text (would be mojibake); hash-only for those.
  if (sessionDir && entry.hash && entry.encoding !== 'base64') {
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

// ── Per-session source manifest (url → file meta) ──────────────────────────────
// The cross-session _hashes registry is keyed by URL and overwritten by the most
// recent session, so it can't reconstruct one session's file set. We keep a small
// per-session manifest (files.json) for listing + the folder-structured ZIP export.
function _manifestPath(sessionDir) {
  return path.join(sessionDir, 'raw', 'sources', 'files.json');
}

function readSessionManifest(sessionDir) {
  try {
    const fp = _manifestPath(sessionDir);
    if (fs.existsSync(fp)) {
      const m = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (m && m.files) return m;
    }
  } catch (_) {}
  return { files: {} };
}

function updateSessionManifest(sessionDir, rows) {
  const m = readSessionManifest(sessionDir);
  for (const r of rows) {
    m.files[r.url] = {
      kind: r.kind, hash: r.hash, byteLength: r.byteLength,
      stored: r.stored, encoding: r.encoding,
      acquisitionLevel: r.acquisitionLevel, capped: r.capped,
      path: urlToPath(r.url), updatedAt: Date.now(),
    };
  }
  try {
    ensureDir(path.dirname(_manifestPath(sessionDir)));
    fs.writeFileSync(_manifestPath(sessionDir), JSON.stringify(m, null, 2), 'utf8');
  } catch (e) {
    console.error('[source-store] Failed to write files.json:', e.message);
  }
}

// ── URL → folder path (shared rule; see combined-design DESIGN §3) ─────────────
// host + pathname, query/fragment stripped, trailing "/" → index.html, illegal
// filename chars → "_". Special schemes (blob:/data:/chrome-extension:) → null.
function urlToPath(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); }
  catch { try { u = new URL(rawUrl, 'http://_relative'); } catch { return null; } }
  if (!/^https?:$/.test(u.protocol)) return null;
  let pathname = u.pathname || '/';
  if (pathname.endsWith('/')) pathname += 'index.html';
  let p = (u.hostname || '_') + pathname;
  p = p.replace(/\/{2,}/g, '/');
  p = p.split('/').map(seg => seg.replace(/[\\:*?"<>|]/g, '_')).join('/');
  if (p.length > 200) {                       // keep host, truncate the tail
    const i = p.indexOf('/');
    const host = i > 0 ? p.slice(0, i) : '_';
    p = host + '/' + p.slice(-180);
  }
  return p;
}

// ── Listing + ZIP export for one session ───────────────────────────────────────
function getSessionSources(sessionDir) {
  const m = readSessionManifest(sessionDir);
  return Object.entries(m.files).map(([url, meta]) => ({ url, ...meta }));
}

// Rebuild a folder-structured ZIP (host/path/file.ext) from the session manifest,
// reading each stored file's raw bytes by hash. Returns a Buffer or null if empty.
function buildSourcesZip(sessionDir) {
  const m = readSessionManifest(sessionDir);
  const entries = [];
  const used = new Set();
  for (const [url, meta] of Object.entries(m.files)) {
    if (!meta.stored) continue;
    const buf = readContentBuffer(sessionDir, meta.hash, meta.kind);
    if (!buf) continue;
    let name = meta.path || urlToPath(url) || `_unmapped/${meta.hash.slice(0, 8)}.${meta.kind}`;
    if (used.has(name)) name = `${name}.${meta.hash.slice(0, 8)}`; // disambiguate collisions
    used.add(name);
    entries.push({ name, data: buf });
  }
  if (!entries.length) return null;
  const { buildZip } = require('./zip-writer');
  return buildZip(entries);
}

module.exports = {
  handleSourceContent,
  getSourceFile,
  listTrackedUrls,
  getRecentChanges,
  getHashMap,
  getSessionSources,
  buildSourcesZip,
  urlToPath,
  // For testing
  _reset() { _hashes = {}; _loaded = false; _dirty = false; },
};
