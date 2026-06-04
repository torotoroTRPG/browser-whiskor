/**
 * server/som-stats.js
 *
 * Global usage statistics for packed Set-of-Marks: learn which element *labels*
 * the agent acts on so a fresh page can rank likely targets first (and later
 * prefetch them). See docs/ideas/PACKED_SOM_CAPTURE.md → "Global stats".
 *
 * Design notes:
 *   - Key is the NORMALIZED label, not a (site-specific) selector, so the signal
 *     transfers across sites and sessions.
 *   - Score is TIME-DECAYED (half-life) so stale habits fade and the model adapts.
 *   - A small cold-start PRIOR of near-universal labels keeps ranking useful
 *     before any real stats exist.
 *   - Bounded to MAX_LABELS (evict lowest decayed score).
 *   - Global bucket by default; an identity-tagged whiskor uses its own file so an
 *     embedded instance neither pollutes nor reads the shared bucket
 *     (see server identity).
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR      = path.join(__dirname, '..', 'cache');
const HALF_LIFE_DAYS = 14;
const MAX_LABELS     = 500;
const PRIOR_SCORE    = 0.25; // baseline for cold-start labels

// Near-universal action labels — seeded so prefetch/ranking works on day one.
const PRIOR = [
  'login', 'signup', 'search', 'continue', 'next', 'submit', 'add-to-cart',
  'checkout', 'accept', 'agree', 'close', 'menu', 'back', 'cancel', 'save',
];

// Fold obvious equivalents to a canonical label. Conservative on purpose.
const SYNONYMS = {
  'sign in': 'login', 'log in': 'login', 'signin': 'login', 'log-in': 'login',
  'sign up': 'signup', 'register': 'signup', 'create account': 'signup',
  'add to cart': 'add-to-cart', 'add to bag': 'add-to-cart', 'add to basket': 'add-to-cart',
  'proceed': 'continue', 'proceed to checkout': 'checkout',
};

/**
 * Normalize a raw element label to its stat key. Returns null for empty/unusable
 * text. Lowercased, whitespace-collapsed, surrounding punctuation/emoji stripped,
 * synonym-folded, length-capped.
 */
function normalize(text) {
  if (typeof text !== 'string') return null;
  let s = text.toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!s) return null;
  if (s.length > 40) s = s.slice(0, 40);
  return SYNONYMS[s] || s;
}

function _decayed(entry, now) {
  const days = (now - (entry.lastActedAt || now)) / 86400000;
  return entry.score * Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
}

/**
 * @param {object} opts
 * @param {string} [opts.bucket]  - 'global' (default) or an identity instanceId.
 * @param {boolean} [opts.persist] - write to disk (default true; tests pass false).
 * @param {boolean} [opts.seedPrior] - seed the cold-start prior (default true).
 */
function createStatsStore(opts = {}) {
  const bucket    = opts.bucket || 'global';
  const persist   = opts.persist !== false;
  const seedPrior = opts.seedPrior !== false;
  const file = path.join(CACHE_DIR, bucket === 'global' ? 'som-stats.json' : `som-stats-${bucket}.json`);

  /** @type {Map<string, {score:number, count:number, lastActedAt:number}>} */
  const stats = new Map();

  if (persist) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(raw.labels || {})) {
          if (v && typeof v.score === 'number') stats.set(k, v);
        }
      }
    } catch (_) { /* start empty */ }
  }

  if (seedPrior) {
    for (const label of PRIOR) {
      if (!stats.has(label)) stats.set(label, { score: PRIOR_SCORE, count: 0, lastActedAt: 0, prior: true });
    }
  }

  function save() {
    if (!persist) return;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ labels: Object.fromEntries(stats) }, null, 0));
    } catch (_) {}
  }

  function _evict() {
    if (stats.size <= MAX_LABELS) return;
    const now = Date.now();
    const sorted = [...stats.entries()].sort((a, b) => _decayed(a[1], now) - _decayed(b[1], now));
    for (let i = 0; i < sorted.length - MAX_LABELS; i++) stats.delete(sorted[i][0]);
  }

  /** Record that the agent acted on an element with `text`. */
  function record(text, weight = 1, now = Date.now()) {
    const label = normalize(text);
    if (!label) return null;
    const e = stats.get(label) || { score: 0, count: 0, lastActedAt: now };
    // Decay the existing score to `now`, then add the new weight.
    e.score = _decayed(e, now) + weight;
    e.count = (e.count || 0) + 1;
    e.lastActedAt = now;
    delete e.prior;
    stats.set(label, e);
    _evict();
    save();
    return label;
  }

  /** Current time-decayed score for a label (0 if unknown). */
  function score(text, now = Date.now()) {
    const label = normalize(text);
    if (!label) return 0;
    const e = stats.get(label);
    return e ? _decayed(e, now) : 0;
  }

  /**
   * Rank candidate labels by decayed score (desc), stable on ties. Returns
   * [{ text, label, score }]. Stats BIAS the order; they never drop a candidate.
   */
  function rank(texts, now = Date.now()) {
    const scored = (texts || []).map((text, i) => ({ text, label: normalize(text), score: score(text, now), i }));
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return scored.map(({ text, label, score }) => ({ text, label, score: Math.round(score * 1000) / 1000 }));
  }

  function snapshot() { return Object.fromEntries(stats); }

  return { record, score, rank, snapshot, file, _bucket: bucket };
}

module.exports = { createStatsStore, normalize, PRIOR, HALF_LIFE_DAYS, MAX_LABELS };
