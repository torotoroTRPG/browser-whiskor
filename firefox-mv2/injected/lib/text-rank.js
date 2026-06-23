/**
 * shared/injected/lib/text-rank.js
 *
 * Pure, environment-agnostic ranking policy for "act on this text" target
 * resolution. Shared by two callers that each produce a base text-match score
 * with their own matcher, then defer the *ordering policy* here so click/hover/
 * right_click (via executor.js findByText, in the browser MAIN world) and the
 * find_target MCP tool (server-side, fuzzy/MiniLM scored) rank identically:
 *
 *   - executor.js  → window.__SI_TEXT_RANK__  (MAIN world, no `module`)
 *   - server side  → require('.../text-rank.js') (CommonJS, no `window`)
 *
 * The mis-match this fixes: {text:"x.com"} on a search-results page landed on a
 * ".x.com" breadcrumb/meta span instead of the actual link, because a plain-text
 * substring tied/beat the link by raw text score alone. Kind priority (link >
 * input/label > plain text), viewport, accessible-name, and reachability now
 * break those ties toward the element you can actually act on. Callers may pass
 * a per-call `textMatch` to override the policy in the moment.
 *
 * Two layers:
 *   (a) baseline smart defaults — weights below
 *   (b) per-call overrides via opts.textMatch: { prefer, scope, index, boost, exclude }
 *
 * This module holds NO DOM/state. Every signal is supplied by the caller, so the
 * reported scores are evidence-linked (signals{} explains each contribution) and
 * never fabricated.
 */
'use strict';

// ── Baseline policy weights ──────────────────────────────────────────────────
// Deliberately modest: a clearly better text match still wins across kinds — the
// weights only break near-ties. Mirrors executor.js's old "bias, not early-return".
var KIND_WEIGHT = {
  link:     0.15,
  button:   0.15,
  input:    0.10,
  label:    0.08,
  text:     0.00,
};
var VIEWPORT_BONUS = 0.10;   // inViewport === true
var NAME_BONUS     = 0.05;   // hasAccessibleName === true
var PREFER_BONUS   = 0.25;   // candidate's kind is in opts.textMatch.prefer
var BOOST_DEFAULT  = 0.20;   // per matched selector substring when boost is a bare list
// Reachability penalties (subtracted): an obstructed/offscreen target loses to a
// reachable one of similar score, without overriding a clearly better match.
var REACH_OBSTRUCTED = 0.20; // clickable === false
var REACH_UNKNOWN    = 0.05; // clickable === null (offscreen / not yet checked)

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function kindBonus(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_WEIGHT, kind) ? KIND_WEIGHT[kind] : 0;
}

function reachPenalty(clickable) {
  if (clickable === false) return REACH_OBSTRUCTED;
  if (clickable === null)  return REACH_UNKNOWN;
  return 0; // true or undefined → no penalty
}

// boost may be: a number-keyed map { "substr": 0.3 }, or a bare list ["substr"]
// (each worth BOOST_DEFAULT). Returns the bonus for a candidate's selector.
function boostBonus(selector, boost) {
  if (!boost || !selector) return 0;
  var sel = String(selector);
  if (Array.isArray(boost)) {
    for (var i = 0; i < boost.length; i++) {
      if (boost[i] && sel.indexOf(String(boost[i])) !== -1) return BOOST_DEFAULT;
    }
    return 0;
  }
  if (typeof boost === 'object') {
    var total = 0;
    for (var key in boost) {
      if (Object.prototype.hasOwnProperty.call(boost, key) && sel.indexOf(key) !== -1) {
        var b = Number(boost[key]);
        if (!isNaN(b)) total += b;
      }
    }
    return total;
  }
  return 0;
}

function isExcluded(cand, excludeList) {
  if (!excludeList.length) return false;
  var sel = cand.selector ? String(cand.selector) : '';
  var txt = cand.text ? String(cand.text) : '';
  for (var i = 0; i < excludeList.length; i++) {
    var ex = String(excludeList[i]);
    if (!ex) continue;
    if (sel && sel.indexOf(ex) !== -1) return true;
    if (txt && txt.indexOf(ex) !== -1) return true;
  }
  return false;
}

/**
 * Rank candidates by base text score + policy. Pure: returns new objects.
 *
 * @param {Array<Object>} cands  Each: { textScore:Number, kind?:String,
 *   inViewport?:Boolean, hasAccessibleName?:Boolean, clickable?:Boolean|null,
 *   selector?:String, text?:String, ...passthrough }
 * @param {Object} [opts]  { textMatch?:{ prefer, scope, index, boost, exclude } }
 * @returns {{ ranked:Array, best:Object|null, chosenIndex:Number }}
 *   ranked items = original cand + { finalScore, signals{} }, sorted desc.
 */
function rankCandidates(cands, opts) {
  opts = opts || {};
  var tm = opts.textMatch || {};
  var preferList  = asList(tm.prefer).map(String);
  var excludeList = asList(tm.exclude);
  var scopeViewport = tm.scope === 'viewport';

  var scored = [];
  for (var i = 0; i < (cands || []).length; i++) {
    var c = cands[i];
    if (!c || typeof c.textScore !== 'number') continue;
    if (isExcluded(c, excludeList)) continue;
    if (scopeViewport && c.inViewport === false) continue;

    var kBonus = kindBonus(c.kind);
    var vBonus = c.inViewport === true ? VIEWPORT_BONUS : 0;
    var nBonus = c.hasAccessibleName === true ? NAME_BONUS : 0;
    var rPen   = reachPenalty(c.clickable);
    var pBonus = preferList.length && c.kind && preferList.indexOf(c.kind) !== -1 ? PREFER_BONUS : 0;
    var bBonus = boostBonus(c.selector, tm.boost);

    var finalScore = c.textScore + kBonus + vBonus + nBonus + pBonus + bBonus - rPen;

    var out = {};
    for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k]; }
    out.finalScore = Math.round(finalScore * 1000) / 1000;
    out.signals = {
      textScore: c.textScore,
      kind: c.kind || null,
      kindBonus: kBonus,
      viewportBonus: vBonus,
      nameBonus: nBonus,
      preferBonus: pBonus,
      boostBonus: bBonus,
      reachPenalty: rPen,
    };
    scored.push(out);
  }

  scored.sort(function (a, b) { return b.finalScore - a.finalScore; });

  // index override picks the Nth of the final ranking (0-based), else the top.
  var chosenIndex = 0;
  if (typeof tm.index === 'number' && tm.index >= 0 && tm.index < scored.length) {
    chosenIndex = tm.index;
  }
  return { ranked: scored, best: scored[chosenIndex] || null, chosenIndex: chosenIndex };
}

/**
 * Slim, serializable explanation of a rank result. No DOM refs — only declared
 * fields are copied, so it is safe to attach to an action/tool response.
 *
 * @returns {{ kind, score, index, candidates:[{ text, kind, score, selector, inViewport, clickable, signals }] }}
 */
function toMatchedBy(rankResult, conf) {
  conf = conf || {};
  var limit = typeof conf.limit === 'number' ? conf.limit : 5;
  var ranked = (rankResult && rankResult.ranked) || [];
  var best = rankResult && rankResult.best;
  var candidates = ranked.slice(0, limit).map(function (c) {
    return {
      text: c.text != null ? String(c.text).slice(0, 80) : undefined,
      kind: c.kind || undefined,
      score: c.finalScore,
      selector: c.selector || undefined,
      inViewport: c.inViewport,
      clickable: c.clickable,
      signals: c.signals,
    };
  });
  return {
    kind: best ? (best.kind || null) : null,
    score: best ? best.finalScore : null,
    index: rankResult ? rankResult.chosenIndex : 0,
    candidates: candidates,
  };
}

var API = {
  rankCandidates: rankCandidates,
  toMatchedBy: toMatchedBy,
  KIND_WEIGHT: KIND_WEIGHT,
};

// ── UMD tail: browser MAIN world (window) + Node (module.exports) ─────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  if (!window.__SI_TEXT_RANK__) window.__SI_TEXT_RANK__ = API;
}
