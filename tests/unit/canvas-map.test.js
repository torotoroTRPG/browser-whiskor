/**
 * tests/unit/canvas-map.test.js
 * State-first canvas map (server/canvas-map.js): spatial-field discovery over a
 * framework snapshot (store arrays / id-maps / componentTree prop-groups),
 * crop→scale rendering with the density ladder (grid vs list, empty-row
 * collapse), hints overrides, honest '[deep]' truncation reporting — plus
 * wiring pins for the MCP tool, HTTP endpoint and profile registration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const require_ = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const {
  getCanvasMap, renderCanvasMap, extractSpatialCandidates,
  resolveByPath, detectFields, annotateCanvas,
} = require_('../../server/canvas-map.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

// 12 pieces spread over a 1100×1100 board — enough distinct cells for the
// density rule to pick a grid.
const pieces = [
  { id: 'p1',  name: 'Knight', x: 0,    y: 0,    width: 50, height: 50 },
  { id: 'p2',  name: 'Rook',   x: 500,  y: 0,    width: 50, height: 50 },
  { id: 'p3',  name: 'Pawn',   x: 1050, y: 0,    width: 50, height: 50 },
  { id: 'p4',  name: 'Mage',   x: 0,    y: 300,  width: 50, height: 50 },
  { id: 'p5',  name: 'Ogre',   x: 700,  y: 300,  width: 50, height: 50 },
  { id: 'p6',  name: 'Bard',   x: 300,  y: 500,  width: 50, height: 50 },
  { id: 'p7',  name: 'Wolf',   x: 900,  y: 500,  width: 50, height: 50 },
  { id: 'p8',  name: 'King',   x: 100,  y: 700,  width: 50, height: 50 },
  { id: 'p9',  name: 'Slime',  x: 600,  y: 700,  width: 50, height: 50 },
  { id: 'p10', name: 'Ghost',  x: 1050, y: 700,  width: 50, height: 50 },
  { id: 'p11', name: 'Drake',  x: 200,  y: 1050, width: 50, height: 50 },
  { id: 'p12', name: 'Fairy',  x: 800,  y: 1050, width: 50, height: 50 },
];

const boardState = {
  framework: 'react',
  capturedAt: 1,
  redux: {
    board: { pieces },
    // decoy: fewer, less-complete objects must score below the pieces array
    markers: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }],
    ui: { theme: 'dark', volume: 3 },
  },
};

const componentState = {
  framework: 'react',
  componentTree: {
    n: 'App', t: 0, d: 0, c: [
      {
        n: 'Board', t: 0, d: 1, c: [
          { n: 'Piece', t: 0, d: 2, p: { x: 10, y: 20, name: 'A' } },
          { n: 'Piece', t: 0, d: 2, p: { x: 30, y: 40, name: 'B' } },
          { n: 'Piece', t: 0, d: 2, p: { x: 50, y: 60, name: 'C' } },
          // weak-named (derived) components never form a group
          { n: 'Derived', w: 1, t: 0, d: 2, p: { x: 1, y: 2 } },
          { n: 'Derived', w: 1, t: 0, d: 2, p: { x: 3, y: 4 } },
          { n: 'Derived', w: 1, t: 0, d: 2, p: { x: 5, y: 6 } },
        ],
      },
    ],
  },
};

// ── Field detection ──────────────────────────────────────────────────────────

describe('canvas-map — detectFields', () => {
  it('detects direct x/y plus size and label fields', () => {
    const f = detectFields(pieces);
    assert.equal(f.x, 'x');
    assert.equal(f.y, 'y');
    assert.equal(f.w, 'width');
    assert.equal(f.h, 'height');
    assert.equal(f.label, 'name');
  });

  it('detects nested position.x/.y', () => {
    const items = [
      { position: { x: 1, y: 2 }, title: 'a' },
      { position: { x: 3, y: 4 }, title: 'b' },
    ];
    const f = detectFields(items);
    assert.equal(f.x, 'position.x');
    assert.equal(f.y, 'position.y');
  });

  it('returns null when no coordinate pair reaches coverage', () => {
    assert.equal(detectFields([{ a: 1 }, { b: 2 }]), null);
    assert.equal(detectFields([{ x: 'left', y: 'top' }, { x: 'a', y: 'b' }]), null);
  });
});

// ── Discovery heuristic ──────────────────────────────────────────────────────

describe('canvas-map — extractSpatialCandidates', () => {
  it('finds a store array of spatial objects with its dot-path', () => {
    const { candidates } = extractSpatialCandidates(boardState);
    const top = candidates[0];
    assert.equal(top.path, 'redux.board.pieces');
    assert.equal(top.kind, 'array');
    assert.equal(top.count, 12);
  });

  it('scores the complete collection above the plain decoy', () => {
    const { candidates } = extractSpatialCandidates(boardState);
    const paths = candidates.map(c => c.path);
    assert.ok(paths.includes('redux.markers'), 'decoy is still listed');
    assert.ok(candidates[0].score > candidates.find(c => c.path === 'redux.markers').score);
  });

  it('finds id-keyed maps (entity-adapter shape) and keeps keys as labels', () => {
    const state = {
      redux: { entities: { chars: {
        alice: { x: 1, y: 2 }, bob: { x: 3, y: 4 }, carol: { x: 5, y: 6 },
      } } },
    };
    const { candidates } = extractSpatialCandidates(state);
    const m = candidates.find(c => c.path === 'redux.entities.chars');
    assert.equal(m.kind, 'map');
    assert.equal(m.count, 3);
  });

  it('groups same-named componentTree props (components.<Name>), excluding weak names', () => {
    const { candidates } = extractSpatialCandidates(componentState);
    const g = candidates.find(c => c.path === 'components.Piece');
    assert.ok(g, 'Piece group found');
    assert.equal(g.count, 3);
    assert.ok(!candidates.some(c => c.path === 'components.Derived'), 'weak names never group');
  });

  it('accepts a single-element collection (a board with one piece is a real board)', () => {
    const state = { redux: { entities: { things: { only: { x: -8, y: -9, width: 6, height: 6 } } } } };
    const { candidates } = extractSpatialCandidates(state);
    const c = candidates.find(x => x.path === 'redux.entities.things');
    assert.ok(c, 'single-item map is a candidate');
    assert.equal(c.count, 1);
  });

  it("records store paths cut to '[deep]' by the snapshot serializer", () => {
    const state = { redux: { entities: { roomThings: '[deep]', other: '[deep]' } } };
    const { candidates, truncated } = extractSpatialCandidates(state);
    assert.equal(candidates.length, 0);
    assert.equal(truncated.count, 2);
    assert.ok(truncated.paths.includes('redux.entities.roomThings'));
  });
});

// ── Explicit path resolution ─────────────────────────────────────────────────

describe('canvas-map — resolveByPath', () => {
  it('resolves a dot-path to an array', () => {
    const r = resolveByPath(boardState, 'redux.board.pieces');
    assert.equal(r.items.length, 12);
  });

  it('resolves an object map to values + keys', () => {
    const r = resolveByPath({ m: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } }, 'm');
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.keys, ['a', 'b']);
  });

  it('resolves components.<Name> to the props of all matching nodes', () => {
    const r = resolveByPath(componentState, 'components.Piece');
    assert.equal(r.items.length, 3);
    assert.equal(r.items[0].name, 'A');
  });

  it("explains '[deep]' truncation instead of a generic not-found", () => {
    const r = resolveByPath({ redux: { entities: { things: '[deep]' } } }, 'redux.entities.things');
    assert.match(r.error, /truncated/);
    assert.match(r.error, /components\.<Name>/);
  });

  it('reports where a missing path stopped', () => {
    const r = resolveByPath(boardState, 'redux.nope.pieces');
    assert.match(r.error, /not found/);
  });
});

// ── Rendering: density ladder ────────────────────────────────────────────────

const norm = (arr) => arr.map((o, i) => ({ x: o.x, y: o.y, w: o.w || 0, h: o.h || 0, label: o.label || `o${i}` }));

describe('canvas-map — renderCanvasMap', () => {
  it('auto picks a grid for a dense board and numbers refs in reading order', () => {
    const m = renderCanvasMap(norm(pieces.map(p => ({ x: p.x, y: p.y, w: p.width, h: p.height, label: p.name }))), { width: 40 });
    assert.equal(m.form, 'grid');
    assert.match(m.grid, /\[1\]/);
    const lines = m.grid.split('\n');
    const rowOf = (re) => lines.findIndex(l => re.test(l));
    // [1] (top row) renders above [12] (bottom row)
    assert.ok(rowOf(/\[1\]/) < rowOf(/\[12\]/));
    assert.match(m.legend, /\[1\] "Knight" @0,0 50×50/);
  });

  it('auto picks a coordinate list when sparse (few objects)', () => {
    const m = renderCanvasMap(norm([{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 30, y: 200 }]), {});
    assert.equal(m.form, 'list');
    assert.match(m.text, /^3 objects, bbox x:0\.\.100 y:0\.\.200/);
    assert.match(m.text, /\[1\] "o0" @0,0/);
  });

  it('crops to the content bounding box (offsets do not waste rows)', () => {
    const shifted = norm([{ x: 5000, y: 9000 }, { x: 5100, y: 9000 }, { x: 5000, y: 9100 },
                          { x: 5100, y: 9100 }, { x: 5050, y: 9050 }, { x: 5075, y: 9025 },
                          { x: 5025, y: 9075 }, { x: 5090, y: 9010 }]);
    const m = renderCanvasMap(shifted, { form: 'grid', width: 40 });
    assert.deepEqual({ x: m.bbox.x, y: m.bbox.y }, { x: 5000, y: 9000 });
    assert.ok(m.height <= 20, 'rows derived from the cropped span, not absolute coords');
  });

  it('collapses runs of ≥3 empty rows into a lookup-shaped label', () => {
    // Two clusters far apart vertically → a long empty band in the middle.
    const objs = norm([
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }, { x: 900, y: 20 },
      { x: 0, y: 1000 }, { x: 300, y: 1000 }, { x: 600, y: 1000 }, { x: 900, y: 980 },
    ]);
    const m = renderCanvasMap(objs, { form: 'grid', width: 40 });
    assert.match(m.grid, /\(rows \d+-\d+ empty\)/);
  });

  it('forces a list for collinear/degenerate layouts (no 2D signal)', () => {
    const m = renderCanvasMap(norm([{ x: 0, y: 5 }, { x: 100, y: 5 }, { x: 200, y: 5 },
                                    { x: 300, y: 5 }, { x: 400, y: 5 }, { x: 500, y: 5 }]), { form: 'grid' });
    assert.equal(m.form, 'list');
    assert.ok(m.notes.some(n => /collinear|single point/.test(n)));
  });

  it('respects an explicit form over the density rule', () => {
    const objs = norm([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 50 },
                       { x: 50, y: 150 }, { x: 150, y: 20 }, { x: 80, y: 80 }]);
    assert.equal(renderCanvasMap(objs, { form: 'list' }).form, 'list');
    assert.equal(renderCanvasMap(objs, { form: 'grid' }).form, 'grid');
  });

  it('caps output lines at maxObjects with an honest note', () => {
    const many = norm(Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: 0 })));
    const m = renderCanvasMap(many, { form: 'list', maxObjects: 10 });
    assert.equal(m.counts.objects, 30);
    assert.equal(m.text.split('\n').length, 11); // header + 10 lines
    assert.ok(m.notes.some(n => /showing the first 10/.test(n)));
  });

  it('states that coordinates are store units, not screen px', () => {
    const m = renderCanvasMap(norm([{ x: 0, y: 0 }, { x: 10, y: 10 }]), {});
    assert.ok(m.notes.some(n => /store.*units.*not screen px/.test(n)));
  });

  it('handles an empty object list without throwing', () => {
    const m = renderCanvasMap([], {});
    assert.equal(m.counts.objects, 0);
    assert.ok(typeof m.text === 'string');
  });
});

// ── End-to-end orchestrator ──────────────────────────────────────────────────

describe('canvas-map — getCanvasMap', () => {
  it('auto-discovers the best collection and reports source + candidates', () => {
    const m = getCanvasMap(boardState);
    assert.equal(m.source.path, 'redux.board.pieces');
    assert.equal(m.source.fields.x, 'x');
    assert.ok(Array.isArray(m.candidates), 'other candidates listed for the agent to pick');
    assert.ok(m.candidates.some(c => c.path === 'redux.markers'));
  });

  it('renders an explicit path even when it is not the top candidate', () => {
    const m = getCanvasMap(boardState, { path: 'redux.markers' });
    assert.equal(m.source.path, 'redux.markers');
    assert.equal(m.counts.objects, 3);
    assert.equal(m.candidates, undefined, 'no discovery ran');
  });

  it('hints override field accessors when auto-detection cannot see them', () => {
    const state = { store: { units: [
      { px: 0, py: 0, tag: 'a' }, { px: 50, py: 50, tag: 'b' }, { px: 100, py: 25, tag: 'c' },
    ] } };
    const failed = getCanvasMap(state);
    assert.match(failed.error, /No collections/);
    const m = getCanvasMap(state, { hints: { path: 'store.units', x: 'px', y: 'py', label: 'tag' } });
    assert.equal(m.counts.objects, 3);
    assert.match(m.text, /"a" @0,0/);
  });

  it('lists sample keys when a resolved path has no detectable coordinates', () => {
    const state = { store: { rows: [{ foo: 1, bar: 2 }, { foo: 3, bar: 4 }] } };
    const m = getCanvasMap(state, { path: 'store.rows' });
    assert.match(m.error, /No numeric x\/y fields/);
    assert.deepEqual(m.sampleKeys, ['foo', 'bar']);
  });

  it("surfaces '[deep]' truncation as a warning next to a successful render", () => {
    const state = {
      redux: {
        entities: { roomThings: '[deep]' },
        board: { pieces },
      },
    };
    const m = getCanvasMap(state);
    assert.equal(m.source.path, 'redux.board.pieces');
    const w = (m._warnings || []).find(x => x.code === 'STORE_DEPTH_TRUNCATED');
    assert.ok(w, 'truncation warning attached');
    assert.match(w.message, /redux\.entities\.roomThings/);
  });

  it("explains '[deep]' in the error when nothing else is scannable", () => {
    const state = { redux: { entities: { roomThings: '[deep]' } } };
    const m = getCanvasMap(state);
    assert.match(m.error, /No collections/);
    assert.match(m.hint, /depth limit/);
    assert.equal(m.truncated.count, 1);
  });

  it('renders from componentTree prop groups (the route that survives store truncation)', () => {
    const m = getCanvasMap(componentState);
    assert.equal(m.source.path, 'components.Piece');
    assert.equal(m.counts.objects, 3);
    assert.match(m.text, /"A" @10,20/);
  });

  it('returns an honest error for a missing/invalid state', () => {
    assert.match(getCanvasMap(null).error, /No framework state/);
    assert.match(getCanvasMap('nope').error, /No framework state/);
  });
});

// ── Canvas identification (Slice-1 vocabulary) ───────────────────────────────

describe('canvas-map — annotateCanvas', () => {
  const catalog = { canvases: [
    { index: 0, id: 'minimap', rect: { x: 0, y: 0, w: 150, h: 120 }, bitmap: { w: 150, h: 120 } },
    { index: 1, id: 'board',   rect: { x: 0, y: 0, w: 800, h: 600 }, bitmap: { w: 1600, h: 1200 } },
  ] };

  it('defaults to the largest canvas on the page', () => {
    const m = annotateCanvas({}, catalog, null);
    assert.equal(m.canvas.index, 1);
    assert.equal(m.canvas.id, 'board');
    assert.equal(m.canvas.totalCanvases, 2);
  });

  it('selects the requested canvasIndex', () => {
    const m = annotateCanvas({}, catalog, 0);
    assert.equal(m.canvas.id, 'minimap');
  });

  it('says so when the requested index does not exist', () => {
    const m = annotateCanvas({}, catalog, 9);
    assert.equal(m.canvas.requestedIndex, 9);
    assert.match(m.canvas.note, /No canvas with that index/);
  });

  it('leaves the map untouched when the page has no canvases', () => {
    const m = annotateCanvas({}, { canvases: [] }, null);
    assert.equal(m.canvas, undefined);
  });
});

// ── Wiring pins (both surfaces + registration) ───────────────────────────────

describe('canvas-map — wiring', () => {
  it('MCP get_canvas_map is defined in intelligence.js and delegates to server/canvas-map.js', () => {
    const src = read('server/mcp/tools/intelligence.js');
    assert.match(src, /name: 'get_canvas_map'/);
    assert.match(src, /require\('\.\.\/\.\.\/canvas-map'\)/);
    assert.match(src, /require\('\.\.\/\.\.\/framework-state'\)/);
  });

  it('HTTP endpoint /api/sessions/:tabId/canvas-map is wired in index.js', () => {
    const src = read('server/index.js');
    assert.match(src, /\/api\\\/sessions\\\/\(\\d\+\)\\\/canvas-map/);
    assert.match(src, /getCanvasMap\(state/);
  });

  it('is registered in the intelligence profile and mcp-tools.json', () => {
    const profiles = JSON.parse(read('server/configs/tool-profiles.json'));
    assert.ok(profiles.intelligence.tools.includes('get_canvas_map'));
    const tools = JSON.parse(read('server/configs/mcp-tools.json'));
    assert.equal(tools.tools.get_canvas_map.enabled, true);
  });

  it('layout-map legend redirects canvas regions to get_canvas_map', () => {
    const { renderLayoutMap } = require_('../../server/layout-map.js');
    const m = renderLayoutMap({
      catalog: { canvases: [{ index: 0, id: 'b', rect: { x: 0, y: 0, w: 400, h: 300 }, bitmap: { w: 400, h: 300 } }] },
      viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0 },
    }, { width: 40, legend: true });
    assert.match(m.legend, /get_canvas_map/);
  });

  it('whk shell catalog lists the endpoint', () => {
    assert.match(read('server/cli-shell.js'), /canvas-map/);
  });
});
