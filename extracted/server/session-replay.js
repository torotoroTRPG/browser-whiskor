/**
 * server/session-replay.js
 *
 * Session Replay — records agent actions and replays them.
 *
 * Recording model (per Proposal F):
 *   Every action executed via _callAction is appended as a SessionReplayEntry
 *   to:  cache/sessions/{siteVersion}/{tabId}-{sessionId}/raw/replay/actions.jsonl
 *
 * Replay:
 *   Iterates actions.jsonl in seq order.  For each entry verifies pre-state hash,
 *   executes the action, waits 300 ms, verifies post-state hash.  State mismatches
 *   are recorded as divergences but do not abort replay (unless stopOnDivergence).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

// Per-tab monotonically increasing sequence counter
const _seqMap = new Map(); // tabId → number

function _nextSeq(tabId) {
  const k = String(tabId);
  const n = (_seqMap.get(k) || 0) + 1;
  _seqMap.set(k, n);
  return n;
}

function _actionPath(sessionDir) {
  return path.join(sessionDir, 'raw', 'replay', 'actions.jsonl');
}

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Record one action result entry (non-blocking — fire-and-forget).
 *
 * @param {string|number} tabId
 * @param {object}  action       - original action payload { type, selector, text, … }
 * @param {object}  result       - { ok, error? }
 * @param {string|null} preStateHash
 * @param {string|null} sessionDir
 * @param {Function}    getPostHash  - async () → compositeHash string | null
 */
function record(tabId, action, result, preStateHash, sessionDir, getPostHash) {
  if (!sessionDir) return;
  const seq       = _nextSeq(tabId);
  const timestamp = Date.now();

  // Fetch post-state hash asynchronously so we never block the MCP response.
  Promise.resolve()
    .then(() => _waitMs(300))
    .then(() => (getPostHash ? getPostHash() : Promise.resolve(null)))
    .then(postStateHash => _append(sessionDir, {
      seq,
      timestamp,
      action: {
        type:     action.type     || null,
        selector: action.selector || null,
        text:     action.text     || null,
        key:      action.key      || null,
        x:        action.x        != null ? action.x : null,
        y:        action.y        != null ? action.y : null,
      },
      preStateHash:  preStateHash  || null,
      postStateHash: postStateHash || null,
      ok:            !!result.ok,
      errorType:     result.ok ? null : (result.error || 'unknown'),
    }))
    .catch(() => { /* best-effort — never throw into caller */ });
}

async function _append(sessionDir, entry) {
  const filePath = _actionPath(sessionDir);
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, JSON.stringify(entry) + '\n');
  } catch { /* ignore write errors */ }
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Replay actions from a source session.
 *
 * @param {object} opts
 *   tabId            {number}   target tab to replay into
 *   sourceSessionDir {string}   path to source session dir (with raw/replay/actions.jsonl)
 *   fromSeq          {number?}  start from this seq (inclusive, default 1)
 *   toSeq            {number?}  stop after this seq (inclusive, default Infinity)
 *   stopOnDivergence {boolean?} abort on first hash mismatch (default false)
 *   executeAction    {Function} async (tabId, action, timeoutMs) → { ok, error? }
 *   getHash          {Function} async (tabId) → compositeHash string | null
 * @returns {Promise<object>} ReplayReport
 */
async function replay(opts) {
  const {
    tabId,
    sourceSessionDir,
    fromSeq          = 1,
    toSeq            = Infinity,
    stopOnDivergence = false,
    executeAction,
    getHash,
  } = opts;

  const entries = await _loadEntries(sourceSessionDir);
  const subset  = entries.filter(e => e.seq >= fromSeq && e.seq <= toSeq);

  const startMs     = Date.now();
  let successSteps  = 0;
  let divergedSteps = 0;
  const divergences = [];

  for (const entry of subset) {
    // 1. Verify pre-state hash
    const preActual = await _safeGetHash(getHash, tabId);
    if (entry.preStateHash && preActual && preActual !== entry.preStateHash) {
      const div = {
        seq:          entry.seq,
        phase:        'pre',
        expectedHash: entry.preStateHash,
        actualHash:   preActual,
        actionType:   entry.action?.type || null,
      };
      divergences.push(div);
      divergedSteps++;
      if (stopOnDivergence) break;
    }

    // 2. Execute action
    const result = await _safeExecute(executeAction, tabId, entry.action);

    // 3. Wait 300 ms then verify post-state hash
    await _waitMs(300);
    const postActual = await _safeGetHash(getHash, tabId);
    if (entry.postStateHash && postActual && postActual !== entry.postStateHash) {
      const div = {
        seq:          entry.seq,
        phase:        'post',
        expectedHash: entry.postStateHash,
        actualHash:   postActual,
        actionType:   entry.action?.type || null,
      };
      divergences.push(div);
      divergedSteps++;
      if (stopOnDivergence) break;
    }

    if (result.ok) successSteps++;
  }

  return {
    ok:           true,
    totalSteps:   subset.length,
    successSteps,
    divergedSteps,
    divergences,
    durationMs:   Date.now() - startMs,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _loadEntries(sessionDir) {
  const filePath = _actionPath(sessionDir);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

async function _safeExecute(fn, tabId, action) {
  if (!fn || !action?.type) return { ok: false, error: 'no executor or action' };
  try { return await fn(tabId, action, 10000); }
  catch (e) { return { ok: false, error: e.message }; }
}

async function _safeGetHash(fn, tabId) {
  if (!fn) return null;
  try { return await fn(tabId); }
  catch { return null; }
}

function _waitMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { record, replay };
