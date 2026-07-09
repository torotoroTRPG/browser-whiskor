/**
 * server/action-executor.js
 * Manages pending agent-initiated actions.
 * Flow: MCP tool call → create pending action → broadcast to SW → SW executes
 *       in page → ACTION_RESULT comes back via WebSocket → resolve promise.
 */
'use strict';

const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 15000;
const pending = new Map(); // actionId → { resolve, reject, timer }

let _broadcast = null;   // set by index.js

function setBroadcast(fn) { _broadcast = fn; }

// Worker-side usage-stats, injected (nullable → no-op). Recording which labels
// get clicked here — on the process that runs the action — means it works over
// MCP stdio, HTTP /api/action, and the proxy forward alike, instead of only in
// the MCP layer (which the proxy runs in a separate process). See som-stats.js.
let _somStats = null;
function setSomStats(s) { _somStats = s; }

// Worker-side secret guard, injected (nullable). type_secret resolves the secret
// VALUE here — on the process that holds secrets.local.json — keyed by the agent-
// supplied ref name, so it works over the proxy too (the proxy's MCP process has
// no guard). The agent and the proxy only ever carry the ref; the value is put on
// the action just before it is dispatched to the page. See secret-guard.js.
let _secretGuard = null;
function setSecretGuard(g) { _secretGuard = g; }

// Worker-side premise-change feed, injected (nullable → no-op). Actions mark
// their execution window here so the feed can attribute page changes: inside a
// window = the action's own effect (its result reports it), outside = external
// (delivered as _sinceYourLastLook). See change-feed.js.
let _changeFeed = null;
function setChangeFeed(f) { _changeFeed = f; }

// Worker-side action-anchored diff runner, injected (nullable → feature absent).
// With action.diff=true (or agentControl.actionDiff.auto), the result carries
// `_diff`: element-level changes between the agent's last collected data and a
// fresh post-action collect. Lives here — like somStats/secretGuard — so it
// works identically over MCP stdio, HTTP /api/action, and the proxy forward.
// See action-diff.js.
let _diffRunner = null;
function setDiffRunner(r) { _diffRunner = r; }

// Resolve action.secretRef → action.text. Returns an error result to short-circuit
// the dispatch, or null to proceed (action mutated in place via the returned copy).
function _resolveSecretRef(action) {
  if (!action || !action.secretRef) return { action, error: null };
  if (!_secretGuard || !_secretGuard.active || typeof _secretGuard.resolveSecret !== 'function') {
    return { error: { ok: false, error: 'Secret guard is not enabled on the server. Set privacy.secretGuard.enabled=true and register a secret with a "ref" in secrets.local.json.' } };
  }
  const value = _secretGuard.resolveSecret(action.secretRef);
  if (value == null) {
    return { error: { ok: false, error: `No secret registered for ref "${action.secretRef}".`, availableRefs: (_secretGuard.listRefs && _secretGuard.listRefs()) || [] } };
  }
  const resolved = { ...action, text: value };  // value → page only
  delete resolved.secretRef;
  return { action: resolved, error: null };
}

/**
 * Execute an action in a browser tab.
 * Returns a Promise that resolves with the result when the extension responds.
 *
 * @param {string} tabId
 * @param {object} action  - { type, ...params }
 * @param {number} timeoutMs
 */
function execute(tabId, action, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!action || !action.type) {
    return Promise.reject(new Error(`Invalid action: must have a "type" property`));
  }
  // type_secret: resolve the secret value worker-side from the ref (so it works
  // under the proxy). Short-circuits with a clear error if the guard is off or the
  // ref is unknown — the value never reaches the agent.
  if (action.secretRef) {
    const r = _resolveSecretRef(action);
    if (r.error) return Promise.resolve(r.error);
    action = r.action;
  }
  // Usage stats: learn which labels get clicked, to bias packed-SoM ranking
  // (best-effort; never affects the action). Keyed on the agent-supplied text.
  if (_somStats && action.type === 'click' && action.text) {
    try { _somStats.record(action.text); } catch (_) {}
  }
  // Prospective premise gate: with abortOnPremiseChange, external changes pending
  // in the feed abort the action BEFORE it executes — the agent decided its plan
  // depends on the page still being what it last saw. Peek (not drain): the
  // changes ride back on this same response via the central piggyback.
  if (_changeFeed && action.abortOnPremiseChange === true) {
    const changes = _changeFeed.peek(tabId);
    if (changes.length) {
      return Promise.resolve({ ok: false, aborted: 'premise_changed', changes,
        error: 'Aborted before execution: the page changed since your last look (abortOnPremiseChange=true). Review `changes`, re-read if needed, then retry.' });
    }
  }
  // Action-anchored diff: baseline BEFORE dispatch (the cached snapshot is still
  // "what the agent last saw" only until the action's effects start landing),
  // diff AFTER the result. diff:false wins over the config auto mode. Diff
  // failure degrades to {available:false} — it never masks the action result.
  const wantDiff = _diffRunner && action.diff !== false &&
    (action.diff === true || _diffRunner.autoEnabled());
  if (wantDiff) {
    const dispatchAction = { ...action };
    delete dispatchAction.diff; // server-side option — the page never sees it
    return (async () => {
      let base = null;
      try { base = await _diffRunner.baseline(tabId); } catch (_) { /* degrade below */ }
      const res = await _dispatch(tabId, dispatchAction, timeoutMs);
      // A result that never reached the page (tab gone / RPC failure) has no
      // "after" state worth collecting.
      if (res && res.ok === false && !res.result) return res;
      let diff;
      try { diff = await _diffRunner.diffSince(tabId, base); }
      catch (e) { diff = { available: false, reason: e.message }; }
      return { ...res, _diff: diff };
    })();
  }
  return _dispatch(tabId, action, timeoutMs);
}

// Core dispatch: pending-map bookkeeping + broadcast to the extension. Kept
// separate so execute() can compose front-gates (secrets, premise, diff) around it.
function _dispatch(tabId, action, timeoutMs) {
  return new Promise((resolve, reject) => {
    const actionId = randomUUID();
    // Attribution window: changes observed while this action runs (plus a short
    // trail after it resolves) are the action's own effects, not external ones.
    if (_changeFeed) _changeFeed.beginActionWindow(tabId);
    let windowClosed = false;
    const closeWindow = () => {
      if (windowClosed) return;
      windowClosed = true;
      if (_changeFeed) _changeFeed.endActionWindow(tabId);
    };
    const timer = setTimeout(() => {
      pending.delete(actionId);
      closeWindow();
      reject(new Error(`Action timed out after ${timeoutMs}ms: ${action.type}`));
    }, timeoutMs);

    pending.set(actionId, { resolve, reject, timer, startedAt: Date.now(), closeWindow });

    if (!_broadcast) {
      clearTimeout(timer);
      pending.delete(actionId);
      closeWindow();
      return reject(new Error('No broadcast function set — server not ready'));
    }

    _broadcast({
      type: 'EXECUTE_ACTION',
      actionId,
      tabId,
      action,
    });
  });
}

/**
 * Called by index.js when ACTION_RESULT arrives via WebSocket.
 */
function handleResult(msg) {
  const { actionId, ok, result, error, tabGone, liveTabs } = msg;
  const p = pending.get(actionId);
  if (!p) return; // timed out or unknown
  clearTimeout(p.timer);
  pending.delete(actionId);
  if (p.closeWindow) p.closeWindow();

  if (ok) {
    p.resolve({ ok: true, result: result || null, durationMs: Date.now() - p.startedAt });
  } else {
    p.resolve({ ok: false, error: error || 'Unknown error', ...(tabGone ? { tabGone: true, liveTabs: liveTabs || [] } : {}), durationMs: Date.now() - p.startedAt });
  }
}

function pendingCount() { return pending.size; }

module.exports = { setBroadcast, setSomStats, setSecretGuard, setChangeFeed, setDiffRunner, execute, handleResult, pendingCount };
