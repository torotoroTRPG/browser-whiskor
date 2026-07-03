/**
 * server/dev-audit.js
 *
 * audit-before-ack (docs/vision/whiskor-for-dev/dev-exec.md SECTION 7.4, I-3, D-9).
 *
 * Every exec is appended to an append-only JSONL BEFORE its result is returned
 * to the caller. The ordering is the point: if the ack came first, an exec that
 * ran-but-was-not-recorded window would open, and the operator could no longer
 * audit what an agent executed (threat T-1). The append is one JSONL line, so
 * the latency cost is negligible and a mid-crash loss is at most the last line
 * (detectable at line granularity — same posture as the rest of the cache).
 *
 * The artifact body and console body are NEVER written here — hash, name, size,
 * initiator, origin, backend, mode, verdict only (size + secrecy, I-4). This is
 * the "agent executed code" analogue of config-change-log's "agent changed
 * config" tracking.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_ROOT = process.env.WHISKOR_CACHE_DIR || path.join(__dirname, '..', 'cache', 'sessions');

function auditDir(tabId) {
  return path.join(CACHE_ROOT, String(tabId), 'dev');
}

/**
 * Append one audit record for an exec. Synchronous + flushed so the "before-ack"
 * ordering is real: the caller awaits this, then returns its result. Best-effort
 * on failure (a disk error must not swallow the exec result), but the common path
 * always lands a line first.
 *
 * @param {string|number} tabId
 * @param {object} rec  { execId, artifactHash, artifactName?, initiator, origin,
 *                        backend, mode, bytes, verdict? }
 * @returns {boolean} whether the line was persisted
 */
function appendAudit(tabId, rec) {
  try {
    const dir = auditDir(tabId);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...rec }) + '\n';
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), line, 'utf8');
    return true;
  } catch (e) {
    // Surface on stderr (never stdout — MCP JSON-RPC channel) and continue.
    try { console.error(`[dev-audit] append failed (tabId=${tabId}): ${e.message}`); } catch (_) {}
    return false;
  }
}

/**
 * Read recent audit records for a tab (newest last, as stored). Used by
 * `whk dev status` / diagnostics. Missing file → [].
 */
function readAudit(tabId, limit = 100) {
  try {
    const fp = path.join(auditDir(tabId), 'audit.jsonl');
    if (!fs.existsSync(fp)) return [];
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const l of tail) { try { out.push(JSON.parse(l)); } catch (_) { /* skip a torn last line */ } }
    return out;
  } catch { return []; }
}

module.exports = { appendAudit, readAudit, auditDir, CACHE_ROOT };
