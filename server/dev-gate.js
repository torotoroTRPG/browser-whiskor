/**
 * server/dev-gate.js
 *
 * dev mode — the runtime state in which dev-exec capabilities EXIST.
 * (docs/vision/whiskor-for-dev/dev-exec.md SECTION 7.2, D-3, invariants I-1/I-2/I-7)
 *
 * dev mode is deliberately NOT a config value. config is policy and persists;
 * activating an execution capability is a *session* and must expire. Three
 * properties are load-bearing:
 *
 *   明示 (explicit)  — activated only by the operator (whk dev on / dashboard),
 *                      never by agent input (MCP tool / set_config). See I-2.
 *   可視 (visible)   — while active, a badge + /health.dev advertise it.
 *   一時 (temporary) — a TTL expires it without a process restart (I-7), and a
 *                      crash/restart always comes back OFF (9.2) because this
 *                      state lives only in memory.
 *
 * This module owns the state machine + TTL + the origin check used just before
 * injection (I-5). It holds no ability to run code itself — it only gates.
 */
'use strict';

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;  // 4h
const MAX_TTL_MS     = 24 * 60 * 60 * 1000; // 24h

// Static policy (from config `dev` section). Set once at startup by index.js.
// Nothing here is the *active* state — only the rules that bound activation.
let _policy = {
  enabled:        false,
  allowedOrigins: ['http://localhost', 'http://127.0.0.1'],
  defaultTtlMs:   DEFAULT_TTL_MS,
  maxTtlMs:       MAX_TTL_MS,
  fileRoots:      [],
};

// The runtime state. `active:false` is the only state a fresh process can be in.
let _state = { active: false, activatedAt: 0, expiresAt: 0, project: null };
let _timer = null;
const _listeners = new Set();

function _now() { return Date.now(); }

function _notify() {
  const snap = status();
  for (const fn of _listeners) {
    try { fn(snap); } catch (_) { /* a listener must not break the gate */ }
  }
}

function _clearTimer() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

/**
 * Configure the static policy from config.json `dev`. Never activates anything —
 * activation is always an explicit runtime call (activate()).
 */
function setPolicy(devCfg = {}) {
  const exec = (devCfg && devCfg.exec) || {};
  const mode = (devCfg && devCfg.mode) || {};
  const origins = Array.isArray(exec.allowedOrigins) && exec.allowedOrigins.length
    ? exec.allowedOrigins.slice()
    : ['http://localhost', 'http://127.0.0.1'];
  _policy = {
    enabled:        exec.enabled === true,
    allowedOrigins: origins,
    defaultTtlMs:   Number.isFinite(mode.defaultTtlMs) ? mode.defaultTtlMs : DEFAULT_TTL_MS,
    maxTtlMs:       Number.isFinite(mode.maxTtlMs)     ? mode.maxTtlMs     : MAX_TTL_MS,
    fileRoots:      Array.isArray(exec.fileRoots) ? exec.fileRoots.slice() : [],
  };
  return getPolicy();
}

function getPolicy() { return { ..._policy, allowedOrigins: _policy.allowedOrigins.slice(), fileRoots: _policy.fileRoots.slice() }; }

/**
 * Activate dev mode. OPERATOR-ONLY caller responsibility — this module does not
 * distinguish callers, so the wiring (index.js) must never expose activate() to
 * an agent-reachable surface (MCP tool / set_config). See I-2.
 *
 * @returns { ok, error?, ...status }
 */
function activate({ ttlMs, project } = {}) {
  if (!_policy.enabled) {
    return { ok: false, error: 'dev mode is disabled by policy (dev.exec.enabled=false). Enable it in config.local.json to allow `whk dev on`.' };
  }
  const requested = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : _policy.defaultTtlMs;
  const ttl = Math.min(requested, _policy.maxTtlMs);
  _clearTimer();
  _state = {
    active:      true,
    activatedAt: _now(),
    expiresAt:   _now() + ttl,
    project:     project ? String(project) : null,
  };
  // unref so a pending expiry timer never keeps the process alive on its own.
  _timer = setTimeout(() => deactivate('ttl_expired'), ttl);
  if (_timer.unref) _timer.unref();
  _notify();
  return { ok: true, ...status() };
}

/**
 * Deactivate dev mode. Idempotent. Reasons: 'operator' (whk dev off),
 * 'ttl_expired' (timer), 'shutdown'. The absence principle (I-1) is restored
 * the instant this returns: dev tools vanish and /api/dev/* goes 404 again.
 */
function deactivate(reason = 'operator') {
  _clearTimer();
  const was = _state.active;
  _state = { active: false, activatedAt: 0, expiresAt: 0, project: null };
  if (was) _notify();
  return { ok: true, wasActive: was, reason, ...status() };
}

/**
 * Whether dev mode is active RIGHT NOW. Defensively re-checks the expiry so a
 * caller can never see a stale-active state even if the timer was starved.
 */
function isActive() {
  if (_state.active && _state.expiresAt && _now() >= _state.expiresAt) {
    deactivate('ttl_expired');
  }
  return _state.active;
}

/**
 * Public status for /health and `whk dev status`. Never leaks the fileRoots
 * paths — count only — matching the managed-dir non-disclosure stance (7.2).
 */
function status() {
  const active = _state.active && (!_state.expiresAt || _now() < _state.expiresAt);
  return {
    active,
    expiresAt:   active ? _state.expiresAt : null,
    remainingMs: active ? Math.max(0, _state.expiresAt - _now()) : 0,
    project:     active ? _state.project : null,
    roots:       _policy.fileRoots.length, // count, not paths
    policyEnabled: _policy.enabled,
  };
}

// ── Origin check (I-5) ────────────────────────────────────────────────────────
// The authoritative just-before-injection origin check is performed page-side by
// the executor (it measures its own location.origin in the same context that runs
// the code, so there is no TOCTOU window). This server-side helper is a best-effort
// pre-check for early rejection and for surfacing a clear `blocked` reason; it must
// NOT be treated as the sole guard.
//
// An allowed entry is an origin prefix "proto://host" and matches ANY port on that
// proto+host (dev servers pick arbitrary ports). Comparison is protocol + hostname.
function _parts(originOrUrl) {
  try {
    const u = new URL(originOrUrl);
    return { proto: u.protocol.replace(/:$/, ''), host: u.hostname };
  } catch { return null; }
}

function originAllowed(originOrUrl, allowedOrigins = _policy.allowedOrigins) {
  const got = _parts(originOrUrl);
  if (!got) return false;
  for (const entry of allowedOrigins || []) {
    const want = _parts(entry);
    if (!want) continue;
    if (want.proto === got.proto && want.host === got.host) return true;
  }
  return false;
}

// ── Change listeners (badge broadcast / dashboard) ────────────────────────────
function onChange(fn) {
  if (typeof fn === 'function') _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// Test hook — reset to a pristine (inactive, default-policy) state.
function _resetForTest() {
  _clearTimer();
  _state = { active: false, activatedAt: 0, expiresAt: 0, project: null };
  _policy = { enabled: false, allowedOrigins: ['http://localhost', 'http://127.0.0.1'], defaultTtlMs: DEFAULT_TTL_MS, maxTtlMs: MAX_TTL_MS, fileRoots: [] };
  _listeners.clear();
}

module.exports = {
  setPolicy,
  getPolicy,
  activate,
  deactivate,
  isActive,
  status,
  originAllowed,
  onChange,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  _resetForTest,
};
