/**
 * tests/unit/layout-map.test.js
 * Exercises the REAL ASCII layout-map renderer (server/layout-map.js): quantize +
 * place pass, kind-shaped ref tokens, reading-order numbering, viewport-relative
 * clipping, borderless vs bordered output, and the legend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderLayoutMap } = require('../../server/layout-map.js');

// A simple 1000x600 viewport with three elements at known spots.
const viewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0 };
const catalog = {
  buttons: [{ text: 'Submit', rect: { x: 880, y: 540, w: 80, h: 30 } }],   // bottom-right
  inputs:  [{ placeholder: 'Search', rect: { x: 400, y: 20, w: 200, h: 28 } }], // top-center
  links:   [{ text: 'Home', rect: { x: 20, y: 20, w: 60, h: 20 } }],        // top-left
};

describe('layout-map renderer', () => {
  it('numbers refs in reading order (top-left first) and shapes brackets by kind', () => {
    const m = renderLayoutMap({ catalog, viewport }, { width: 40, legend: true });
    // Reading order: Home (top-left) = 1, Search (top-center) = 2, Submit (bottom-right) = 3.
    // Brackets encode kind: link <>, input {}, button [].
    assert.match(m.grid, /<1>/, 'link renders as <1>');
    assert.match(m.grid, /\{2\}/, 'input renders as {2}');
    assert.match(m.grid, /\[3\]/, 'button renders as [3]');
    assert.strictEqual(m.counts.interactive, 3);
    assert.strictEqual(m.counts.placed, 3);
    assert.strictEqual(m.counts.overflow, 0);
  });

  it('places elements in roughly the right region (top row vs bottom row)', () => {
    const m = renderLayoutMap({ catalog, viewport }, { width: 40 });
    const lines = m.grid.split('\n');
    const rowOf = (re) => lines.findIndex(l => re.test(l));
    assert.ok(rowOf(/<1>/) < rowOf(/\[3\]/), 'top-left link is above the bottom-right button');
    // top-left link should sit left of the top-center input on its row(s)
    const homeLine = lines[rowOf(/<1>/)];
    assert.ok(homeLine.indexOf('<1>') < (homeLine.indexOf('{2}') === -1 ? Infinity : homeLine.indexOf('{2}')));
  });

  it('is borderless by default and bordered on request', () => {
    const plain = renderLayoutMap({ catalog, viewport }, { width: 40 });
    assert.ok(!/^\+-+\+$/m.test(plain.grid), 'no border rule by default');
    const boxed = renderLayoutMap({ catalog, viewport }, { width: 40, border: true });
    assert.match(boxed.grid, /^\+-+\+$/m, 'bordered output has +--+ rules');
    assert.match(boxed.grid, /^\|.*\|$/m, 'bordered rows are piped');
  });

  it('legend lists each ref with kind, label and center coords', () => {
    const m = renderLayoutMap({ catalog, viewport }, { width: 40, legend: true });
    assert.ok(m.legend, 'legend present');
    assert.match(m.legend, /<1> link "Home" @50,30/);
    assert.match(m.legend, /\{2\} input "Search" @500,34/);
    assert.match(m.legend, /\[3\] button "Submit" @920,555/);
  });

  it('omits the legend when legend:false', () => {
    const m = renderLayoutMap({ catalog, viewport }, { width: 40, legend: false });
    assert.strictEqual(m.legend, null);
    assert.ok(!/LEGEND/.test(m.text));
  });

  it('clips elements outside the current viewport and counts them', () => {
    const scrolled = { width: 1000, height: 600, scrollX: 0, scrollY: 2000 }; // everything is above the fold
    const m = renderLayoutMap({ catalog, viewport: scrolled }, { width: 40 });
    assert.strictEqual(m.counts.placed, 0);
    assert.strictEqual(m.counts.offscreen, 3);
    assert.ok(m.notes.some(n => /outside the current viewport/.test(n)));
  });

  it('falls back to the element bounding box when no viewport is given', () => {
    const m = renderLayoutMap({ catalog }, { width: 40 });
    assert.strictEqual(m.counts.placed, 3);
    assert.ok(m.notes.some(n => /bounding box/.test(n)));
  });

  it('handles an empty page without throwing', () => {
    const m = renderLayoutMap({ catalog: { buttons: [], inputs: [], links: [] } }, { width: 40 });
    assert.strictEqual(m.counts.interactive, 0);
    assert.ok(typeof m.text === 'string');
  });
});
