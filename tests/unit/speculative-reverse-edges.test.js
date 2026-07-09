/**
 * tests/unit/speculative-reverse-edges.test.js
 *
 * S1 — speculative go_back reverse edges (docs/ideas/REVERSE_EDGE_NAVIGATION.md).
 *
 * Exercises the REAL server/state-navigator.js + state-store.js:
 *   - candidate derivation: URL-changing forwards only, submit-shaped skipped,
 *     real reverse edges deduplicate, blacklist honored
 *   - findPath offers candidates only when asked (verified traversals)
 *   - navigate(): a verified guess is persisted with basis (earned), a failed
 *     guess blacklists itself and falls through to the honest URL fallback
 *   - getNavigationPath reports speculative steps as speculative
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nav = require('../../server/state-navigator');
const store = require('../../server/state-store');

const SV_EARN = '__unit_spec_earn__';
const SV_FAIL = '__unit_spec_fail__';
const SV_DLG  = '__unit_spec_dialog__';
const GRAPH_DIR = process.env.WHISKOR_GRAPH_DIR
  || fileURLToPath(new URL('../../cache/graphs/', import.meta.url));

after(() => {
  for (const sv of [SV_EARN, SV_FAIL, SV_DLG]) {
    try { fs.rmSync(path.join(GRAPH_DIR, `${sv}.json.gz`), { force: true }); } catch (_) {}
  }
});

beforeEach(() => nav._clearSpeculativeBlacklist());

// ── Candidate derivation ─────────────────────────────────────────────────────

function forwardGraph({ fromUrl = 'https://x/a', toUrl = 'https://x/b', edge = {} } = {}) {
  return {
    siteVersion: 'g1',
    nodes: { a: { url: fromUrl }, b: { url: toUrl } },
    edges: { a: { 'click:next': { from: 'a', to: 'b', action: 'click', trigger: 'next', confidence: 0.9, ...edge } } },
  };
}

describe('S1 candidate derivation', () => {
  it('a URL-changing forward a→b yields a go_back candidate b→a', () => {
    const byFrom = nav._speculativeReverseEdges(forwardGraph(), 0.3);
    assert.strictEqual(byFrom.b.length, 1);
    const c = byFrom.b[0];
    assert.strictEqual(c.to, 'a');
    assert.strictEqual(c.action, 'go_back');
    assert.strictEqual(c.speculative, true);
    assert.strictEqual(c.basis, 'speculative-history');
    assert.deepStrictEqual(c.replayAction, { type: 'go_back' });
  });

  it('same-URL forwards produce nothing (history has no entry to go back to)', () => {
    const byFrom = nav._speculativeReverseEdges(forwardGraph({ toUrl: 'https://x/a' }), 0.3);
    assert.deepStrictEqual(byFrom, {});
  });

  it('submit-shaped forwards are skipped (no fake undo)', () => {
    for (const edge of [
      { action: 'type_text' },
      { trigger: '送信' },
      { replayAction: { type: 'click', selector: 'button[type=submit]' } },
    ]) {
      const byFrom = nav._speculativeReverseEdges(forwardGraph({ edge }), 0.3);
      assert.deepStrictEqual(byFrom, {}, `submit shape must not invert: ${JSON.stringify(edge)}`);
    }
  });

  it('an existing real reverse edge suppresses the guess', () => {
    const g = forwardGraph();
    g.edges.b = { 'click:back': { from: 'b', to: 'a', action: 'click', trigger: 'back', confidence: 0.9 } };
    assert.deepStrictEqual(nav._speculativeReverseEdges(g, 0.3), {});
  });

  it('duplicate forwards collapse into one candidate', () => {
    const g = forwardGraph();
    g.edges.a['click:other'] = { from: 'a', to: 'b', action: 'click', trigger: 'other', confidence: 0.9 };
    assert.strictEqual(nav._speculativeReverseEdges(g, 0.3).b.length, 1);
  });
});

// ── S2: dialog dismissal candidates ──────────────────────────────────────────

describe('S2 dismiss candidates (Escape)', () => {
  it('a dialog-opening forward yields an Escape candidate even on the same URL', () => {
    const g = forwardGraph({ toUrl: 'https://x/a', edge: { dialogAppeared: true } });
    const byFrom = nav._speculativeReverseEdges(g, 0.3);
    assert.strictEqual(byFrom.b.length, 1);
    const c = byFrom.b[0];
    assert.strictEqual(c.action, 'press_key');
    assert.strictEqual(c.trigger, 'Escape');
    assert.strictEqual(c.basis, 'speculative-dismiss');
    assert.ok(Math.abs(c.confidence - 0.35) < 1e-9);
    assert.deepStrictEqual(c.replayAction, { type: 'press_key', key: 'Escape' });
  });

  it('URL change + dialog produce both candidates, best prior first', () => {
    const g = forwardGraph({ edge: { dialogAppeared: true } });
    const list = nav._speculativeReverseEdges(g, 0.3).b;
    assert.deepStrictEqual(list.map(c => c.action), ['go_back', 'press_key']);
  });

  it('Escape stays offered for submit-shaped openers (dismissal is not an undo)', () => {
    const g = forwardGraph({ edge: { trigger: '送信', dialogAppeared: true } });
    const list = nav._speculativeReverseEdges(g, 0.3).b;
    assert.deepStrictEqual(list.map(c => c.action), ['press_key'],
      'go_back suppressed for the submit shape, Escape kept');
  });

  it('STATE_TRANSITION dialogAppeared lands on the stored edge, sticky', () => {
    store.addEdge(SV_DLG, { from: 'hashA', to: 'hashD', action: 'click', trigger: 'open', dialogAppeared: true });
    assert.strictEqual(store.getGraph(SV_DLG).edges.hashA['click:open'].dialogAppeared, true);
    // Re-observation without the flag must not erase it
    store.addEdge(SV_DLG, { from: 'hashA', to: 'hashD', action: 'click', trigger: 'open' });
    assert.strictEqual(store.getGraph(SV_DLG).edges.hashA['click:open'].dialogAppeared, true);
  });

  it('emitter payload pin: state-reporter samples dialog presence at settle time', () => {
    for (const rel of [
      'shared/injected/state-reporter.js',
      'extension/injected/state-reporter.js',
      'firefox-mv2/injected/state-reporter.js',
    ]) {
      const src = fs.readFileSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), rel), 'utf8');
      assert.match(src, /dialogAppeared:/, `${rel}: STATE_TRANSITION lost the dialogAppeared field`);
      assert.match(src, /role="dialog"/, `${rel}: dialog boundary selector missing`);
    }
  });
});

// ── findPath integration ─────────────────────────────────────────────────────

describe('S1 findPath', () => {
  it('offers the reverse route only when speculation is enabled', () => {
    const g = forwardGraph();
    assert.strictEqual(nav.findPath(g, 'b', 'a'), null, 'default stays observation-only');
    const p = nav.findPath(g, 'b', 'a', 0.3, { speculative: true });
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].action, 'go_back');
    assert.strictEqual(p[0].speculative, true);
  });
});

// ── navigate(): earn on success, blacklist + honest fallback on failure ──────

/** Resolves each REQUEST_STATE_HASH with the next queued hash. */
function makeBroadcast(queue) {
  return (msg) => {
    if (msg.type !== 'REQUEST_STATE_HASH') return;
    const hash = queue.shift();
    setImmediate(() => nav.handleHashReport({ requestId: msg.requestId, payload: { compositeHash: hash } }));
  };
}

function seedForwardGraph(sv) {
  store.addNode(sv, { hash: 'hashA', url: 'https://x/a' });
  store.addNode(sv, { hash: 'hashB', url: 'https://x/b' });
  store.addEdge(sv, { from: 'hashA', to: 'hashB', action: 'click', trigger: 'next' });
}

describe('S1 navigate — earned persistence', () => {
  it('a verified go_back guess is persisted with basis and reused as a real edge', async () => {
    seedForwardGraph(SV_EARN);
    const actions = [];
    const executeAction = async (tabId, action) => { actions.push(action); return { ok: true }; };
    // initial hash, step verification, final verification
    const broadcast = makeBroadcast(['hashB', 'hashA', 'hashA']);

    const res = await nav.navigate(1, 'hashA', { siteVersion: SV_EARN }, executeAction, broadcast);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.exactMatch, true);
    assert.strictEqual(res.usedSpeculative, true);
    assert.strictEqual(res.path[0].speculative, true);
    assert.deepStrictEqual(actions, [{ type: 'go_back' }]);

    const earned = store.getGraph(SV_EARN).edges.hashB['go_back:?'];
    assert.ok(earned, 'verified guess must be persisted');
    assert.strictEqual(earned.basis, 'speculative-history');
    assert.strictEqual(earned.replayable, true);

    // The next plan needs no speculation: the earned edge is a real edge now.
    const p = nav.findPath(store.getGraph(SV_EARN), 'hashB', 'hashA');
    assert.ok(p && p.length === 1 && !p[0].speculative);
  });
});

describe('S1 navigate — failed guess', () => {
  it('blacklists itself and falls through to the URL fallback, honestly marked', async () => {
    seedForwardGraph(SV_FAIL);
    const actions = [];
    const executeAction = async (tabId, action) => { actions.push(action); return { ok: true }; };
    // initial hash, mismatching step verification, post-fallback verification
    const broadcast = makeBroadcast(['hashB', 'hashX', 'hashA']);

    const res = await nav.navigate(1, 'hashA', { siteVersion: SV_FAIL }, executeAction, broadcast);

    assert.strictEqual(res.ok, true, 'URL fallback still reaches the target hash');
    assert.strictEqual(res.fallback, 'url');
    assert.match(res.note, /SPA state was reset/);
    assert.strictEqual(res.path[0].speculative, true);
    assert.strictEqual(res.path[0].ok, false);
    assert.deepStrictEqual(actions, [
      { type: 'go_back' },
      { type: 'navigate', url: 'https://x/a' },
    ]);

    // The failed guess must not be offered again this process.
    const byFrom = nav._speculativeReverseEdges(store.getGraph(SV_FAIL), 0.3);
    assert.deepStrictEqual(byFrom, {}, 'blacklisted guess must not resurface');
    // And nothing was persisted for it.
    assert.ok(!store.getGraph(SV_FAIL).edges.hashB?.['go_back:?'], 'failed guess must not be persisted');
  });
});

// ── Dry-run honesty ──────────────────────────────────────────────────────────

describe('S1 getNavigationPath', () => {
  it('reports speculative steps as speculative, with a warning', () => {
    // SV_EARN now holds the earned edge from the navigate test above, so use a
    // fresh in-store graph via the fail SV's forward direction: b→a is
    // blacklisted per-process only when THIS process failed it — cleared here.
    nav._clearSpeculativeBlacklist();
    const res = nav.getNavigationPath('hashB', 'hashA', SV_FAIL);
    assert.strictEqual(res.reachable, true);
    assert.strictEqual(res.speculativeSteps, 1);
    assert.strictEqual(res.path[0].speculative, true);
    assert.ok(res.warnings.some(w => /speculative/.test(w)));
  });
});
