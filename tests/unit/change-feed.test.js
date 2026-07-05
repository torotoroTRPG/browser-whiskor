/**
 * tests/unit/change-feed.test.js
 * Premise-change feed — real behaviour of server/change-feed.js plus wiring pins
 * (sources in core.js, central piggyback in mcp/registry.js, premise gate in
 * action-executor.js). See docs/ideas/PREMISE_CHANGE_FEED.md.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { ChangeFeed } = require('../../server/change-feed');

describe('change-feed — attribution (action windows)', () => {
  it('records when no action is in flight', () => {
    const f = new ChangeFeed();
    assert.equal(f.record(1, { kind: 'modal', note: 'modal opened: #m' }), true);
    assert.equal(f.pendingCount(1), 1);
  });

  it('drops changes inside an action window (they are the action\'s own)', () => {
    const f = new ChangeFeed();
    f.beginActionWindow(1);
    assert.equal(f.record(1, { kind: 'modal', note: 'x' }), false);
    assert.equal(f.pendingCount(1), 0);
  });

  it('drops changes in the trailing grace window, records after it', async () => {
    const f = new ChangeFeed({ actionTrailMs: 30 });
    f.beginActionWindow(1);
    f.endActionWindow(1);
    assert.equal(f.record(1, { kind: 'modal', note: 'late own effect' }), false);
    await sleep(45);
    assert.equal(f.record(1, { kind: 'modal', note: 'external' }), true);
  });

  it('overlapping windows never un-mark each other (counter, not flag)', () => {
    const f = new ChangeFeed();
    f.beginActionWindow(1);
    f.beginActionWindow(1);
    f.endActionWindow(1);
    assert.equal(f.record(1, { kind: 'modal', note: 'x' }), false, 'second action still in flight');
  });

  it('windows are per-tab', () => {
    const f = new ChangeFeed();
    f.beginActionWindow(1);
    assert.equal(f.record(2, { kind: 'modal', note: 'other tab' }), true);
  });
});

describe('change-feed — coalescing, drain, lifecycle', () => {
  it('coalesces by key: a scroll burst is ONE line with final position and original from', () => {
    const f = new ChangeFeed();
    f.record(1, { kind: 'scroll', key: 'scroll', data: { from: { x: 0, y: 300 }, to: { x: 0, y: 500 } } });
    f.record(1, { kind: 'scroll', key: 'scroll', data: { from: { x: 0, y: 500 }, to: { x: 0, y: 1840 } } });
    const lines = f.peek(1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /now at \(0, 1840\)/);
    assert.match(lines[0], /was \(0, 300\)/, 'the "was" stays what the agent last knew');
  });

  it('drain returns formatted lines AND clears — "since your last look" is literal', () => {
    const f = new ChangeFeed();
    f.record(1, { kind: 'modal', note: 'modal opened: div.confirm' });
    const out = f.drain(1);
    assert.equal(out.length, 1);
    assert.match(out[0], /^\[(just now|\d+s ago)\] modal opened: div\.confirm$/);
    assert.deepEqual(f.drain(1), [], 'second drain is empty');
  });

  it('peek does not clear (pre-action premise check)', () => {
    const f = new ChangeFeed();
    f.record(1, { kind: 'navigate', note: 'navigated: now at https://x' });
    assert.equal(f.peek(1).length, 1);
    assert.equal(f.peek(1).length, 1);
  });

  it('ring cap drops oldest and marks truncation on drain', () => {
    const f = new ChangeFeed({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) f.record(1, { kind: 'modal', note: `n${i}` });
    const out = f.drain(1);
    assert.equal(out.length, 4, '3 entries + 1 truncation notice');
    assert.match(out[0], /dropped/);
    assert.match(out[1], /n2/, 'oldest surviving entry is n2');
  });

  it('dropTab discards everything (tab closed = premise gone)', () => {
    const f = new ChangeFeed();
    f.record(1, { kind: 'modal', note: 'x' });
    f.dropTab(1);
    assert.deepEqual(f.drain(1), []);
  });
});

describe('change-feed — wiring pins (producer/consumer drift guard)', () => {
  it('core.js records from VIEWPORT_UPDATE / DOM_MUTATION / PAGE_NAVIGATED and drops on TAB_CLOSED', () => {
    const core = read('server/core.js');
    assert.match(core, /kind:\s*'scroll',\s*key:\s*'scroll'/, 'scroll coalesce key');
    assert.match(core, /dialogAppeared/, 'modal open flag consumed');
    assert.match(core, /dialogRemoved/, 'modal close flag consumed');
    assert.match(core, /kind:\s*'navigate'/, 'navigation recorded');
    assert.match(core, /changeFeed\.dropTab\(msg\.tabId\)/, 'tab close discards the buffer');
    assert.match(core, /\/api\\\/changes\\\//, 'GET /api/changes/:tabId route exists');
  });

  it('the dom-mutations analyzer (shared + both extensions) emits the dialog flags core reads', () => {
    for (const rel of ['shared/injected/analyzers/dom-mutations.js',
                       'extension/injected/analyzers/dom-mutations.js',
                       'firefox-mv2/injected/analyzers/dom-mutations.js']) {
      const src = read(rel);
      assert.match(src, /dialogAppeared/, `${rel} — run scripts/sync-shared.ps1`);
      assert.match(src, /dialogRemoved/, rel);
      assert.match(src, /\[role="alertdialog"\]/, rel);
    }
  });

  it('registry attaches _sinceYourLastLook centrally via the _drainChanges callback', () => {
    const src = read('server/mcp/registry.js');
    assert.match(src, /_sinceYourLastLook/);
    assert.match(src, /_drainChanges/);
    assert.match(src, /_attachChangeFeed\(\{ \.\.\.result, \.\.\.responseExtras \}, args\)/, 'tool-manager path attaches');
    assert.match(src, /_attachChangeFeed\(await handler\(args, _callbacks\), args\)/, 'bare path attaches');
  });

  it('index.js wires _drainChanges in BOTH modes (in-process + proxy HTTP)', () => {
    const src = read('server/index.js');
    assert.match(src, /core\.changeFeed\.drain\(tabId\)/, 'standalone drains in-process');
    assert.match(src, /\/api\/changes\/\$\{tabId\}\?drain=1/, 'proxy drains over HTTP');
  });

  it('action-executor marks windows on every exit path and honours abortOnPremiseChange', () => {
    const src = read('server/action-executor.js');
    assert.match(src, /beginActionWindow\(tabId\)/);
    const closes = (src.match(/closeWindow\(\);/g) || []).length;
    assert.ok(closes >= 3, `timeout, no-broadcast, and result paths all close the window (got ${closes})`);
    assert.match(src, /abortOnPremiseChange === true/);
    assert.match(src, /aborted:\s*'premise_changed'/);
    assert.match(src, /peek\(tabId\)/, 'gate peeks (drain stays for the piggyback)');
  });

  it('config.json ships the public defaults (enabled, bounded buffer)', () => {
    const cfg = JSON.parse(read('config.json'));
    assert.equal(cfg.agentControl.changeFeed.enabled, true);
    assert.ok(cfg.agentControl.changeFeed.maxEntries > 0);
    assert.ok(cfg.agentControl.changeFeed.actionTrailMs >= 0);
  });
});
