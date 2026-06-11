/**
 * server/services/embed-store.js
 * 
 * Persistence layer for MiniLM embeddings.
 * Saves/loads contentHash -> vector mappings to disk.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let _store = new Map();
let _cacheDir = null;
let _modelVersion = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'; // Default
let _lastFlush = 0;
let _flushTimer = null;
const MAX_ENTRIES = 10000;
const FLUSH_DEBOUNCE_MS = 5000;

function _getCachePath() {
  if (!_cacheDir) return null;
  return path.join(_cacheDir, 'embeddings-cache.json');
}

/**
 * Initialize and load cache from disk.
 * @param {string} cacheDir - Directory to store embeddings-cache.json
 * @param {string} modelVersion - Expected model version. If mismatch, cache is cleared.
 */
function load(cacheDir, modelVersion) {
  _cacheDir = path.resolve(cacheDir);
  if (modelVersion) _modelVersion = modelVersion;
  _store.clear();

  const cachePath = _getCachePath();
  if (!cachePath || !fs.existsSync(cachePath)) return;

  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);

    // Version mismatch -> invalidate cache
    if (data.modelVersion !== _modelVersion) {
      console.warn(`[whiskor] Embed cache version mismatch (expected ${_modelVersion}, got ${data.modelVersion}). Clearing cache.`);
      return;
    }

    if (data.entries && typeof data.entries === 'object') {
      for (const [hash, vec] of Object.entries(data.entries)) {
        _store.set(hash, vec);
      }
    }
  } catch (err) {
    console.error('[whiskor] Failed to load embedding cache:', err.message);
  }
}

/**
 * Schedule a disk flush.
 */
function _scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Immediately flush current cache to disk.
 */
function flush() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }

  const cachePath = _getCachePath();
  if (!cachePath) return;

  // Enforce size limit before saving
  if (_store.size > MAX_ENTRIES) {
    const entriesToKeep = Array.from(_store.entries()).slice(-MAX_ENTRIES);
    _store = new Map(entriesToKeep);
  }

  const data = {
    modelVersion: _modelVersion,
    updatedAt: Date.now(),
    entries: Object.fromEntries(_store)
  };

  try {
    fs.mkdirSync(_cacheDir, { recursive: true });
    // Write to temp file then rename for atomic write
    const tempPath = cachePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data));
    fs.renameSync(tempPath, cachePath);
    _lastFlush = Date.now();
  } catch (err) {
    console.error('[whiskor] Failed to flush embedding cache:', err.message);
  }
}

/**
 * Get an embedding vector by hash.
 * @param {string} hash 
 * @returns {number[] | Float32Array | null}
 */
function get(hash) {
  return _store.get(hash) || null;
}

/**
 * Store an embedding vector.
 * @param {string} hash 
 * @param {number[] | Float32Array} vec 
 */
function set(hash, vec) {
  _store.set(hash, vec);
  _scheduleFlush();
}

/**
 * Check if hash exists in cache.
 * @param {string} hash 
 * @returns {boolean}
 */
function has(hash) {
  return _store.has(hash);
}

/**
 * Remove an embedding from cache.
 * @param {string} hash 
 */
function remove(hash) {
  if (_store.delete(hash)) {
    _scheduleFlush();
  }
}

/**
 * Set the expected model version. If it changes, existing cache is cleared.
 * @param {string} version 
 */
function setModelVersion(version) {
  if (_modelVersion !== version) {
    _modelVersion = version;
    _store.clear();
    flush();
  }
}

/**
 * Get cache statistics.
 */
function getStats() {
  return {
    size: _store.size,
    modelVersion: _modelVersion,
    lastFlush: _lastFlush,
  };
}

module.exports = {
  load,
  get,
  set,
  has,
  delete: remove,
  flush,
  getStats,
  setModelVersion,
};
