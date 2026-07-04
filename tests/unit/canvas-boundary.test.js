/**
 * tests/unit/canvas-boundary.test.js
 * Canvas boundary flags — parity + producer/consumer field agreement.
 *
 * ui-catalog.js is NOT under shared/ (see CLAUDE.md): the Chrome and Firefox
 * copies are edited by hand, which is exactly the drift shape that has bitten
 * before. This pins (1) both producers emitting an identical `canvases` block,
 * (2) the executor note being defined and attached, and (3) the server
 * consumers reading the same field names the producers emit.
 */
// @allow-no-prod-import: parity/drift checker — compares the two hand-synced
// ui-catalog.js sources and cross-checks producer/consumer field names with fs;
// injected files cannot be require()d in node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// The canvases collection block: from its lead comment to the closing `}));`.
function canvasBlock(src) {
  const m = src.match(/\/\/ Canvas regions[\s\S]*?\}\)\);/);
  return m ? m[0] : null;
}

describe('canvas boundary — producer parity (ui-catalog, hand-synced pair)', () => {
  const chrome = read('extension/injected/analyzers/ui-catalog.js');
  const firefox = read('firefox-mv2/injected/analyzers/ui-catalog.js');

  it('both extensions collect canvases', () => {
    assert.ok(canvasBlock(chrome), 'Chrome ui-catalog has the canvases block');
    assert.ok(canvasBlock(firefox), 'Firefox ui-catalog has the canvases block');
  });

  it('the canvases block is byte-identical in both extensions', () => {
    assert.strictEqual(canvasBlock(chrome), canvasBlock(firefox),
      'ui-catalog.js is outside shared/ — edit BOTH copies (CLAUDE.md)');
  });

  it('both emit canvases in the payload and the counts', () => {
    for (const [name, src] of [['chrome', chrome], ['firefox', firefox]]) {
      assert.match(src, /canvases:\s*canvases\.length/, `${name}: counts.canvases`);
      assert.match(src, /hidden,\s*canvases,/, `${name}: canvases in payload`);
    }
  });
});

describe('canvas boundary — executor note', () => {
  const shared = read('shared/injected/executor.js');

  it('defines canvasNote with direct/overlay hits and multi-canvas identity', () => {
    assert.match(shared, /function canvasNote\(/);
    assert.match(shared, /hit:\s*'direct'/);
    assert.match(shared, /hit:\s*'overlay'/);
    assert.match(shared, /elementsFromPoint/, 'overlay uses true z-order, not rect intersection');
    assert.match(shared, /totalCanvases/, 'multiple canvases are first-class');
  });

  it('attaches the note to click, right_click and hover returns (5 sites)', () => {
    const n = (shared.match(/\.\.\.canvasNote\(el\)/g) || []).length;
    assert.ok(n >= 5, `expected >=5 attach sites (click×2, right_click×2, hover), got ${n}`);
  });

  it('both extension copies carry the note (shared sync ran)', () => {
    for (const rel of ['extension/injected/executor.js', 'firefox-mv2/injected/executor.js']) {
      assert.match(read(rel), /function canvasNote\(/, `${rel} — run scripts/sync-shared.ps1`);
    }
  });
});

describe('canvas boundary — server consumers read what the producer emits', () => {
  it('layout-map renders catalog.canvases', () => {
    const src = read('server/layout-map.js');
    assert.match(src, /catalog\.canvases/);
    assert.match(src, /CANVAS_FILL/);
  });

  it('find_target reads ui.canvases and reports overCanvas', () => {
    const src = read('server/mcp/tools/read-data.js');
    assert.match(src, /ui && ui\.canvases/);
    assert.match(src, /overCanvas/);
  });
});
