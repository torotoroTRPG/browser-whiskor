/**
 * server/dev-artifacts.js
 *
 * push-intake artifact store (dev-exec.md SECTION 4.1 push path, I-4).
 *
 * A toolchain build hook can POST a freshly built artifact to /api/dev/artifact;
 * we hold it here keyed by an id derived from its content hash, so a later
 * exec_module { artifactId } can run it. In-memory LRU only — the artifact body
 * is never written to disk (I-4); a restart clears it (dev mode is off after a
 * restart anyway, so a dangling artifactId would be unusable regardless).
 *
 * Latest-wins by content: pushing identical bytes returns the same id and simply
 * refreshes its recency, so a watch loop that rebuilds unchanged output doesn't
 * churn the cache.
 */
'use strict';

const devIntake = require('./dev-intake');

let _max = 32; // dev.exec.artifactCacheMax
const _map = new Map(); // artifactId -> { hash, name, code, bytes, ts }

function setMax(n) { if (Number.isFinite(n) && n > 0) _max = n; }

/**
 * Store an artifact. Returns its id + identity (never the body back).
 */
function add(name, code) {
  const src = typeof code === 'string' ? code : '';
  const hash = devIntake.sha256(src);
  const bytes = Buffer.byteLength(src, 'utf8');
  const artifactId = 'art_' + hash.slice(0, 16);
  // Re-insert to move to the MRU end (Map preserves insertion order).
  _map.delete(artifactId);
  _map.set(artifactId, { hash, name: name || null, code: src, bytes, ts: Date.now() });
  while (_map.size > _max) {
    const oldest = _map.keys().next().value;
    _map.delete(oldest);
  }
  return { artifactId, hash, bytes, name: name || null };
}

/**
 * Fetch a stored artifact (and refresh its recency). null when evicted/unknown.
 */
function get(artifactId) {
  const e = _map.get(artifactId);
  if (!e) return null;
  _map.delete(artifactId);
  _map.set(artifactId, e); // LRU touch
  return e;
}

function count() { return _map.size; }
function clear() { _map.clear(); }

module.exports = { setMax, add, get, count, clear };
