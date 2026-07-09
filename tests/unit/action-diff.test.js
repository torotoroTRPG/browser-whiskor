/**
 * tests/unit/action-diff.test.js
 *
 * Action-anchored diff — pure diff functions + runner orchestration.
 * The diff joins two cached snapshots (ui-catalog + text-coords + viewport)
 * into element-level events; the runner wires baseline → collect → freshness
 * poll → join around an action.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actionDiff = require('../../server/action-diff');
const { computeDiff, diffInteractive, diffText, createDiffRunner } = actionDiff;

// ── fixtures ──────────────────────────────────────────────────────────────────

function catalog(buttons = [], inputs = [], links = []) {
  return { buttons, inputs, links, capturedAt: Date.now() };
}
const btn = (label, x, y) => ({ label, rect: { x, y, w: 80, h: 30 } });

function textCoords(words, pageUrl = 'https://example.com/') {
  return { pageUrl, words, totalWords: words.length };
}
const word = (text, x, y, extra = {}) => ({ text, absoluteX: x, absoluteY: y, ...extra });

// ── diffInteractive ───────────────────────────────────────────────────────────

describe('diffInteractive', () => {
  it('reports appeared / disappeared / moved in layout-map vocabulary', () => {
    const before = catalog([btn('送信', 100, 200), btn('キャンセル', 200, 200)]);
    const after  = catalog([btn('送信', 100, 400), btn('help', 300, 300)]);

    const d = diffInteractive(before, after);
    assert.equal(d.appeared.length, 1);
    assert.equal(d.appeared[0].label, 'help');
    assert.equal(d.appeared[0].kind, 'button');
    assert.equal(d.disappeared.length, 1);
    assert.equal(d.disappeared[0].label, 'キャンセル');
    assert.equal(d.moved.length, 1);
    assert.equal(d.moved[0].label, '送信');
    assert.equal(d.moved[0].from.y, 215); // rect center
    assert.equal(d.moved[0].to.y, 415);
  });

  it('does not report sub-threshold jitter as movement', () => {
    const before = catalog([btn('送信', 100, 200)]);
    const after  = catalog([btn('送信', 102, 201)]);
    const d = diffInteractive(before, after);
    assert.equal(d.moved.length, 0);
    assert.equal(d.appeared.length, 0);
    assert.equal(d.disappeared.length, 0);
  });

  it('pairs duplicate labels by position instead of flagging them all', () => {
    // Two "削除" buttons; one disappears. The nearer survivor must pair.
    const before = catalog([btn('削除', 100, 100), btn('削除', 100, 500)]);
    const after  = catalog([btn('削除', 100, 100)]);
    const d = diffInteractive(before, after);
    assert.equal(d.disappeared.length, 1);
    assert.equal(d.disappeared[0].at.y, 515);
    assert.equal(d.moved.length, 0);
  });
});

// ── diffText ──────────────────────────────────────────────────────────────────

describe('diffText', () => {
  it('pairs a removed+added text at the same position into ONE changed entry', () => {
    const before = textCoords([word('残り 5 個', 300, 120), word('タイトル', 10, 10)]);
    const after  = textCoords([word('残り 4 個', 300, 120), word('タイトル', 10, 10)]);
    const d = diffText(before, after);
    assert.equal(d.changed.length, 1);
    assert.deepEqual({ from: d.changed[0].from, to: d.changed[0].to }, { from: '残り 5 個', to: '残り 4 個' });
    assert.equal(d.appeared.length, 0);
    assert.equal(d.disappeared.length, 0);
  });

  it('reports distant removed/added texts separately (no false pairing)', () => {
    const before = textCoords([word('エラーが発生しました', 100, 900)]);
    const after  = textCoords([word('保存しました', 100, 50)]);
    const d = diffText(before, after);
    assert.equal(d.changed.length, 0);
    assert.equal(d.disappeared.length, 1);
    assert.equal(d.appeared.length, 1);
  });

  it('ignores fromCache retention entries — they are exactly the "gone" texts', () => {
    // cache-writer keeps not-re-observed words as fromCache:true; counting them
    // as live would hide every disappearance.
    const before = textCoords([word('モーダル', 200, 200)]);
    const after  = textCoords([word('モーダル', 200, 200, { fromCache: true, inViewport: false })]);
    const d = diffText(before, after);
    assert.equal(d.disappeared.length, 1);
    assert.equal(d.disappeared[0].text, 'モーダル');
  });

  it('same text present on both sides is not churn', () => {
    const w = [word('固定ヘッダ', 0, 0), word('本文', 10, 100)];
    const d = diffText(textCoords(w), textCoords(w));
    assert.equal(d.appeared.length + d.disappeared.length + d.changed.length, 0);
  });
});

// ── computeDiff ───────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  const snap = (cat, tc, vp) => ({ catalog: cat, textCoords: tc, viewport: vp, at: Date.now() });

  it('unchanged:true when nothing differs', () => {
    const cat = catalog([btn('送信', 100, 200)]);
    const tc  = textCoords([word('本文', 10, 100)]);
    const vp  = { scrollX: 0, scrollY: 0 };
    const d = computeDiff(snap(cat, tc, vp), snap(cat, tc, vp));
    assert.equal(d.available, true);
    assert.equal(d.unchanged, true);
  });

  it('reports the viewport scroll', () => {
    const cat = catalog();
    const tc = textCoords([]);
    const d = computeDiff(
      snap(cat, tc, { scrollX: 0, scrollY: 0 }),
      snap(cat, tc, { scrollX: 0, scrollY: 800 }),
    );
    assert.equal(d.unchanged, false);
    assert.deepEqual(d.viewport.scrolled.to, { x: 0, y: 800 });
  });

  it('caps lists but reports full counts', () => {
    const many = Array.from({ length: 30 }, (_, i) => word(`行${i}`, 10, i * 20));
    const d = computeDiff(
      snap(catalog(), textCoords([])),
      snap(catalog(), textCoords(many)),
      { maxEntries: 5 },
    );
    assert.equal(d.text.appeared.length, 5);
    assert.equal(d.counts.text.appeared, 30);
    assert.equal(d.truncated, true);
  });

  it('notes a navigation when pageUrl changed', () => {
    const d = computeDiff(
      snap(catalog(), textCoords([word('旧', 0, 0)], 'https://a.example/')),
      snap(catalog(), textCoords([word('新', 0, 0)], 'https://b.example/')),
    );
    assert.ok(d.notes.some(n => n.includes('navigated')));
  });
});

// ── createDiffRunner ──────────────────────────────────────────────────────────

describe('createDiffRunner', () => {
  function fakeDeps({ files = {}, freshAt = {} } = {}) {
    const collected = [];
    const cache = {
      readSessionFile: (tabId, name) => files[name] ?? null,
      freshnessInfo: (tabId, plugin) =>
        freshAt[plugin] ? { available: true, capturedAt: freshAt[plugin] } : { available: false },
    };
    return {
      collected,
      deps: {
        cache,
        triggerCollect: (tabId, plugins) => collected.push({ tabId, plugins }),
        getConfig: () => ({ agentControl: { actionDiff: { settleDelayMs: 1, collectTimeoutMs: 120, pollIntervalMs: 10 } } }),
      },
      files, freshAt,
    };
  }

  it('diffs baseline against the post-collect snapshot once freshness lands', async () => {
    const f = fakeDeps({
      files: {
        'raw/ui/elements.json': catalog([btn('送信', 100, 200)]),
        'raw/visual/text-coords.json': textCoords([word('前', 10, 10)]),
        'raw/visual/viewport.json': { scrollX: 0, scrollY: 0 },
      },
    });
    const runner = createDiffRunner(f.deps);
    const base = await runner.baseline(1);

    // The "collect" lands: files change and freshness advances past the action.
    f.files['raw/visual/text-coords.json'] = textCoords([word('後', 10, 10)]);
    f.freshAt['text-coords'] = Date.now() + 1000;
    f.freshAt['ui-catalog'] = Date.now() + 1000;

    const d = await runner.diffSince(1, base);
    assert.equal(d.available, true);
    assert.equal(d.text.changed.length, 1);
    assert.deepEqual({ from: d.text.changed[0].from, to: d.text.changed[0].to }, { from: '前', to: '後' });
    assert.deepEqual(f.collected[0].plugins, ['text-coords', 'ui-catalog']);
  });

  it('degrades to available:false when the collect never lands', async () => {
    const f = fakeDeps({ files: { 'raw/ui/elements.json': catalog() } });
    const runner = createDiffRunner(f.deps);
    const base = await runner.baseline(1);
    const d = await runner.diffSince(1, base); // freshness never advances
    assert.equal(d.available, false);
    assert.ok(d.reason.includes('did not land'));
  });

  it('auto mode follows the live config', () => {
    let auto = false;
    const runner = createDiffRunner({
      cache: {}, triggerCollect: () => {},
      getConfig: () => ({ agentControl: { actionDiff: { auto } } }),
    });
    assert.equal(runner.autoEnabled(), false);
    auto = true;
    assert.equal(runner.autoEnabled(), true);
  });
});

// ── wiring pin ────────────────────────────────────────────────────────────────

describe('diff runner wiring (index.js)', () => {
  it('reads the full server config (_cfg), not the SW-bound core.globalConfig', () => {
    // Field-report regression: core.globalConfig is the SERVICE-WORKER config
    // subset (autoSwitchTab etc.) and never contains agentControl.actionDiff —
    // wiring getConfig to it made actionDiff.auto silently unreachable, and
    // config.local.json could not fix it.
    const { readFileSync } = require('node:fs');
    const path = require('node:path');
    const { fileURLToPath } = require('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(dir, '../../server/index.js'), 'utf8');
    const block = src.match(/createDiffRunner\(\{[\s\S]{0,400}?\}\)\)/);
    assert.ok(block, 'index.js should wire createDiffRunner');
    assert.match(block[0], /getConfig:\s*\(\)\s*=>\s*_cfg\b/,
      'diff runner getConfig must return _cfg (full server config)');
    assert.doesNotMatch(block[0], /globalConfig/,
      'diff runner must not read core.globalConfig (SW subset without actionDiff)');
  });
});
