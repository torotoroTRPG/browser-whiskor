/**
 * server/change-feed.js
 * Premise-change feed — per-tab ring buffer of EXTERNAL page changes.
 *
 * "External" = outside every agent action window: changes an agent action causes
 * are reported by that action's own result (diagnosis/observed/dialogs), so the
 * feed carries only what the agent did NOT do. Delivery is pull-only (MCP), so
 * entries piggyback on the next tool response as `_sinceYourLastLook`
 * (attached centrally in mcp/registry.js) and reading drains the buffer.
 *
 * Pure state machine — no I/O, no timers. See docs/ideas/PREMISE_CHANGE_FEED.md.
 */
'use strict';

const DEFAULTS = {
  maxEntries: 50,      // per-tab ring cap; overflow drops oldest + marks truncated
  actionTrailMs: 1500, // grace after an action resolves: late effects are still "yours"
};

class ChangeFeed {
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries > 0 ? opts.maxEntries : DEFAULTS.maxEntries;
    this.actionTrailMs = opts.actionTrailMs >= 0 ? opts.actionTrailMs : DEFAULTS.actionTrailMs;
    this._tabs = new Map(); // tabId → { entries, activeActions, actionUntil, truncated }
  }

  _tab(tabId) {
    let t = this._tabs.get(tabId);
    if (!t) {
      t = { entries: [], activeActions: 0, actionUntil: 0, truncated: false };
      this._tabs.set(tabId, t);
    }
    return t;
  }

  // ── Action windows (attribution) ──────────────────────────────────────────
  // Concurrent actions on one tab are rare but possible (HTTP + MCP); use a
  // counter so overlapping windows never un-mark each other.

  beginActionWindow(tabId) {
    if (tabId == null) return;
    this._tab(tabId).activeActions++;
  }

  endActionWindow(tabId) {
    if (tabId == null) return;
    const t = this._tab(tabId);
    t.activeActions = Math.max(0, t.activeActions - 1);
    t.actionUntil = Date.now() + this.actionTrailMs;
  }

  // A change observed now is external iff no action is in flight and the last
  // action's trailing grace window has passed.
  isExternalNow(tabId) {
    const t = this._tabs.get(tabId);
    if (!t) return true;
    if (t.activeActions > 0) return false;
    return Date.now() > t.actionUntil;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  /**
   * Record a change if it is external. `entry`:
   *   kind  — 'scroll' | 'modal' | 'navigate' | ... (open set)
   *   note  — human/agent-readable one-liner (built at drain for coalesced kinds)
   *   key   — optional coalesce key: an existing entry with the same key is
   *           REPLACED (ts updated, original `data.from` preserved) — a scroll
   *           burst stays one line with the final position.
   *   data  — optional structured payload (from/to for scroll, url, selector).
   * @returns true when recorded.
   */
  record(tabId, entry) {
    if (tabId == null || !entry || !entry.kind) return false;
    if (!this.isExternalNow(tabId)) return false;
    const t = this._tab(tabId);
    const now = Date.now();

    if (entry.key) {
      const i = t.entries.findIndex(e => e.key === entry.key);
      if (i >= 0) {
        const prev = t.entries.splice(i, 1)[0];
        // Keep the origin of the burst: "was" stays what the agent last knew.
        if (prev.data && prev.data.from !== undefined && entry.data) {
          entry = { ...entry, data: { ...entry.data, from: prev.data.from } };
        }
      }
    }

    t.entries.push({ ts: now, kind: entry.kind, note: entry.note, key: entry.key, data: entry.data });
    if (t.entries.length > this.maxEntries) {
      t.entries.splice(0, t.entries.length - this.maxEntries);
      t.truncated = true;
    }
    return true;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  _format(e, now) {
    const age = Math.max(0, Math.round((now - e.ts) / 1000));
    const when = age < 1 ? 'just now' : `${age}s ago`;
    let note = e.note;
    if (e.kind === 'scroll' && e.data) {
      const p = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) ? `(${Math.round(v.x)}, ${Math.round(v.y)})` : '(?)';
      note = `scrolled: viewport now at ${p(e.data.to)}` + (e.data.from ? `, was ${p(e.data.from)}` : '');
    }
    return `[${when}] ${note || e.kind}`;
  }

  /** Non-destructive read (pre-action premise check). */
  peek(tabId) {
    const t = this._tabs.get(tabId);
    if (!t || !t.entries.length) return [];
    const now = Date.now();
    return t.entries.map(e => this._format(e, now));
  }

  /** Read AND clear — "since your last look" is literal. */
  drain(tabId) {
    const t = this._tabs.get(tabId);
    if (!t || !t.entries.length) return [];
    const now = Date.now();
    const out = t.entries.map(e => this._format(e, now));
    if (t.truncated) out.unshift('(older external changes were dropped — buffer overflowed)');
    t.entries = [];
    t.truncated = false;
    return out;
  }

  /** Tab closed → the premise no longer exists; discard everything. */
  dropTab(tabId) {
    this._tabs.delete(tabId);
  }

  pendingCount(tabId) {
    const t = this._tabs.get(tabId);
    return t ? t.entries.length : 0;
  }
}

module.exports = { ChangeFeed, DEFAULTS };
