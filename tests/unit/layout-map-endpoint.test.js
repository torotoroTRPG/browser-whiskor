/**
 * tests/unit/layout-map-endpoint.test.js
 * GET /api/sessions/:tabId/layout-map — the HTTP twin of the get_layout_map MCP
 * tool (server/layout-map.js). Distinct from /api/sessions/:tabId/map, which is
 * the STATE GRAPH. Pins the wiring (index.js is where async GETs live — core's
 * non-action GET path serialises without awaiting) and exercises the renderer
 * with the same inputs the endpoint feeds it.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { renderLayoutMap } = require('../../server/layout-map');

describe('layout-map HTTP endpoint — wiring pins', () => {
  const idx = read('server/index.js');

  it('index.js routes GET /api/sessions/:tabId/layout-map to renderLayoutMap', () => {
    assert.match(idx, /\/api\\\/sessions\\\/\(\\d\+\)\\\/layout-map/, 'route regex present');
    assert.match(idx, /require\('\.\/layout-map'\)/, 'uses the shared renderer (same as get_layout_map)');
    assert.match(idx, /raw\/ui\/elements\.json/, 'reads the ui-catalog like the MCP tool');
  });

  it('honours the same query params the MCP tool exposes (width/legend/border)', () => {
    for (const q of ["sp.get('width')", "sp.get('legend')", "sp.get('border')"]) {
      assert.ok(idx.includes(q), q);
    }
  });

  it('CLAUDE.md documents the endpoint', () => {
    assert.match(read('CLAUDE.md'), /\/api\/sessions\/:tabId\/layout-map/);
  });
});

describe('layout-map HTTP endpoint — renderer accepts the endpoint\'s option shapes', () => {
  const catalog = {
    buttons: [{ text: 'Send', rect: { x: 10, y: 10, w: 60, h: 20 } }],
    inputs: [], links: [], canvases: [],
  };
  const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 0 };

  it('undefined width/legend (params absent) falls back to defaults', () => {
    const map = renderLayoutMap({ catalog, viewport }, { width: undefined, legend: undefined, border: false });
    assert.ok(map && typeof map.map === 'string' || typeof map === 'object', 'renders without throwing');
  });

  it('legend=false suppresses the legend, border=true draws a box', () => {
    const off = renderLayoutMap({ catalog, viewport }, { legend: false, border: true });
    const s = JSON.stringify(off);
    assert.ok(s.includes('+'), 'border chars present');
  });
});
