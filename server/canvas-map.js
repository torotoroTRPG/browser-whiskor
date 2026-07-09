/**
 * server/canvas-map.js
 * State-first canvas map — renders what is INSIDE a <canvas> from the
 * framework state the app draws from (store slices / component props carrying
 * numeric x/y), as an ASCII grid or a coordinate list.
 *
 * A <canvas> is a hole in every DOM sense; the structured state behind it is
 * not. Pipeline (docs/ideas/CANVAS_PERCEPTION.md, Slice 2):
 *
 *   framework state → spatial-object extraction → crop to content bbox
 *                   → scale (CHAR_ASPECT) → grid or list by measured density
 *
 * Representation rules from the same doc: numeric coordinates and monospace
 * alignment are the only text priors worth riding — the list form is
 * `[n] label @x,y w×h` (layout-map's own dialect), empty grid rows collapse to
 * a lookup-shaped `(rows a-b empty)` label, and no custom RLE anywhere.
 *
 * Coordinates are the app's own (store) units, NOT screen pixels: the map is
 * cropped and normalized, so relative placement is faithful even without the
 * app's view transform (pan/zoom projection is a possible later hints
 * extension).
 *
 * Pure + dependency-free: feed it an already-collected framework snapshot
 * (server/framework-state.js output). No new collection.
 */
'use strict';

// Same cell-geometry constants as server/layout-map.js: a monospace cell is
// roughly twice as tall as wide, so rows = cols * (spanY/spanX) * 0.5.
const CHAR_ASPECT = 0.5;
const DEFAULT_WIDTH = 40;

// Scan budget: a production React snapshot can run to hundreds of thousands of
// JSON nodes (the live-verified board app's snapshot is ~156K lines). The
// walker counts every visited value and stops honestly when the budget is out.
const DEFAULT_SCAN_BUDGET = 200000;

// The extension's safeVal serializer replaces objects nested past its depth
// cap with this literal string. Store slices that hold positions deep down
// (entities.<slice>.<id>.x) arrive unreadable — the scanner reports where.
const DEEP_MARK = '[deep]';

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Compact numeric formatting for legends: integers stay integers, fractions
// keep at most 2 decimals (store units can be floats; px-like precision is
// noise the reader pays tokens for).
function fmt(v) {
  if (!Number.isFinite(v)) return '?';
  const r = Math.round(v * 100) / 100;
  return String(r);
}

function shortLabel(s, max) {
  if (s === null || s === undefined) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Read a dotted accessor ("x", "position.x") off an object.
function readPath(obj, accessor) {
  if (!obj || typeof obj !== 'object') return undefined;
  let v = obj;
  for (const seg of String(accessor).split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[seg];
  }
  return v;
}

// ── Field detection ──────────────────────────────────────────────────────────
// Given a collection of objects, find which accessors carry the coordinates.
// Ordered by how common the naming is in app state / drawing code; nested
// containers (position.x …) come after direct fields.

const COORD_PARENTS = ['position', 'pos', 'location', 'coords', 'coord', 'offset', 'point'];
const COORD_PAIRS = [
  ['x', 'y'], ['left', 'top'], ['posX', 'posY'], ['positionX', 'positionY'], ['cx', 'cy'],
  ...COORD_PARENTS.map(p => [`${p}.x`, `${p}.y`]),
];
const SIZE_PARENTS = ['size', 'dimensions', 'dim'];
const SIZE_PAIRS = [
  ['w', 'h'], ['width', 'height'],
  ...SIZE_PARENTS.map(p => [`${p}.width`, `${p}.height`]),
  ...SIZE_PARENTS.map(p => [`${p}.w`, `${p}.h`]),
];
const LABEL_FIELDS = ['name', 'label', 'title', 'text', 'memo', 'id', 'key', 'kind', 'type'];

// Fraction of items where fn(item) holds, sampled over at most `cap` items.
function coverage(items, fn, cap = 200) {
  const n = Math.min(items.length, cap);
  if (!n) return 0;
  let hit = 0;
  for (let i = 0; i < n; i++) if (fn(items[i])) hit++;
  return hit / n;
}

const numAt = (acc) => (o) => Number.isFinite(readPath(o, acc));

/**
 * Detect coordinate/size/label accessors on a collection of objects.
 * @returns {{x,y,w?,h?,label?,coverage}|null} accessor strings, or null when
 *          no coordinate pair reaches 60% coverage.
 */
function detectFields(items) {
  const objs = items.filter(isPlainObject);
  if (!objs.length) return null;

  let best = null;
  for (const [ax, ay] of COORD_PAIRS) {
    const cov = coverage(objs, (o) => numAt(ax)(o) && numAt(ay)(o));
    if (cov >= 0.6 && (!best || cov > best.coverage)) best = { x: ax, y: ay, coverage: cov };
    if (best && best.coverage === 1) break;
  }
  if (!best) return null;

  for (const [aw, ah] of SIZE_PAIRS) {
    if (coverage(objs, (o) => numAt(aw)(o) && numAt(ah)(o)) >= 0.5) {
      best.w = aw; best.h = ah; break;
    }
  }
  for (const f of LABEL_FIELDS) {
    if (coverage(objs, (o) => {
      const v = readPath(o, f);
      return typeof v === 'string' ? v.length > 0 : Number.isFinite(v);
    }) >= 0.5) { best.label = f; break; }
  }
  return best;
}

// Candidate score: element count (capped so one huge array cannot drown a
// better-annotated small one) × field completeness × detection coverage.
function scoreCandidate(count, fields) {
  const completeness = 1 + (fields.w ? 0.5 : 0) + (fields.label ? 0.25 : 0);
  return Math.min(count, 200) * completeness * fields.coverage;
}

// ── State scanning (generic heuristic) ───────────────────────────────────────

/**
 * Walk a framework snapshot looking for collections of spatial objects:
 *  - arrays of objects with a numeric coordinate pair
 *  - id-keyed maps whose values carry one (entity-adapter style)
 *  - componentTree groups: ≥3 same-named components whose props carry one
 *
 * @returns {{candidates:Array, truncated:{count:number,paths:string[]},
 *            budgetExhausted:boolean}}
 */
function extractSpatialCandidates(state, opts = {}) {
  const budget = { nodes: opts.maxNodes || DEFAULT_SCAN_BUDGET };
  const candidates = [];
  const truncated = { count: 0, paths: [] };
  const noteDeep = (path) => {
    truncated.count++;
    if (truncated.paths.length < 20) truncated.paths.push(path);
  };

  // A single-element collection still counts: a board with one piece is a real
  // board (score scales with count, so it only wins when nothing bigger
  // exists). Solitary x/y CONFIG objects (pan offsets etc.) never get here —
  // only arrays/maps whose VALUES are spatial objects do.
  const tryCollection = (items, keys, path, kind) => {
    if (!items.length) return;
    const fields = detectFields(items);
    if (!fields) return;
    candidates.push({
      path, kind, count: items.length, fields,
      score: scoreCandidate(items.length, fields),
      _items: items, _keys: keys, // internal: resolved refs, stripped from output
    });
  };

  const walk = (value, path, depth) => {
    if (budget.nodes-- <= 0 || depth > 12) return;
    if (Array.isArray(value)) {
      if (value.some(isPlainObject)) tryCollection(value, null, path, 'array');
      for (let i = 0; i < value.length; i++) {
        const v = value[i];
        if (v && typeof v === 'object') walk(v, `${path}.${i}`, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) return;
    const keys = Object.keys(value);
    const objValues = keys.map(k => value[k]).filter(isPlainObject);
    // Id-keyed map shape: most values are objects → treat values as the
    // collection (keys become fallback labels).
    if (objValues.length >= 1 && objValues.length >= keys.length * 0.6) {
      tryCollection(keys.map(k => value[k]), keys, path, 'map');
    }
    for (const k of keys) {
      const v = value[k];
      if (v === DEEP_MARK) { noteDeep(path ? `${path}.${k}` : k); continue; }
      if (v && typeof v === 'object') walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };

  if (isPlainObject(state)) {
    for (const k of Object.keys(state)) {
      if (k.startsWith('_') || k === 'componentTree') continue; // meta / handled below
      const v = state[k];
      if (v === DEEP_MARK) { noteDeep(k); continue; }
      if (v && typeof v === 'object') walk(v, k, 0);
    }
    if (state.componentTree) {
      collectComponentGroups(state.componentTree, budget, candidates);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, truncated, budgetExhausted: budget.nodes <= 0 };
}

// Component props survive the serializer's depth cap (primitives always pass),
// so when a store slice arrives '[deep]' the per-piece components usually still
// carry the coordinates. Group composite nodes by name; a group of same-named
// components with numeric x/y props is a strong "these are the drawn objects"
// signal. Path dialect: `components.<Name>`.
function collectComponentGroups(tree, budget, candidates) {
  const groups = new Map();
  const visit = (node) => {
    if (!node || budget.nodes-- <= 0) return;
    // node = {n:name, w?:weak-name flag, p?:props, c?:children} (react adapter);
    // only real display names group meaningfully.
    if (node.p && node.n && !node.w) {
      let g = groups.get(node.n);
      if (!g) groups.set(node.n, g = []);
      g.push(node.p);
    }
    if (Array.isArray(node.c)) for (const c of node.c) visit(c);
  };
  visit(tree);
  for (const [name, propsList] of groups) {
    if (propsList.length < 3) continue;
    const fields = detectFields(propsList);
    if (!fields) continue;
    candidates.push({
      path: `components.${name}`, kind: 'components',
      count: propsList.length, fields,
      score: scoreCandidate(propsList.length, fields),
      _items: propsList, _keys: null,
    });
  }
}

// ── Explicit path resolution (agent-specified / hints) ───────────────────────

function resolveByPath(state, path) {
  const p = String(path);
  if (p.startsWith('components.')) {
    const name = p.slice('components.'.length);
    const items = [];
    const visit = (node) => {
      if (!node) return;
      if (node.n === name && node.p) items.push(node.p);
      if (Array.isArray(node.c)) for (const c of node.c) visit(c);
    };
    visit(state && state.componentTree);
    if (!items.length) return { error: `No components named "${name}" in the component tree.` };
    return { items, keys: null };
  }
  let v = state;
  const walked = [];
  for (const seg of p.split('.')) {
    walked.push(seg);
    if (v === DEEP_MARK) {
      return { error: `Path "${walked.slice(0, -1).join('.')}" is truncated in the snapshot ('${DEEP_MARK}': the store serializer cuts deep nesting). The coordinates may still be readable from component props — try a components.<Name> candidate.` };
    }
    if (v === null || typeof v !== 'object') {
      return { error: `Path "${p}" not found (stopped at "${walked.join('.')}").` };
    }
    v = v[seg];
  }
  if (v === DEEP_MARK) {
    return { error: `Path "${p}" is truncated in the snapshot ('${DEEP_MARK}': the store serializer cuts deep nesting). The coordinates may still be readable from component props — try a components.<Name> candidate.` };
  }
  if (Array.isArray(v)) return { items: v, keys: null };
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    return { items: keys.map(k => v[k]), keys };
  }
  return { error: `Path "${p}" resolves to a ${v === undefined ? 'missing value' : typeof v}, not a collection of objects.` };
}

// ── Object normalization ─────────────────────────────────────────────────────

function buildObjects(items, keys, fields) {
  const out = [];
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const x = readPath(it, fields.x);
    const y = readPath(it, fields.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { skipped++; continue; }
    const w = fields.w ? readPath(it, fields.w) : undefined;
    const h = fields.h ? readPath(it, fields.h) : undefined;
    let label = fields.label ? readPath(it, fields.label) : undefined;
    if ((label === undefined || label === null || label === '') && keys) label = keys[i];
    out.push({
      x, y,
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
      label: label === undefined || label === null ? '' : String(label),
    });
  }
  return { objects: out, skipped };
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Write `tok` into row r starting at col c over free cells only, shifting a few
// cells sideways when blocked (same collision policy as layout-map).
function tryPlace(grid, r, c, tok, cols) {
  const len = tok.length;
  const fits = (col) => {
    if (col < 0 || col + len > cols) return false;
    for (let k = 0; k < len; k++) if (grid[r][col + k] !== ' ') return false;
    return true;
  };
  let col = -1;
  if (fits(c)) col = c;
  else {
    for (let d = 1; d <= 6; d++) {
      if (fits(c + d)) { col = c + d; break; }
      if (fits(c - d)) { col = c - d; break; }
    }
  }
  if (col < 0) return -1;
  for (let k = 0; k < len; k++) grid[r][col + k] = tok[k];
  return col;
}

function objectLine(o) {
  const label = o.label ? ` "${shortLabel(o.label, 40)}"` : '';
  const size = (o.w > 0 || o.h > 0) ? ` ${fmt(o.w)}×${fmt(o.h)}` : '';
  return `[${o.ref}]${label} @${fmt(o.x)},${fmt(o.y)}${size}`;
}

/**
 * Render normalized spatial objects as a grid or list.
 *
 * @param {Array<{x,y,w,h,label}>} objects  - store-unit objects
 * @param {object} [opts]
 * @param {number} [opts.width=40]          - grid columns (clamped 12..120)
 * @param {string} [opts.form='auto']       - 'auto' | 'grid' | 'list'
 * @param {boolean}[opts.legend=true]       - grid form: include the ref legend
 * @param {number} [opts.maxObjects=150]    - cap legend/list lines
 * @returns {{form,text,grid,legend,width,height,bbox,counts,notes}}
 */
function renderCanvasMap(objects, opts = {}) {
  const cols = clamp(Math.round(opts.width || DEFAULT_WIDTH), 12, 120);
  const wantLegend = opts.legend !== false;
  const maxObjects = clamp(Math.round(opts.maxObjects || 150), 1, 1000);
  const notes = [];

  if (!objects.length) {
    return {
      form: 'list', text: '(no spatial objects)', grid: null, legend: null,
      width: cols, height: 0, bbox: null,
      counts: { objects: 0, placed: 0, overflow: 0 },
      notes: ['No objects with finite coordinates to map.'],
    };
  }

  // Content bounding box (crop rung of the density ladder): empty margins are
  // the main whitespace source, so the map always starts at the content.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + (o.w || 0)); maxY = Math.max(maxY, o.y + (o.h || 0));
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  const bbox = { x: minX, y: minY, w: spanX, h: spanY };
  const degenerate = !(spanX > 0) || !(spanY > 0); // collinear / single point

  const rows = degenerate ? 1
    : clamp(Math.round(cols * (spanY / spanX) * CHAR_ASPECT), 2, 60);

  // Quantize centers, number in reading order — refs are shared by both forms.
  for (const o of objects) {
    const cx = o.x + (o.w || 0) / 2, cy = o.y + (o.h || 0) / 2;
    o.col = degenerate ? 0 : clamp(Math.floor((cx - minX) / spanX * cols), 0, cols - 1);
    o.row = degenerate ? 0 : clamp(Math.floor((cy - minY) / spanY * rows), 0, rows - 1);
  }
  const ordered = objects.slice().sort((a, b) => (a.row - b.row) || (a.col - b.col) || (a.y - b.y) || (a.x - b.x));
  ordered.forEach((o, i) => { o.ref = i + 1; });

  // Density decision: a grid earns its rows only when there is 2D gestalt to
  // read. Sparse → list (numbers are the deepest prior anyway); dense → grid.
  let form = opts.form === 'grid' || opts.form === 'list' ? opts.form : 'auto';
  if (form === 'auto') {
    const cells = new Set(ordered.map(o => o.row * cols + o.col));
    const occupancy = cells.size / (rows * cols);
    form = (!degenerate && ordered.length >= 6 && occupancy >= 0.01) ? 'grid' : 'list';
  }
  if (degenerate && form === 'grid') {
    form = 'list';
    notes.push('Objects are collinear or a single point — a grid has no 2D signal, rendered as a list.');
  }

  const capped = ordered.length > maxObjects;
  const shown = capped ? ordered.slice(0, maxObjects) : ordered;
  if (capped) notes.push(`${ordered.length} objects; showing the first ${maxObjects} in reading order (raise maxObjects for the rest).`);
  notes.push('Coordinates are the app\'s own (store) units, not screen px — relative placement is faithful.');

  if (form === 'list') {
    const header = `${ordered.length} objects, bbox x:${fmt(minX)}..${fmt(maxX)} y:${fmt(minY)}..${fmt(maxY)}`;
    const lines = shown.map(objectLine);
    const text = [header, ...lines].join('\n');
    return {
      form, text, grid: null, legend: null, width: cols, height: rows, bbox,
      counts: { objects: ordered.length, placed: 0, overflow: 0 },
      notes,
    };
  }

  // Grid form.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  let placed = 0, overflow = 0;
  for (const o of ordered) {
    const start = tryPlace(grid, o.row, o.col, `[${o.ref}]`, cols);
    if (start >= 0) placed++;
    else { o.overflow = true; overflow++; }
  }
  if (overflow) notes.push(`${overflow} object(s) could not fit a distinct cell (see ⚠ in legend).`);

  // Empty-row collapse (ladder rung 2): runs of ≥3 blank rows become a
  // lookup-shaped label; column alignment in the remaining rows is untouched.
  const rowStrs = grid.map(r => r.join('').replace(/\s+$/, ''));
  const outLines = [];
  for (let r = 0; r < rowStrs.length;) {
    if (rowStrs[r] === '') {
      let e = r;
      while (e + 1 < rowStrs.length && rowStrs[e + 1] === '') e++;
      if (e - r + 1 >= 3) outLines.push(`(rows ${r + 1}-${e + 1} empty)`);
      else for (let k = r; k <= e; k++) outLines.push('');
      r = e + 1;
    } else {
      outLines.push(rowStrs[r]);
      r++;
    }
  }
  const gridStr = outLines.join('\n');

  let legendStr = null;
  if (wantLegend) {
    legendStr = shown.map(o => o.overflow ? `${objectLine(o)} ⚠offgrid` : objectLine(o)).join('\n');
  }
  const text = legendStr ? `${gridStr}\n\nLEGEND\n${legendStr}` : gridStr;

  return {
    form, text, grid: gridStr, legend: legendStr, width: cols, height: rows, bbox,
    counts: { objects: ordered.length, placed, overflow },
    notes,
  };
}

// ── Orchestrator (shared by MCP get_canvas_map and the HTTP endpoint) ────────

const summarize = (c) => ({
  path: c.path, kind: c.kind, count: c.count, score: Math.round(c.score * 100) / 100,
  fields: { x: c.fields.x, y: c.fields.y, w: c.fields.w, h: c.fields.h, label: c.fields.label },
});

/**
 * Full pipeline: framework snapshot → canvas map.
 *
 * @param {object} state  framework snapshot (server/framework-state.js output;
 *                        `_`-prefixed meta keys are ignored)
 * @param {object} [opts] {path, hints:{path,x,y,w,h,label}, width, form,
 *                         legend, maxObjects}
 * @returns map result, or {error, candidates?, truncated?} when nothing maps
 */
function getCanvasMap(state, opts = {}) {
  if (!isPlainObject(state)) {
    return { error: 'No framework state to read. Trigger refresh_data / POST /api/collect first.' };
  }
  const hints = isPlainObject(opts.hints) ? opts.hints : {};
  const path = opts.path || hints.path || null;

  let items, keys, source, candidates = null, truncated = null, scanNotes = [];

  if (path) {
    const r = resolveByPath(state, path);
    if (r.error) return { error: r.error };
    items = r.items; keys = r.keys;
    source = { path, kind: path.startsWith('components.') ? 'components' : 'path', count: items.length };
  } else {
    const scan = extractSpatialCandidates(state);
    truncated = scan.truncated.count ? scan.truncated : null;
    if (scan.budgetExhausted) scanNotes.push('Snapshot is very large — the scan stopped at its node budget; some collections may be missed. Pass path/hints to read a specific one.');
    if (!scan.candidates.length) {
      const out = {
        error: 'No collections of objects with numeric x/y coordinates found in the framework state.',
        hint: 'If the app keeps positions in a known slice, pass hints {path:"<dot.path>", x:"<field>", y:"<field>"}. If the state itself is unreachable, only pixel senses remain (ocr_region / capture_screenshot).',
      };
      if (truncated) {
        out.truncated = truncated;
        out.hint += ` Note: ${truncated.count} store path(s) are cut by the snapshot's depth limit ('${DEEP_MARK}'), e.g. ${truncated.paths.slice(0, 3).join(', ')} — positions there are not readable from the snapshot.`;
      }
      if (scanNotes.length) out.notes = scanNotes;
      return out;
    }
    const top = scan.candidates[0];
    items = top._items; keys = top._keys;
    source = summarize(top);
    if (scan.candidates.length > 1) candidates = scan.candidates.slice(0, 8).map(summarize);
  }

  // Field accessors: detected from the data, overridable per-axis by hints.
  const detected = detectFields(items) || { coverage: 0 };
  const fields = {
    x: hints.x || detected.x, y: hints.y || detected.y,
    w: hints.w || detected.w, h: hints.h || detected.h,
    label: hints.label || detected.label,
    coverage: detected.coverage,
  };
  if (!fields.x || !fields.y) {
    const sample = items.find(isPlainObject);
    return {
      error: `No numeric x/y fields detected on the objects at "${source.path}". Pass hints {x:"<field>", y:"<field>"} (dotted paths allowed, e.g. "position.x").`,
      sampleKeys: sample ? Object.keys(sample).slice(0, 20) : [],
    };
  }

  const { objects, skipped } = buildObjects(items, keys, fields);
  const map = renderCanvasMap(objects, opts);
  if (skipped) map.counts.skipped = skipped;
  map.source = { ...source, fields: { x: fields.x, y: fields.y, w: fields.w, h: fields.h, label: fields.label } };
  if (candidates) map.candidates = candidates;
  if (truncated) {
    map._warnings = [...(map._warnings || []), {
      code: 'STORE_DEPTH_TRUNCATED',
      message: `${truncated.count} store path(s) are cut by the snapshot's depth limit ('${DEEP_MARK}') and could not be scanned: ${truncated.paths.slice(0, 5).join(', ')}${truncated.count > 5 ? ', …' : ''}. Component props (components.* candidates) usually still carry positions.`,
    }];
  }
  if (scanNotes.length) map.notes.push(...scanNotes);
  return map;
}

/**
 * Annotate a map result with the Slice-1 canvas it corresponds to: the
 * requested ui-catalog index, or the largest canvas on the page by default.
 * v1 renders store coordinates unprojected, so this is identification only.
 * Shared by the MCP tool and the HTTP endpoint (one implementation, no drift).
 */
function annotateCanvas(map, catalog, canvasIndex) {
  const canvases = (catalog && catalog.canvases) || [];
  if (!canvases.length || !map || typeof map !== 'object') return map;
  const pick = canvasIndex != null
    ? canvases.find(c => c.index === canvasIndex)
    : canvases.reduce((a, b) =>
        (((b.rect && b.rect.w) || 0) * ((b.rect && b.rect.h) || 0) >
         ((a.rect && a.rect.w) || 0) * ((a.rect && a.rect.h) || 0) ? b : a));
  if (pick) {
    map.canvas = { index: pick.index, id: pick.id || null, classes: pick.classes || null,
                   rect: pick.rect, bitmap: pick.bitmap, totalCanvases: canvases.length };
  } else if (canvasIndex != null) {
    map.canvas = { requestedIndex: canvasIndex, note: 'No canvas with that index in the ui-catalog.', totalCanvases: canvases.length };
  }
  return map;
}

module.exports = {
  getCanvasMap,
  renderCanvasMap,
  extractSpatialCandidates,
  resolveByPath,
  detectFields,
  annotateCanvas,
  _buildObjects: buildObjects,
};
