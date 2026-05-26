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

/**
 * Execute an action in a browser tab.
 * Returns a Promise that resolves with the result when the extension responds.
 *
 * @param {string} tabId
 * @param {object} action  - { type, ...params }
 * @param {number} timeoutMs
 */
function execute(tabId, action, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const actionId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(actionId);
      reject(new Error(`Action timed out after ${timeoutMs}ms: ${action.type}`));
    }, timeoutMs);

    pending.set(actionId, { resolve, reject, timer, startedAt: Date.now() });

    if (!_broadcast) {
      clearTimeout(timer);
      pending.delete(actionId);
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
  const { actionId, ok, result, error } = msg;
  const p = pending.get(actionId);
  if (!p) return; // timed out or unknown
  clearTimeout(p.timer);
  pending.delete(actionId);

  if (ok) {
    p.resolve({ ok: true, result: result || null, durationMs: Date.now() - p.startedAt });
  } else {
    p.resolve({ ok: false, error: error || 'Unknown error', durationMs: Date.now() - p.startedAt });
  }
}

function pendingCount() { return pending.size; }

module.exports = { setBroadcast, execute, handleResult, pendingCount };
