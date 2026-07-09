/**
 * server/layout-map.js
 * Coarse ASCII layout map — a cheap, every-turn spatial channel.
 *
 * Renders a monospace grid where interactive elements sit roughly where they are
 * on screen, each as a bracketed ref token whose bracket shape encodes its kind:
 *   [n] button   {n} input/field   <n> link
 * Labels live in an optional legend, not the grid — per the design note, the
 * ref→label legend (not character tricks) is the real compression lever, and a
 * borderless grid keeps the 2D alignment the model reads positions from.
 *
 * Pure + dependency-free: feed it the already-collected ui-catalog + viewport
 * (+ optional text-coords); it does a quantize-and-place pass. No new collection.
 *
 * See docs/ideas/LAYOUT_ASCII_MAP.md.
 */
'use strict';

// A monospace character cell is roughly twice as tall as it is wide, so a pixel
// region maps to fewer rows than columns. Used to derive row count from width.
const CHAR_ASPECT = 0.5;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function shortLabel(s, max) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Kind → bracket pair. The shape gives an at-a-glance hint without spending a
// label: square = button-like, curly = text field, angle = link.
const BRACKETS = {
  button: ['[', ']'],
  input:  ['{', '}'],
  link:   ['<', '>'],
};

function token(kind, n) {
  const b = BRACKETS[kind] || BRACKETS.button;
  return b[0] + n + b[1];
}

// Canvas regions the ui-catalog reported — pixel-land the DOM senses cannot see
// inside. Rendered as a shaded block: unlike DOM elements (whose ref token already
// carries existence/kind/position, making a drawn box redundant chrome), a canvas
// has no DOM to fall back on — its EXTENT is the information, so it gets drawn.
const CANVAS_FILL = '░';

function collectCanvases(catalog) {
  const out = [];
  for (const c of (catalog && catalog.canvases) || []) {
    const r = c && c.rect;
    if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !(r.w > 0) || !(r.h > 0)) continue;
    out.push({
      rect: r,
      center: { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) },
      ident: c.id ? `#${c.id}`
        : (c.classes ? 'canvas.' + String(c.classes).trim().split(/\s+/).slice(0, 2).join('.') : null),
      clickThrough: c.clickThrough === true,
    });
  }
  return out;
}

// Pull interactive elements out of a ui-catalog payload into a flat list with a
// normalized kind, a display label and a center point (page coords).
function collectInteractive(catalog) {
  const out = [];
  if (!catalog) return out;
  const center = (rect) => rect && {
    x: Math.round(rect.x + (rect.w || 0) / 2),
    y: Math.round(rect.y + (rect.h || 0) / 2),
  };
  const add = (kind, label, rect) => {
    const c = center(rect);
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
    out.push({ kind, label: label || '', center: c, rect });
  };
  for (const b of catalog.buttons || []) add('button', b.label || b.text || b.type, b.rect);
  for (const i of catalog.inputs || []) add('input', i.label || i.placeholder || i.name || i.type, i.rect);
  for (const l of catalog.links || []) add('link', l.label || l.text, l.rect);
  return out;
}

/**
 * Render the ASCII layout map.
 *
 * @param {object} data
 * @param {object} data.catalog     - ui-catalog payload (buttons/inputs/links, each {rect})
 * @param {object} [data.viewport]  - {width,height,scrollX,scrollY}; defines the mapped region
 * @param {object} [data.textCoords]- reserved (region text anchors); not used in v1
 * @param {object} [opts]
 * @param {number} [opts.width=40]  - grid columns (clamped 12..120)
 * @param {boolean}[opts.legend=true]
 * @param {boolean}[opts.border=false]
 * @returns {{text:string, grid:string, legend:string|null, width:number, height:number,
 *           counts:{interactive:number,placed:number,overflow:number,offscreen:number}, notes:string[]}}
 */
function renderLayoutMap(data, opts = {}) {
  const cols = clamp(Math.round(opts.width || 40), 12, 120);
  const wantLegend = opts.legend !== false;
  const wantBorder = opts.border === true;
  const notes = [];

  let items = collectInteractive(data && data.catalog);
  const interactiveTotal = items.length;
  let canvases = collectCanvases(data && data.catalog);
  const canvasTotal = canvases.length;

  // Establish the mapped region (page coords). Prefer the live viewport so the
  // map is viewport-relative; fall back to the bounding box of the elements.
  const vp = data && data.viewport;
  let originX, originY, spanX, spanY;
  let offscreen = 0;
  if (vp && vp.width > 0 && vp.height > 0) {
    originX = vp.scrollX || 0;
    originY = vp.scrollY || 0;
    spanX = vp.width;
    spanY = vp.height;
    const before = items.length;
    items = items.filter(it =>
      it.center.x >= originX && it.center.x <= originX + spanX &&
      it.center.y >= originY && it.center.y <= originY + spanY);
    offscreen = before - items.length;
  } else {
    if (!items.length && !canvases.length) {
      return emptyResult(cols, wantBorder, ['No interactive elements and no viewport — nothing to map.']);
    }
    const xs = items.map(i => i.center.x), ys = items.map(i => i.center.y);
    for (const c of canvases) { xs.push(c.rect.x, c.rect.x + c.rect.w); ys.push(c.rect.y, c.rect.y + c.rect.h); }
    originX = Math.min(...xs); originY = Math.min(...ys);
    spanX = Math.max(1, Math.max(...xs) - originX);
    spanY = Math.max(1, Math.max(...ys) - originY);
    notes.push('No viewport data — mapped the bounding box of elements instead.');
  }

  // Canvases are kept when their RECT intersects the region (a large canvas can
  // cover the view while its center sits offscreen — center-filtering would drop
  // exactly the case that matters most).
  const canvasBefore = canvases.length;
  canvases = canvases.filter(c =>
    c.rect.x < originX + spanX && c.rect.x + c.rect.w > originX &&
    c.rect.y < originY + spanY && c.rect.y + c.rect.h > originY);
  const canvasOffscreen = canvasBefore - canvases.length;
  if (canvasOffscreen) notes.push(`${canvasOffscreen} canvas region(s) are outside the current viewport.`);

  const rows = clamp(Math.round(cols * (spanY / spanX) * CHAR_ASPECT), 4, 60);

  // Quantize each element to a cell, then number in reading order (row, col).
  for (const it of items) {
    it.col = clamp(Math.floor((it.center.x - originX) / spanX * cols), 0, cols - 1);
    it.row = clamp(Math.floor((it.center.y - originY) / spanY * rows), 0, rows - 1);
  }
  items.sort((a, b) => (a.row - b.row) || (a.col - b.col));
  items.forEach((it, i) => { it.ref = i + 1; });

  // Place tokens into the grid buffer. Interactive tokens never overwrite each
  // other: if the start cell run is taken, shift right a few cells; if still
  // blocked, the element is recorded in the legend but flagged as overflow.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));

  // Canvas regions go in FIRST as a shaded background with a #n tag at the
  // region's top-left; interactive tokens draw over the fill afterwards —
  // matching reality, where HTML controls float above the canvas.
  canvases.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  canvases.forEach((c, i) => { c.ref = i + 1; });
  for (const c of canvases) {
    const c0 = clamp(Math.floor((c.rect.x - originX) / spanX * cols), 0, cols - 1);
    const c1 = clamp(Math.ceil((c.rect.x + c.rect.w - originX) / spanX * cols) - 1, c0, cols - 1);
    const r0 = clamp(Math.floor((c.rect.y - originY) / spanY * rows), 0, rows - 1);
    const r1 = clamp(Math.ceil((c.rect.y + c.rect.h - originY) / spanY * rows) - 1, r0, rows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let k = c0; k <= c1; k++) if (grid[r][k] === ' ') grid[r][k] = CANVAS_FILL;
    }
    const tag = '#' + c.ref;
    for (let k = 0; k < tag.length && c0 + k < cols; k++) grid[r0][c0 + k] = tag[k];
  }

  let placed = 0, overflow = 0;
  for (const it of items) {
    const tok = token(it.kind, it.ref);
    const start = tryPlace(grid, it.row, it.col, tok, cols);
    if (start >= 0) { it.placedCol = start; placed++; }
    else { it.overflow = true; overflow++; }
  }
  if (overflow) notes.push(`${overflow} element(s) could not fit a distinct cell (see ⚠ in legend).`);
  if (offscreen) notes.push(`${offscreen} interactive element(s) are outside the current viewport (scroll to see).`);

  const gridStr = renderGrid(grid, wantBorder);
  const legendStr = wantLegend ? renderLegend(items, canvases) : null;
  const text = legendStr ? `${gridStr}\n\nLEGEND\n${legendStr}` : gridStr;

  return {
    text,
    grid: gridStr,
    legend: legendStr,
    width: cols,
    height: rows,
    counts: { interactive: interactiveTotal, placed, overflow, offscreen, canvases: canvasTotal },
    notes,
  };
}

// Write `tok` into row `r` starting at col `c` over space cells only. If the run
// is blocked, scan right up to a small window for a free run. Returns the start
// column used, or -1 if it could not be placed.
function tryPlace(grid, r, c, tok, cols) {
  const len = tok.length;
  const fits = (col) => {
    if (col < 0 || col + len > cols) return false;
    // Canvas fill is background — interactive tokens draw over it (HTML controls
    // float above the canvas on the real page).
    for (let k = 0; k < len; k++) {
      const cell = grid[r][col + k];
      if (cell !== ' ' && cell !== CANVAS_FILL) return false;
    }
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

function renderGrid(grid, border) {
  const rows = grid.map(row => row.join('').replace(/\s+$/, '')); // strip trailing ws (free)
  if (!border) return rows.join('\n');
  const w = grid[0].length;
  const bar = '+' + '-'.repeat(w) + '+';
  return [bar, ...grid.map(row => '|' + row.join('') + '|'), bar].join('\n');
}

function renderLegend(items, canvases) {
  // One line per ref: marker + kind + quoted label + center coords (page px) so
  // the agent can act via click(text:label) or the coordinates.
  const lines = items
    .slice()
    .sort((a, b) => a.ref - b.ref)
    .map(it => {
      const tok = token(it.kind, it.ref);
      const flag = it.overflow ? ' ⚠offgrid' : '';
      const label = it.label ? ` "${shortLabel(it.label, 48)}"` : '';
      return `${tok} ${it.kind}${label} @${it.center.x},${it.center.y}${flag}`;
    });
  // Canvas regions after the interactive refs: size + center + identifier, with
  // a single redirect line (DOM senses cannot see inside — where to look instead).
  const cs = (canvases || []).slice().sort((a, b) => a.ref - b.ref);
  for (const c of cs) {
    const ident = c.ident ? ` "${shortLabel(c.ident, 48)}"` : '';
    // click-through: pointer-events:none — clicks at these coordinates land on
    // the DOM layer above the canvas, never on the canvas itself.
    const ct = c.clickThrough ? ' (click-through)' : '';
    lines.push(`#${c.ref} canvas ${c.rect.w}×${c.rect.h}${ident} @${c.center.x},${c.center.y}${ct}`);
  }
  if (cs.length) lines.push('░ = canvas pixels (not DOM-visible): get_canvas_map renders the contents from framework state; ocr_region / screenshot for pixels');
  return lines.join('\n');
}

function emptyResult(cols, border, notes) {
  const grid = renderGrid([new Array(cols).fill(' ')], border);
  return { text: grid, grid, legend: null, width: cols, height: 1,
    counts: { interactive: 0, placed: 0, overflow: 0, offscreen: 0, canvases: 0 }, notes };
}

module.exports = { renderLayoutMap, collectInteractive, collectCanvases, _token: token };
