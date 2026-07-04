/**
 * server/dev-verdict.js
 *
 * verdict engine (docs/vision/whiskor-for-dev/dev-exec.md SECTION 5).
 *
 * Turns a raw exec result — the page-side outcome plus a baseline/observed pair —
 * into a 5-value verdict WITH evidence. The point (5.3) is that the answer is
 * never a bare boolean: it says what changed, what broke, and what settling looked
 * like, so a CI job, an agent, or a human all read the same shape.
 *
 *   clean         ran; no new errors, no observable/ state change
 *   effect        ran; observable change (state hash moved / DOM mutated / harness pass)
 *   regressed     ran but broke it — new console error, uncaught exception, or throw
 *   blocked       never reached execution — gate / csp / origin / size
 *   inconclusive  can't tell — timeout, settle hit its cap, or the tab navigated away
 *
 * A default verdict stands WITHOUT any expectation (5.3): "no new error + no
 * unintended transition" alone separates clean/effect (not broken) from regressed
 * (broken), which is what a watch loop needs. The expectation primitive itself is
 * owned by loop-closure (5.4); this module owns the vocabulary it will share.
 *
 * Pure mapping + append-only persistence — no page/network access here.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_ROOT = process.env.WHISKOR_CACHE_DIR || path.join(__dirname, '..', 'cache', 'sessions');

/**
 * Build a verdict + evidence from an exec's outcome and observations.
 *
 * @param {object} p
 * @param {string} p.outcome    page-side outcome: 'ok'|'error'|'timeout'|'blocked'
 * @param {object} [p.baseline] { stateHash, url, title } captured before eval
 * @param {object} [p.observed] { stateHash, url, mutations, uncaughtErrors[], settledAtCap, navigated }
 * @param {Array}  [p.consoleLogs] console entries captured during the exec window
 * @param {string} [p.mode]     'probe'|'harness'
 * @param {*}      [p.value]     module return (probe) or harness summary
 * @returns {{ verdict: string, evidence: object }}
 */
function buildVerdict(p = {}) {
  const outcome  = p.outcome || 'ok';
  const baseline = p.baseline || null;
  const observed = p.observed || null;
  const consoleLogs = Array.isArray(p.consoleLogs) ? p.consoleLogs : [];

  // New console errors during the window (baseline watermark = start of window, so
  // everything captured here is "new"). warn is not an error — errors only.
  const consoleNew = consoleLogs.filter(e => e && e.level === 'error');
  const uncaught   = (observed && Array.isArray(observed.uncaughtErrors)) ? observed.uncaughtErrors : [];

  const flags = [];
  if (observed && observed.settledAtCap) flags.push('settled_at_cap');
  if (observed && observed.navigated)    flags.push('tab_navigated');

  const stateTransition = (baseline && observed && baseline.stateHash && observed.stateHash
      && baseline.stateHash !== observed.stateHash)
    ? { from: baseline.stateHash, to: observed.stateHash,
        fromUrl: baseline.url, toUrl: observed.url }
    : null;

  const mutations = observed && Number.isFinite(observed.mutations) ? observed.mutations : 0;

  const evidence = {
    consoleNew,
    uncaught,
    stateTransition,
    mutations,
    delta: null,               // filled by the caller when delta-engine has a diff
    expectationResult: null,   // owned by loop-closure (5.4); null in the E3 default
    flags,
  };

  // ── mapping ────────────────────────────────────────────────────────────────
  let verdict;
  if (outcome === 'blocked') {
    verdict = 'blocked';
  } else if (outcome === 'timeout') {
    verdict = 'inconclusive';
  } else if (observed && observed.navigated) {
    // A navigation mid-exec means the runtime we observed is gone — we can't stand
    // behind a clean/effect call for a page that left. (inconclusive, 5.3.)
    verdict = 'inconclusive';
  } else if (outcome === 'error') {
    verdict = 'regressed';         // executed but threw
  } else if (consoleNew.length > 0 || uncaught.length > 0) {
    verdict = 'regressed';         // ran, but the app logged/threw an error as a result
  } else if (p.mode === 'harness' && p.value && Number(p.value.failed) > 0) {
    verdict = 'regressed';         // a harness case failed (6.2 → regressed)
  } else if (stateTransition || mutations > 0
      || (p.mode === 'harness' && p.value && Number(p.value.total) > 0)) {
    verdict = 'effect';            // ran cleanly and something observably changed
  } else {
    verdict = 'clean';             // ran cleanly, touched nothing
  }

  return { verdict, evidence };
}

// ── persistence (5.5) ──────────────────────────────────────────────────────────

function verdictDir(tabId) {
  return path.join(CACHE_ROOT, String(tabId), 'dev');
}

/**
 * Append a verdict record and cap the file at maxVerdicts (oldest dropped).
 * Mirrors dev-audit's append discipline — artifact body never lands here (I-4);
 * only hash/name/verdict/evidence-summary.
 *
 * @returns {boolean} whether the line was persisted
 */
function appendVerdict(tabId, rec, maxVerdicts = 500) {
  try {
    const dir = verdictDir(tabId);
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, 'verdicts.jsonl');
    fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');

    // Cap: only rewrite when comfortably over, so the common path is a bare append.
    const cap = Number.isFinite(maxVerdicts) && maxVerdicts > 0 ? maxVerdicts : 500;
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    if (lines.length > cap * 1.2) {
      const kept = lines.slice(-cap).join('\n') + '\n';
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, kept, 'utf8');
      fs.renameSync(tmp, fp); // atomic replace (same discipline as cache-writer)
    }
    return true;
  } catch (e) {
    try { console.error(`[dev-verdict] append failed (tabId=${tabId}): ${e.message}`); } catch (_) {}
    return false;
  }
}

function readVerdicts(tabId, limit = 100) {
  try {
    const fp = path.join(verdictDir(tabId), 'verdicts.jsonl');
    if (!fs.existsSync(fp)) return [];
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch (_) {} }
    return out;
  } catch { return []; }
}

module.exports = { buildVerdict, appendVerdict, readVerdicts, verdictDir, CACHE_ROOT };
