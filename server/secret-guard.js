/**
 * server/secret-guard.js
 *
 * Redacts the user's secrets from everything the agent (and any log/cache file
 * the agent could later read) receives. See docs/ideas/REDACTION_SECRET_GUARD.md.
 *
 * Threat model: the user does not necessarily trust the agent. Detection and
 * substitution happen ONLY here, on the Node server — the secret values never
 * enter the page (MAIN world), so a hostile page/XSS cannot exfiltrate them, and
 * the agent cannot reach them.
 *
 * Slice 1: known-value blacklist. Slice 2: pattern detection (email / credit
 * card). Applied at the single core.js ingestion chokepoint. Screenshot masking
 * and the type_secret write tool are later slices.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SECRETS_FILE = path.join(__dirname, '..', 'secrets.local.json');

// Depth cap: collected payloads are plain JSON (no cycles), but stay defensive.
const MAX_DEPTH = 12;

// Sentinel delimiter for the two-phase replace below. NUL never appears in
// normal page text or JSON, so a sentinel can't collide with real content.
const SEP = String.fromCharCode(0);
const SENTINEL_RE = new RegExp(SEP + 'R(\\d+)' + SEP, 'g');

// Non-sensitive hint per type. A hint must NEVER reveal the secret itself.
function deriveHint(value, type) {
  if (type === 'email') {
    const at = value.lastIndexOf('@');
    return at >= 0 ? value.slice(at) : null; // domain only, e.g. "@gmail.com"
  }
  return null; // password / token / pii: no hint
}

function makeToken(type, hint, reason) {
  const parts = [`type=${type || 'secret'}`];
  if (hint) parts.push(`hint=${hint}`);
  parts.push(`reason=${reason || 'user-blacklist'}`);
  return `[WHISKOR_REDACTED ${parts.join(' ')}]`;
}

// ── Known-value loading ──────────────────────────────────────────────────────
// Sources (server-only, git-ignored — never config.json which is tracked):
//   - secrets.local.json:  { "secrets": [ { "value": "...", "type": "email" }, ... ] }
//   - env WHISKOR_SECRETS:  "value:type,value:type"  (simple cases)
function loadKnownValues(cfg) {
  const out = [];
  const mode = cfg && cfg.knownValues; // "env" | "file" | "off" | undefined (=both)

  const pushSecret = (value, type, reason) => {
    if (typeof value !== 'string' || value.length < 3) return; // too short → false positives
    out.push({ value, token: makeToken(type, deriveHint(value, type), reason) });
  };

  if (mode !== 'off' && mode !== 'env') {
    try {
      if (fs.existsSync(SECRETS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
        for (const s of parsed.secrets || []) {
          if (s && typeof s.value === 'string') pushSecret(s.value, s.type, 'user-blacklist');
        }
      }
    } catch (e) {
      console.error('[secret-guard] Failed to read secrets.local.json:', e.message);
    }
  }

  if (mode !== 'off' && mode !== 'file' && process.env.WHISKOR_SECRETS) {
    for (const pair of process.env.WHISKOR_SECRETS.split(',')) {
      const idx = pair.lastIndexOf(':');
      const value = (idx >= 0 ? pair.slice(0, idx) : pair).trim();
      const type  = idx >= 0 ? pair.slice(idx + 1).trim() : 'secret';
      if (value) pushSecret(value, type, 'user-blacklist');
    }
  }

  // Replace longer secrets first so a secret that contains another isn't left
  // half-redacted.
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

// ── Pattern detection (no pre-registration needed) ───────────────────────────
function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

// Each pattern is a global regex + a replacer that returns a token (or the
// original match when a soft check like Luhn fails, to avoid false positives).
function buildPatterns(cfg) {
  const p = (cfg && cfg.patterns) || {};
  const out = [];
  if (p.email !== false) {
    out.push({
      type: 'email',
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      replace: (m) => makeToken('email', m.slice(m.lastIndexOf('@')), 'pattern'),
    });
  }
  if (p.creditCard !== false) {
    out.push({
      type: 'credit-card',
      re: /\b\d(?:[ -]?\d){12,18}\b/g,
      replace: (m) => (luhnValid(m.replace(/\D/g, '')) ? makeToken('credit-card', null, 'pattern') : m),
    });
  }
  return out;
}

// ── Guard factory ────────────────────────────────────────────────────────────
function createGuard(cfg) {
  const enabled  = !!(cfg && cfg.enabled);
  const secrets  = enabled ? loadKnownValues(cfg) : [];
  const patterns = enabled ? buildPatterns(cfg) : [];
  const active   = enabled && (secrets.length > 0 || patterns.length > 0);

  // Two-phase replace: every match first becomes a NUL-delimited sentinel, then
  // all sentinels expand to their human tokens at the very end. This stops a
  // later/shorter secret (e.g. "pass") from re-matching inside a token already
  // emitted for an earlier one (whose text contains words like "password").
  function redactString(str) {
    if (!active || typeof str !== 'string' || !str) return str;
    const slots = [];
    const stash = (token) => {
      const sentinel = SEP + 'R' + slots.length + SEP;
      slots.push(token);
      return sentinel;
    };

    let out = str;
    // 1) Known values: literal replace-all (secret contents can't act as regex),
    //    longer secrets first so they win over shorter substrings.
    for (const s of secrets) {
      if (out.includes(s.value)) out = out.split(s.value).join(stash(s.token));
    }
    // 2) Patterns over what remains. A replacer that returns the match unchanged
    //    (e.g. Luhn failed) is treated as "no match" and left in place.
    for (const p of patterns) {
      out = out.replace(p.re, (m) => {
        const token = p.replace(m);
        return token === m ? m : stash(token);
      });
    }
    // 3) Expand sentinels → tokens (tokens are never re-scanned).
    return out.replace(SENTINEL_RE, (_, i) => slots[Number(i)]);
  }

  function redactDeep(node, depth = 0) {
    if (!active || node == null || depth > MAX_DEPTH) return node;
    if (typeof node === 'string') return redactString(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = redactDeep(node[i], depth + 1);
      return node;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) node[k] = redactDeep(node[k], depth + 1);
      return node;
    }
    return node;
  }

  // Redact a collected-data message in place. Only the payload is scanned;
  // routing fields (type, tabId, requestId, …) are left intact.
  function redactMessage(msg) {
    if (!active || !msg || typeof msg !== 'object') return msg;
    if (msg.payload != null) msg.payload = redactDeep(msg.payload);
    return msg;
  }

  return { enabled, active, count: secrets.length, patternCount: patterns.length, redactString, redactDeep, redactMessage };
}

module.exports = { createGuard, makeToken, deriveHint, luhnValid, SECRETS_FILE };
