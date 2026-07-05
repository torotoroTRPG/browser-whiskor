/**
 * tests/unit/hover-lifecycle.test.js
 * Hover lifecycle (unhover + auto-release), while:{keys} hold, and the drag
 * plan/observed two-layer report — implementation pins + shared-sync parity.
 *
 * executor.js lives under shared/ and cannot be require()d in node (MAIN-world
 * IIFE over window/document), so these pin the source the way the canvas
 * boundary tests do: assert the load-bearing shapes exist, byte-identical in
 * both extension copies, and that the server layers expose what the executor
 * implements (producer/consumer drift guard).
 */
// @allow-no-prod-import: parity/drift checker over injected sources (see above).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const shared = read('shared/injected/executor.js');

describe('hover lifecycle — executor (shared)', () => {
  it('tracks hover state and defines the release machinery', () => {
    assert.match(shared, /let HOVER_STATE = null/);
    assert.match(shared, /function fireLeaveChain\(/);
    assert.match(shared, /function releaseHover\(/);
    assert.match(shared, /function parkHover\(/);
    assert.match(shared, /unhover\(action\)/, 'unhover action handler exists');
  });

  it('keeps the hover when the new target is INSIDE the hovered element (menu-item click must not close the menu)', () => {
    assert.match(shared, /old === newEl \|\| old\.contains\(newEl\)/);
  });

  it('mouseleave walks ancestors but stops at ones still containing the destination (real-DOM semantics)', () => {
    assert.match(shared, /if \(toEl && n\.contains\(toEl\)\) break;/);
    assert.match(shared, /relatedTarget: rel/, 'relatedTarget carries where the pointer went');
  });

  it('every mouse action auto-releases: hover, click ×2 paths, right_click ×2 paths, drag, mouse_scroll', () => {
    const n = (shared.match(/releaseHover\(/g) || []).length;
    // 1 definition + 7 call sites
    assert.ok(n >= 8, `expected >=8 occurrences (def + 7 sites), got ${n}`);
    const parked = (shared.match(/parkHover\(el\)/g) || []).length;
    assert.ok(parked >= 3, `hover + both click dispatch paths park the pointer (got ${parked})`);
  });

  it('both extension copies carry the lifecycle (shared sync ran)', () => {
    for (const rel of ['extension/injected/executor.js', 'firefox-mv2/injected/executor.js']) {
      const src = read(rel);
      assert.match(src, /function releaseHover\(/, `${rel} — run scripts/sync-shared.ps1`);
      assert.match(src, /unhover\(action\)/, rel);
    }
  });
});

describe('while:{keys} — declarative hold inside one action', () => {
  it('parses modifiers into flags and holds/releases idempotently', () => {
    assert.match(shared, /function parseWhile\(/);
    assert.match(shared, /function holdWhileKeys\(/);
    assert.match(shared, /if \(released\) return;/, 'release fn is idempotent');
    assert.match(shared, /ShiftLeft/, 'real key codes, not charCodeAt guesses');
  });

  it('click forces the event-dispatch strategy when keys are held (el.click() carries no modifiers)', () => {
    assert.match(shared, /whileHold && \(report\.strategyUsed === 'direct' \|\| report\.strategyUsed === 'programmatic'\)/);
  });

  it('mouse events ride the modifier flags in click and drag', () => {
    const n = (shared.match(/\.\.\.\(whileHold \? whileHold\.flags : \{\}\)/g) || []).length;
    assert.ok(n >= 3, `click analyzer path, click fallback, drag (got ${n})`);
  });
});

describe('drag — plan/observed two-layer report', () => {
  it('plan is resolved BEFORE events fire; observed after settle', () => {
    assert.match(shared, /dropTargetUnderPoint/);
    assert.match(shared, /grabbed: describeTarget\(el\)/);
    assert.match(shared, /dropReceivedBy/);
    assert.match(shared, /grabbedDetached/);
    assert.match(shared, /await waitForClickSettle\(fp, el, 600\)/, 'async reactions get a settle window');
  });

  it('a completed sequence with nothing observed carries the mismatch hint', () => {
    assert.match(shared, /NOTHING observable happened/);
  });
});

describe('server layers expose the executor features (producer/consumer drift)', () => {
  const write = read('server/mcp/tools/write.js');

  it('write.js defines the unhover tool and passes while/abortOnPremiseChange through', () => {
    assert.match(write, /name: 'unhover'/);
    assert.match(write, /type: 'unhover'/);
    assert.match(write, /while:\s*args\.while/, 'while travels on the action');
    assert.match(write, /abortOnPremiseChange: args\.abortOnPremiseChange/);
    assert.match(write, /PREMISE_SCHEMA/);
  });

  it('drag tool description declares the two-layer contract', () => {
    assert.match(write, /`plan`/);
    assert.match(write, /`observed`/);
  });

  it('unhover is registered in the advanced-actions profile and enabled', () => {
    const profiles = JSON.parse(read('server/configs/tool-profiles.json'));
    assert.ok(profiles['advanced-actions'].tools.includes('unhover'));
    assert.ok(profiles['advanced-actions'].triggers.includes('unhover'), 'whole-word trigger (does not match "hover")');
    const toolsCfg = JSON.parse(read('server/configs/mcp-tools.json'));
    assert.equal(toolsCfg.tools.unhover.enabled, true);
    assert.equal(toolsCfg.tools.unhover.category, 'write');
  });
});
