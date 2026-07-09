'use strict';
/**
 * server/tui/app.js — `whk shell`: full-screen interactive TUI (zero-dependency)
 *
 * Layout (alternate screen buffer, restored on exit):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ output pane (scrollback, wraps, PgUp/PgDn)   │
 *   │ ...                                          │
 *   ├──────────────────────────────────────────────┤
 *   │ candidate popup (incremental search, ↑/↓)    │
 *   ├──────────────────────────────────────────────┤
 *   │ whiskor> <line editor with real cursor>      │
 *   │ status bar: ● server · counts · key hints    │
 *   └──────────────────────────────────────────────┘
 *
 * Command engine (catalog / filtering / parsing / HTTP) is shared with the
 * classic shell (server/cli-shell.js) — `whk shell --classic` keeps the old
 * inline behaviour, and non-TTY stdin still gets the plain line REPL.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { PassThrough } = require('stream');
const { ansi, stripAnsi, strWidth, truncateToWidth, padToWidth, charWidth, parseSgrMouse, stripSgrMouse, splitTrailingEscape } = require('./term');
const { LineEditor } = require('./editor');
const { Scrollback } = require('./scrollback');
const { highlightJsonLine } = require('./highlight');
const {
  baseCatalog, expandCatalog, filterCandidates, parseCommand,
  requestJson, loadHistory, appendHistory, runShellEscape, shellOutputLines,
} = require('../cli-shell');

const PKG_VERSION = require('../../package.json').version;

const PROMPT      = 'whiskor> ';
const POPUP_MAX   = 8;
// Band behind popup rows. ANSI has no alpha, and explicitly colored cells are
// painted opaque even on a translucent terminal — so "semi-transparent" is
// approximated by staying near-black, just above the default background.
const POPUP_BG    = 234;
const HEALTH_POLL_MS = 5000;
const SPINNER     = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

// ── Folder-style categories ───────────────────────────────────────────────────

const CATEGORY_META = {
  action:  'Browser actions — click, type, navigate…',
  capture: 'Screenshots, packed SoM, element thumbnails',
  session: 'Browser sessions and their cached data',
  state:   'State graphs and their nodes',
  server:  'Server status, config, logs, maintenance',
  shell:   'Shell builtins',
};

/** Folder rows derived from the catalog's `cat` fields (with entry counts). */
function categoriesOf(catalog) {
  const counts = new Map();
  for (const c of catalog) {
    if (c.cat) counts.set(c.cat, (counts.get(c.cat) || 0) + 1);
  }
  return [...counts.entries()].map(([id, n]) => ({
    text: id + '/',
    desc: `${CATEGORY_META[id] || ''} (${n})`,
    folder: id,
  }));
}

/**
 * Candidate resolution with folder semantics:
 *  - inside a folder: only that category, '..' on top while not filtering
 *  - at the root with no query: the folders themselves
 *  - at the root with a query: matching folders first, then a deep search
 *    across every command (global search still works)
 */
function resolveCandidates(catalog, categories, dir, query) {
  if (dir) {
    const hits = filterCandidates(catalog.filter(c => c.cat === dir), query);
    return query.trim() ? hits : [{ text: '..', desc: 'back to categories', up: true }, ...hits];
  }
  if (!query.trim()) return categories.slice();
  return filterCandidates(categories, query).concat(filterCandidates(catalog, query));
}

// ── Free-input field detection (for the field-edit overlay) ──────────────────

/**
 * Find the editable JSON values inside a candidate's command text — both empty
 * placeholders (`"key":""` / `"key":"https://"`) and ALREADY-FILLED values
 * (`"deltaY":500`, `"key":"Enter"`), so → opens field-edit on any of them and
 * prefills the current value. `start`/`end` are offsets into `text` (the value
 * region, inside the quotes for strings) so a typed value splices back in place.
 * `type` is 'string' | 'number'; `value` is the current value, decoded for the
 * editor (JSON-unescaped for strings).
 */
const FIELD_RE = /"(\w+)":\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?))/g;
// Structural keys the overlay never edits: `type` is the action discriminator
// (pick a different catalog entry instead) and `tabId` is auto-filled from the
// live session by expandCatalog — surfacing them would just be noise to tab past.
const FIELD_SKIP_KEYS = new Set(['type', 'tabId']);
function detectFields(text) {
  const fields = [];
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(text))) {
    const key = m[1];
    if (FIELD_SKIP_KEYS.has(key)) continue;
    if (m[3] !== undefined) {
      // Numeric literal — sits at the end of the match, no surrounding quotes.
      const start = m.index + m[0].length - m[3].length;
      fields.push({ key, start, end: start + m[3].length, value: m[3], type: 'number' });
    } else {
      // String — inner content is the last (inner.length + 1) chars of the match
      // (closing quote included), regardless of whitespace after the colon.
      const inner = m[2] || '';
      const start = m.index + m[0].length - inner.length - 1;
      let value = inner;
      try { value = JSON.parse('"' + inner + '"'); } catch { /* keep raw */ }
      fields.push({ key, start, end: start + inner.length, value, type: 'string' });
    }
  }
  return fields;
}

/** Escape a user-typed value for splicing into a JSON string literal. */
function jsonStringEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Splice typed field values back into a command template (as found by
 *  `detectFields`). A blank value keeps the original placeholder/value. Numbers
 *  are spliced raw (unquoted); strings are JSON-escaped. */
function substituteFields(text, fields, values) {
  let result = text;
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    const val = values[i];
    if (val === undefined || val === null || val === '') continue;
    const piece = f.type === 'number' ? String(val) : jsonStringEscape(val);
    result = result.slice(0, f.start) + piece + result.slice(f.end);
  }
  return result;
}

/** Step a numeric field's value by `delta` (G: Ctrl/Alt+↑↓ in field-edit).
 *  Preserves integer vs decimal; clamps tiny float error. Returns a string. */
function stepNumber(current, delta) {
  const n = parseFloat(current);
  if (!isFinite(n)) return current;
  const next = n + delta;
  // Keep it an integer when both inputs are integers; otherwise round to the
  // step's precision so 0.1 steps don't accrue 0.30000000000000004.
  if (Number.isInteger(n) && Number.isInteger(delta)) return String(next);
  return String(parseFloat(next.toFixed(6)));
}

// ── Transcript export ─────────────────────────────────────────────────────────

/** Render scrollback lines as a plain-text transcript file body. */
function formatTranscript(lines, meta = {}) {
  const head = [
    `# whiskor shell transcript`,
    `# exported: ${new Date().toISOString()}`,
    `# server:   ${meta.host || '?'}:${meta.port || '?'} (whiskor v${meta.version || '?'})`,
    '',
  ];
  return head.concat(lines.map(l => l.text)).join('\n') + '\n';
}

// ── Input-line windowing ──────────────────────────────────────────────────────

/**
 * Slice the editor content so the cursor stays visible inside `avail` display
 * columns. Returns { text, cursorCol } (cursorCol relative to the slice, 0-based).
 */
function visibleSlice(chars, cursor, avail) {
  if (avail <= 0) return { text: '', cursorCol: 0 };
  // Walk left from the cursor until the window is full, then extend right.
  let start = cursor;
  let used = 1; // reserve one column for the cursor cell itself
  while (start > 0 && used + charWidth(chars[start - 1]) <= avail) {
    start--;
    used += charWidth(chars[start]);
  }
  let end = cursor;
  while (end < chars.length && used + charWidth(chars[end]) <= avail) {
    used += charWidth(chars[end]);
    end++;
  }
  let cursorCol = 0;
  for (let i = start; i < cursor; i++) cursorCol += charWidth(chars[i]);
  return { text: chars.slice(start, end).join(''), cursorCol };
}

// ── App ───────────────────────────────────────────────────────────────────────

async function startTui({ host, port }) {
  const out = process.stdout;
  const addr = { host, port };

  // ── live data ──
  let sessions = [];
  let graphs = [];
  let serverUp = false;

  function buildCatalog() {
    const tuiOnly = [
      { cat: 'shell', text: 'logs',   desc: 'Show recent server logs, formatted (logs [n])' },
      { cat: 'shell', text: 'export', desc: 'Save this session transcript to a file (export [path])' },
      { cat: 'shell', text: 'mouse',  desc: 'Toggle mouse capture (off = terminal text selection works)' },
      { cat: 'shell', text: 'map',    desc: 'Show an ASCII state-graph map for the active tab (map [tabId])' },
    ];
    return expandCatalog(baseCatalog().concat(tuiOnly), sessions, graphs);
  }

  async function refreshLive() {
    try {
      const h = await requestJson(addr, 'GET', '/health', null, 1500);
      serverUp = h.status === 200;
      const s = await requestJson(addr, 'GET', '/api/sessions', null, 3000);
      if (s.status === 200 && Array.isArray(s.body)) sessions = s.body;
      const g = await requestJson(addr, 'GET', '/api/graphs', null, 3000);
      if (g.status === 200 && Array.isArray(g.body)) graphs = g.body;
    } catch { serverUp = false; }
    catalog = buildCatalog();
    categories = categoriesOf(catalog);
  }

  let catalog = buildCatalog();
  let categories = categoriesOf(catalog);

  // ── state ──
  const editor = new LineEditor();
  const sb = new Scrollback();
  const history = loadHistory();
  const state = {
    sel: 0,
    navigated: false,
    popupHidden: false,
    histIdx: history.length,
    mode: 'normal',        // 'normal' | 'rsearch' | 'fieldedit'
    dir: null,             // current category folder (null = root)
    rquery: '',
    rIdx: -1,              // index into history for the current reverse match
    busy: false,
    spin: 0,
    stopped: false,
    mouse: true,
    fieldCmd: null,        // candidate being edited (fieldedit mode)
    fields: [],            // [{ key, start, end, value, type }] for fieldCmd.text
    fieldValues: [],       // confirmed value per field so far
    fieldIdx: 0,           // index of the field currently being typed
    fieldEditor: null,     // LineEditor for the active field's value
  };

  function candidates() {
    if (state.popupHidden) return [];
    return resolveCandidates(catalog, categories, state.dir, editor.text);
  }

  function enterFolder(c) {
    state.dir = c.folder || null; // '..' rows carry no folder → back to root
    editor.killLine();
    resetPopup();
  }

  /** → on a leaf candidate with editable JSON values opens the field-edit
   *  overlay, prefilling each field with its current value (empty placeholders
   *  stay empty). Returns false (no-op) for folders, '..' rows, or commands
   *  with nothing to fill in. */
  function tryEnterFieldEdit(c) {
    if (!c || c.folder || c.up) return false;
    const fields = detectFields(c.text || '');
    if (!fields.length) return false;
    state.mode = 'fieldedit';
    state.fieldCmd = c;
    state.fields = fields;
    state.fieldValues = fields.map(f => f.value || '');
    state.fieldIdx = 0;
    state.fieldEditor = new LineEditor(state.fieldValues[0] || '');
    return true;
  }

  function cancelFieldEdit() {
    state.mode = 'normal';
    state.fieldCmd = null;
    state.fields = [];
    state.fieldValues = [];
    state.fieldEditor = null;
  }

  /** Apply the typed field values to the command template and load the
   *  result into the main editor for review — Enter sends it as usual. */
  function applyFieldEdits() {
    const text = substituteFields(state.fieldCmd.text, state.fields, state.fieldValues);
    cancelFieldEdit();
    editor.set(text);
    resetPopup();
  }

  /** Popup rows for the field-edit overlay: a read-only preview of the
   *  command template, then one row per field (current value or placeholder). */
  function fieldEditRows() {
    const rows = [{ text: state.fieldCmd.text, desc: 'fill in the fields below, Enter to apply', preview: true }];
    state.fields.forEach((f, i) => {
      const val = i === state.fieldIdx ? state.fieldEditor.text : state.fieldValues[i];
      rows.push({ text: `${f.key}: ${val}`, desc: '', field: true });
    });
    return rows;
  }

  function rsearchMatches() {
    const q = state.rquery.toLowerCase();
    const out2 = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (!q || history[i].toLowerCase().includes(q)) out2.push({ text: history[i], desc: 'history', idx: i });
      if (out2.length >= POPUP_MAX) break;
    }
    return out2;
  }

  /** One source of truth for the screen split — render and the scroll
   *  handlers must agree on the output-pane height, or the scroll range
   *  clamps a few rows short. */
  function layout() {
    const rows = out.rows || 24;
    const cols = out.columns || 80;
    const popup = state.mode === 'rsearch' ? rsearchMatches()
      : state.mode === 'fieldedit' ? fieldEditRows()
      : candidates();
    const popupH = Math.min(popup.length, POPUP_MAX);
    // Window the (possibly longer) list so the selection stays visible.
    // The field-edit overlay is short and fixed — no windowing needed.
    const popupStart = state.mode === 'fieldedit'
      ? 0
      : Math.max(0, Math.min(state.sel - popupH + 1, popup.length - popupH));
    const outputH = Math.max(1, rows - 2 - popupH); // -input -status
    return { rows, cols, popup, popupH, popupStart, outputH };
  }

  // ── rendering ──
  function colorize(row) {
    switch (row.kind) {
      case 'json':  return highlightJsonLine(row.text);
      case 'cmd':   return ansi.bold(ansi.fg.cyan(row.text));
      case 'info':  return ansi.fg.green(row.text);
      case 'warn':  return ansi.fg.yellow(row.text);
      case 'error': return ansi.fg.red(row.text);
      default:      return row.text;
    }
  }

  function render() {
    if (state.stopped) return;
    const { cols, popup, popupH, popupStart, outputH } = layout();

    let frame = ansi.hideCursor;

    // output pane
    const view = sb.view(outputH, cols);
    const blank = outputH - view.rows.length;
    for (let i = 0; i < outputH; i++) {
      frame += ansi.moveTo(i + 1, 1) + ansi.clearLine;
      const row = i >= blank ? view.rows[i - blank] : null;
      if (row) frame += colorize(row);
    }

    // popup (windowed around the selection, or the field-edit overlay)
    // Every row gets a full-width background band: the terminal is often run
    // semi-transparent over a browser, and foreground-only text mixes with the
    // page behind it. clearLine paints the default (translucent) background,
    // so the band is padded to full width explicitly.
    const activeIdx = state.mode === 'fieldedit' ? state.fieldIdx + 1 : state.sel;
    for (let i = 0; i < popupH; i++) {
      const r = outputH + 1 + i;
      frame += ansi.moveTo(r, 1) + ansi.clearLine;
      const c = popup[popupStart + i];
      const isDir = !!(c.folder || c.up);
      const head = truncateToWidth(c.text, Math.max(8, Math.floor(cols * 0.55)));
      const rest = Math.max(0, cols - 3 - strWidth(head) - 2);
      const desc = truncateToWidth(c.desc || '', rest);
      let line;
      if (c.preview) {
        line = ' ' + ansi.fg.gray(head) + '   ' + ansi.fg.gray(desc);
      } else if ((popupStart + i) === activeIdx) {
        line = ansi.inverse(' ' + head + ' ') + '  ' + ansi.fg.gray(desc);
      } else {
        line = ' ' + (isDir ? ansi.bold(ansi.fg.cyan(head)) : head) + '   ' + ansi.fg.gray(desc);
      }
      const pad = Math.max(0, cols - strWidth(stripAnsi(line)));
      frame += ansi.bg256(POPUP_BG, line + ' '.repeat(pad));
    }

    // input line (prompt carries the folder breadcrumb, or the active field name)
    const inputRow = outputH + popupH + 1;
    frame += ansi.moveTo(inputRow, 1) + ansi.clearLine;
    const base = state.dir ? `whiskor ${state.dir}> ` : PROMPT;
    const promptStr = state.mode === 'rsearch'
      ? `(reverse-i-search '${state.rquery}') `
      : state.mode === 'fieldedit'
        ? `${state.fields[state.fieldIdx].key}: `
        : (state.busy ? SPINNER[state.spin % SPINNER.length] + ' ' + base.slice(2) : base);
    const activeEditor = state.mode === 'fieldedit' ? state.fieldEditor : editor;
    const avail = Math.max(4, cols - strWidth(promptStr) - 1);
    const slice = visibleSlice(activeEditor.chars, activeEditor.cursor, avail);
    frame += ansi.bold(promptStr) + slice.text;

    // status bar
    const dot = serverUp ? ansi.fg.green('●') : ansi.fg.red('●');
    const left = ` whiskor v${PKG_VERSION} · ${host}:${port} · ${sessions.length} sessions · ${graphs.length} graphs `;
    const scrollNote = !sb.offset ? '' : `[SCROLL +${sb.offset}] `;
    const hints = state.mode === 'fieldedit'
      ? `Tab/Enter:next field (last=apply)  Esc/Backspace:cancel  ^C:quit `
      : `${scrollNote}Tab:complete ↑↓:select ←→:folders/fields Wheel/PgUp:scroll ^R:history ^C:quit `;
    const gap = Math.max(1, cols - strWidth(left) - strWidth(hints) - 2);
    frame += ansi.moveTo(inputRow + 1, 1) + ansi.clearLine +
      ansi.inverse(' ' + padToWidth(left + ' '.repeat(gap) + hints, cols - 2) + ' ').slice(0, 4000);
    // (dot drawn separately so inverse doesn't eat its color)
    frame += ansi.moveTo(inputRow + 1, 2) + dot;

    // park the cursor inside the editor
    frame += ansi.moveTo(inputRow, strWidth(promptStr) + slice.cursorCol + 1) + ansi.showCursor;
    out.write(frame);
  }

  // ── command execution ──
  const print = (text, kind = 'plain') => sb.push(text, kind);

  async function execute(line) {
    // `!cmd` → run in the local host shell (see runShellEscape in cli-shell.js).
    // Local-only escape hatch; never exposed over HTTP/MCP.
    if (line.trimStart().startsWith('!')) {
      const cmdline = line.trimStart().slice(1).trim();
      if (!cmdline) { print('usage: !<command> — runs in your local shell (pwsh / $SHELL)', 'warn'); return; }
      const res = await runShellEscape(cmdline);
      if (res.failed) { print(`shell unavailable: ${res.error}`, 'error'); return; }
      const o = shellOutputLines(res.out);
      const e = shellOutputLines(res.err);
      for (const l of o.lines) print(l, 'plain');
      if (o.extra) print(`… (${o.extra} more stdout lines)`, 'plain');
      for (const l of e.lines) print(l, 'warn');
      if (e.extra) print(`… (${e.extra} more stderr lines)`, 'plain');
      if (res.killed) print(`(timed out — process killed)`, 'error');
      else print(`[${res.shell}] exit ${res.code}`, res.code === 0 ? 'info' : 'error');
      return;
    }

    // TUI-only builtin: mouse capture toggle. With capture on, the wheel
    // scrolls the output pane but terminal text selection needs Shift held;
    // 'mouse' flips the trade-off without leaving the shell.
    if (line.trim().toLowerCase() === 'mouse') {
      state.mouse = !state.mouse;
      out.write(state.mouse ? ansi.mouseOn : ansi.mouseOff);
      print(`mouse capture ${state.mouse ? 'on (wheel scrolls output; hold Shift to select text)' : 'off (terminal selection back to normal; use PgUp/PgDn to scroll)'}`, 'info');
      return;
    }

    // TUI-only builtin: show recent server logs (ring buffer via /api/logs).
    const logsM = line.trim().match(/^logs(?:\s+(\d+))?$/i);
    if (logsM) {
      const limit = logsM[1] ? parseInt(logsM[1], 10) : 100;
      try {
        const res = await requestJson(addr, 'GET', `/api/logs?limit=${limit}`);
        if (res.status !== 200 || !Array.isArray(res.body)) {
          print(`server logs unavailable (HTTP ${res.status}) — older server build without /api/logs?`, 'warn');
          return;
        }
        if (!res.body.length) { print('(no server log lines yet)', 'plain'); return; }
        for (const l of res.body) {
          const t = new Date(l.ts).toTimeString().slice(0, 8);
          print(`${t} [${l.level}] ${l.message}`, l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'plain');
        }
        print(`(${res.body.length} lines — 'export' saves this whole transcript to a file)`, 'plain');
      } catch (e) { print(`logs failed: ${e.message}`, 'error'); }
      return;
    }

    // TUI-only builtin: ASCII state-graph map for a tab (default: the most
    // recently active session). Server-side falls back across graphs when the
    // session's own siteVersion has none yet — see GET /api/sessions/:tabId/map.
    const mapM = line.trim().match(/^map(?:\s+(\d+))?$/i);
    if (mapM) {
      let tabId = mapM[1] ? parseInt(mapM[1], 10) : null;
      if (tabId == null) {
        const newest = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (!newest) { print('no active session — open a tab with the extension first.', 'warn'); return; }
        tabId = newest.tabId;
      }
      try {
        const res = await requestJson(addr, 'GET', `/api/sessions/${tabId}/map`);
        if (res.status === 404) { print(`map: no session for tabId ${tabId}.`, 'warn'); return; }
        if (res.status !== 200 || !res.body || typeof res.body.graph !== 'string') {
          print(`map unavailable (HTTP ${res.status}) — older server build without /api/sessions/:tabId/map?`, 'warn');
          return;
        }
        for (const l of res.body.graph.split('\n')) print(l, 'plain');
      } catch (e) { print(`map failed: ${e.message}`, 'error'); }
      return;
    }

    // TUI-only builtin: export the session transcript (scrollback) to a file.
    const expM = line.trim().match(/^export(?:\s+(.+))?$/i);
    if (expM) {
      const target = expM[1]
        ? path.resolve(expM[1].trim())
        : path.join(os.homedir(), '.whiskor', 'logs',
            `whiskor-shell-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
      try {
        if (fs.existsSync(target)) {
          print(`export refused: ${target} already exists — pass a new file name.`, 'warn');
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, formatTranscript(sb.lines, { host, port, version: PKG_VERSION }), 'utf8');
        print(`transcript exported: ${target} (${sb.lines.length} lines)`, 'info');
        print(`tip: run 'logs' first to pull server logs into the transcript too.`, 'plain');
      } catch (e) { print(`export failed: ${e.message}`, 'error'); }
      return;
    }

    const cmd = parseCommand(line);
    switch (cmd.kind) {
      case 'empty': return;
      case 'builtin':
        if (cmd.name === 'exit')  { stop(); return; }
        if (cmd.name === 'clear') { sb.clear(); return; }
        if (cmd.name === 'help') {
          print(`Syntax:  GET <path> · POST <path> [json] · DELETE <path>`, 'info');
          print(`Builtins: help · refresh · clear · logs [n] · export [path] · map [tabId] · mouse · exit`, 'info');
          print(`Shell:    !<command> runs in your local shell (pwsh / $SHELL) — local only`, 'info');
          print(`Folders: categories (action/, capture/, …) open like folders — Enter/Tab/double-click`, 'plain');
          print(`         opens one, Esc / '..' / Backspace-on-empty goes back. Typing at the root`, 'plain');
          print(`         searches across everything; inside a folder it filters that folder.`, 'plain');
          print(`Keys: type=filter  ↑/↓=select (↑ on a fresh line = history)  Tab=adopt  Enter=run`, 'plain');
          print(`      On an empty line: →=open folder, or open field-edit for a command with`, 'plain');
          print(`      JSON values (selector, text, url, deltaY, …); ←=back out of folder.`, 'plain');
          print(`      Field-edit: each value is prefilled & editable, Tab/Enter=next field`, 'plain');
          print(`      (last=apply to the input line for review), Esc/Backspace-on-empty=cancel.`, 'plain');
          print(`      In a numeric field: Ctrl+↑↓ = ±1, Alt+↑↓ = ±10 (quick scroll/delta tuning).`, 'plain');
          print(`      Wheel / PgUp/PgDn / Ctrl+↑↓ = scroll output  Ctrl+L=clear  Ctrl+R=history search`, 'plain');
          print(`      Ctrl+A/E=home/end  Ctrl+W=del word  Ctrl+K=kill to end  Ctrl+U=clear line`, 'plain');
          print(`Mouse capture is ON by default (wheel scrolls; hold Shift to select text).`, 'plain');
          print(`Type 'mouse' to toggle it off and get normal terminal selection back.`, 'plain');
          return;
        }
        if (cmd.name === 'refresh') {
          await refreshLive();
          print(serverUp
            ? `refreshed: ${sessions.length} sessions, ${graphs.length} graphs`
            : `server not responding on ${host}:${port}`, serverUp ? 'info' : 'warn');
          return;
        }
        return;
      case 'http': {
        if (/:(tabId|siteVersion)\b/.test(cmd.path)) {
          print(`Path still contains a placeholder (${cmd.path}) — pick a concrete candidate or run 'refresh'.`, 'warn');
          return;
        }
        appendHistory(line.trim());
        try {
          const res = await requestJson(addr, cmd.method, cmd.path, cmd.body);
          print(`HTTP ${res.status}`, res.status < 400 ? 'info' : 'error');
          const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
          print(text, typeof res.body === 'string' ? 'plain' : 'json');
        } catch (e) {
          print(`Request failed: ${e.message}` +
            (e.code === 'ECONNREFUSED' ? ` — is the server running? (start with: whk)` : ''), 'error');
        }
        return;
      }
      default:
        print(`Not a command. Use 'GET <path>' / 'POST <path> [json]', or 'help'.`, 'warn');
    }
  }

  // ── lifecycle ──
  let restored = false;
  function restoreScreen() {
    if (restored) return;
    restored = true;
    try {
      out.write(ansi.mouseOff + ansi.altScreenOff + ansi.showCursor);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* terminal already gone */ }
  }

  let healthTimer = null;
  let spinTimer = null;

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    clearInterval(healthTimer);
    clearInterval(spinTimer);
    restoreScreen();
    process.stdin.pause();
  }

  // Restore the user's terminal even on crashes — an alt-screen left on is
  // the cardinal TUI sin.
  process.on('exit', restoreScreen);

  out.write(ansi.altScreenOn + ansi.clearScreen + ansi.mouseOn);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // ── Input plumbing ──────────────────────────────────────────────────────────
  // readline's keypress parser does NOT understand SGR mouse sequences — it
  // gives up at the '<' and the trailing "64;12;5M" arrives as ordinary typed
  // characters (the "scrolling types garbage into the input" bug). So stdin
  // never reaches readline directly: a filter extracts mouse events and only
  // forwards the cleaned bytes to a PassThrough that readline parses.
  const keyStream = new PassThrough();
  let pendingEsc = '';
  let pendingTimer = null;

  function handleMouse(events) {
    if (state.stopped || !state.mouse) return;
    let dirty = false;
    for (const ev of events) {
      if (!ev.press) continue;
      if (ev.wheel) {
        const { cols, outputH } = layout();
        if (ev.wheel === 'up') sb.scrollUp(3, outputH, cols);
        else sb.scrollDown(3);
        dirty = true;
      } else if (ev.button === 0 && state.mode === 'normal' && !state.busy) {
        // Left click on a popup row selects it; a second click on the already
        // selected row activates it (opens a folder / adopts a command).
        const { popup, popupH, popupStart, outputH } = layout();
        const idx = ev.row - (outputH + 1);
        if (idx >= 0 && idx < popupH) {
          const absolute = popupStart + idx;
          if (absolute === state.sel && popup[absolute]) {
            const c = popup[absolute];
            if (c.folder || c.up) enterFolder(c);
            else { editor.set(c.text); resetPopup(); }
          } else {
            state.sel = absolute;
            state.navigated = true;
          }
          dirty = true;
        }
      }
    }
    if (dirty) render();
  }

  function feedStdin(chunk) {
    if (state.stopped) return;
    let s = pendingEsc + chunk.toString('utf8');
    pendingEsc = '';
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }

    // A sequence can split across chunks — hold back a trailing partial escape
    // and prepend it to the next chunk. A short flush timer keeps a bare Esc
    // keypress (a lone \x1b chunk) from being held hostage.
    const split = splitTrailingEscape(s);
    if (split.partial) {
      pendingEsc = split.partial;
      s = split.body;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const flush = pendingEsc;
        pendingEsc = '';
        if (flush && !state.stopped) keyStream.write(flush);
      }, 50);
      pendingTimer.unref?.();
    }
    if (!s) return;

    const events = parseSgrMouse(s);
    if (events.length) handleMouse(events);
    const cleaned = stripSgrMouse(s);
    if (cleaned) keyStream.write(cleaned);
  }

  process.stdin.on('data', feedStdin);
  readline.emitKeypressEvents(keyStream);

  await refreshLive();
  print(`whiskor shell — ${host}:${port} ` +
    (serverUp ? `(connected · ${sessions.length} sessions · ${graphs.length} graphs)` : `(server not responding — start it with 'whk')`),
    serverUp ? 'info' : 'warn');
  print(`Type to search, Tab to adopt, Enter to run. 'help' for keys, 'exit' or Ctrl+C to leave.`, 'plain');

  healthTimer = setInterval(async () => {
    if (state.busy || state.stopped) return;
    await refreshLive();
    render();
  }, HEALTH_POLL_MS);
  healthTimer.unref?.();

  out.on('resize', render);

  function resetPopup() { state.sel = 0; state.navigated = false; state.popupHidden = false; }

  async function onEnter() {
    if (state.mode === 'rsearch') {
      const m = rsearchMatches();
      if (m.length) editor.set(m[Math.min(state.sel, m.length - 1)].text);
      state.mode = 'normal'; state.rquery = ''; resetPopup();
      render();
      return;
    }
    const cands = candidates();
    // Enter runs the highlighted candidate when the user navigated to it,
    // typed nothing, or the input is just a search term (e.g. 'h' filtering
    // to 'GET /health') — only a line that parses as a runnable command is
    // sent as typed. Folder rows open instead of executing.
    const typedKind = parseCommand(editor.text).kind;
    // A `!`-prefixed line is always run as typed (shell escape), never replaced
    // by a highlighted candidate.
    const bang = editor.text.trimStart().startsWith('!');
    const useSelected = !bang && cands.length && (state.navigated || typedKind === 'unknown' || typedKind === 'empty');
    const chosen = useSelected ? cands[Math.min(state.sel, cands.length - 1)] : null;
    if (chosen && (chosen.folder || chosen.up)) { enterFolder(chosen); render(); return; }
    const line = chosen ? chosen.text : editor.text;
    if (!line.trim()) return;

    print((state.dir ? `whiskor ${state.dir}> ` : PROMPT) + line, 'cmd');
    editor.killLine();
    resetPopup();
    state.busy = true;
    spinTimer = setInterval(() => { state.spin++; render(); }, 120);
    spinTimer.unref?.();
    render();
    try { await execute(line); }
    finally {
      clearInterval(spinTimer);
      state.busy = false;
    }
    if (state.stopped) return;
    if (line.trim() && history[history.length - 1] !== line.trim()) history.push(line.trim());
    state.histIdx = history.length;
    render();
  }

  keyStream.on('keypress', (str, key = {}) => {
    if (state.stopped) return;
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) { stop(); return; }
    if (state.busy) return; // a command is running — queueing keys invites double-fires

    // ── reverse-i-search mode ──
    if (state.mode === 'rsearch') {
      if (key.name === 'escape') { state.mode = 'normal'; state.rquery = ''; resetPopup(); render(); return; }
      if (key.name === 'return' || key.name === 'enter') { onEnter(); return; }
      if (key.name === 'backspace') { state.rquery = state.rquery.slice(0, -1); state.sel = 0; render(); return; }
      if (key.ctrl && key.name === 'r') { state.sel = Math.min(rsearchMatches().length - 1, state.sel + 1); render(); return; }
      if (key.name === 'up')   { state.sel = Math.min(rsearchMatches().length - 1, state.sel + 1); render(); return; }
      if (key.name === 'down') { state.sel = Math.max(0, state.sel - 1); render(); return; }
      if (str && !key.ctrl && !key.meta && str >= ' ') { state.rquery += str; state.sel = 0; render(); }
      return;
    }

    // ── field-edit mode (→ on a candidate with free-input placeholders) ──
    if (state.mode === 'fieldedit') {
      if (key.name === 'escape') { cancelFieldEdit(); render(); return; }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') {
        state.fieldValues[state.fieldIdx] = state.fieldEditor.text;
        if (state.fieldIdx < state.fields.length - 1) {
          state.fieldIdx++;
          state.fieldEditor = new LineEditor(state.fieldValues[state.fieldIdx]);
        } else {
          applyFieldEdits();
        }
        render(); return;
      }
      if (key.name === 'backspace') {
        if (!state.fieldEditor.backspace()) {
          // Empty field, Backspace again: step back a field, or cancel from the first.
          if (state.fieldIdx > 0) {
            state.fieldIdx--;
            state.fieldEditor = new LineEditor(state.fieldValues[state.fieldIdx]);
          } else {
            cancelFieldEdit();
          }
        }
        render(); return;
      }
      // G: step a numeric field — Ctrl+↑↓ = ±1, Alt+↑↓ = ±10 (can cross zero
      // into negatives). Quick repeated adjust for scroll deltas etc.
      if ((key.ctrl || key.meta) && (key.name === 'up' || key.name === 'down')) {
        const f = state.fields[state.fieldIdx];
        if (f && f.type === 'number') {
          const step = (key.meta ? 10 : 1) * (key.name === 'up' ? 1 : -1);
          state.fieldEditor.set(stepNumber(state.fieldEditor.text, step));
          render();
        }
        return;
      }
      if (key.name === 'left')   { if (key.ctrl || key.meta) state.fieldEditor.wordLeft(); else state.fieldEditor.left(); render(); return; }
      if (key.name === 'right')  { if (key.ctrl || key.meta) state.fieldEditor.wordRight(); else state.fieldEditor.right(); render(); return; }
      if (key.name === 'home')   { state.fieldEditor.home(); render(); return; }
      if (key.name === 'end')    { state.fieldEditor.end(); render(); return; }
      if (key.name === 'delete') { state.fieldEditor.del(); render(); return; }
      if (key.ctrl && key.name === 'u') { state.fieldEditor.killLine(); render(); return; }
      if (key.ctrl && key.name === 'k') { state.fieldEditor.killToEnd(); render(); return; }
      if (key.ctrl && key.name === 'w') { state.fieldEditor.killWordLeft(); render(); return; }
      if (str && !key.ctrl && !key.meta && str >= ' ') { state.fieldEditor.insert(str); render(); return; }
      return;
    }

    // ── normal mode ──
    if (key.ctrl && key.name === 'r') { state.mode = 'rsearch'; state.rquery = ''; state.sel = 0; render(); return; }
    if (key.ctrl && key.name === 'l') { sb.clear(); render(); return; }
    if (key.ctrl && key.name === 'u') { editor.killLine(); resetPopup(); render(); return; }
    if (key.ctrl && key.name === 'k') { editor.killToEnd(); resetPopup(); render(); return; }
    if (key.ctrl && key.name === 'w') { editor.killWordLeft(); resetPopup(); render(); return; }
    if (key.ctrl && key.name === 'a') { editor.home(); render(); return; }
    if (key.ctrl && key.name === 'e') { editor.end(); render(); return; }

    if (key.name === 'pageup')   { const { cols, outputH } = layout(); sb.scrollUp(Math.max(1, outputH - 1), outputH, cols); render(); return; }
    if (key.name === 'pagedown') { const { outputH } = layout(); sb.scrollDown(Math.max(1, outputH - 1)); render(); return; }
    if (key.ctrl && key.name === 'up')   { const { cols, outputH } = layout(); sb.scrollUp(1, outputH, cols); render(); return; }
    if (key.ctrl && key.name === 'down') { sb.scrollDown(1); render(); return; }

    if (key.name === 'left') {
      if (key.ctrl || key.meta) { editor.wordLeft(); render(); return; }
      // On an empty line, ← steps back out of the current folder (mirrors
      // Esc / Backspace-on-empty) instead of moving a cursor that's already at 0.
      if (editor.text === '' && state.dir) { state.dir = null; resetPopup(); render(); return; }
      editor.left(); render(); return;
    }
    if (key.name === 'right') {
      if (key.ctrl || key.meta) { editor.wordRight(); render(); return; }
      // On an empty line, → "descends" into the highlighted row: open a
      // folder, or open the field-edit overlay for a command with editable
      // JSON values (prefilled). Otherwise it's a normal cursor move.
      if (editor.text === '') {
        const cands = candidates();
        const c = cands[Math.min(state.sel, cands.length - 1)];
        if (c) {
          if (c.folder || c.up) { enterFolder(c); render(); return; }
          if (tryEnterFieldEdit(c)) { render(); return; }
        }
        render(); return;
      }
      editor.right(); render(); return;
    }
    if (key.name === 'home')  { editor.home(); render(); return; }
    if (key.name === 'end')   { editor.end(); render(); return; }
    if (key.meta && key.name === 'b') { editor.wordLeft(); render(); return; }
    if (key.meta && key.name === 'f') { editor.wordRight(); render(); return; }

    if (key.name === 'up') {
      const cands = candidates();
      // ↑ before any list navigation recalls history (REPL muscle memory);
      // once navigating (or filtering), it moves the selection.
      if (cands.length && (state.navigated || editor.text.trim())) {
        state.sel = Math.max(0, state.sel - 1); state.navigated = true;
      } else if (history.length) {
        state.histIdx = Math.max(0, state.histIdx - 1);
        editor.set(history[state.histIdx] || '');
        state.popupHidden = true;
      }
      render(); return;
    }
    if (key.name === 'down') {
      const cands = candidates();
      if (cands.length) {
        state.sel = Math.min(cands.length - 1, state.sel + 1); state.navigated = true;
      } else if (history.length) {
        state.histIdx = Math.min(history.length, state.histIdx + 1);
        editor.set(history[state.histIdx] || '');
        state.popupHidden = true;
      }
      render(); return;
    }

    if (key.name === 'tab') {
      const cands = candidates();
      if (cands.length) {
        const c = cands[Math.min(state.sel, cands.length - 1)];
        if (c.folder || c.up) enterFolder(c);
        else { editor.set(c.text); resetPopup(); }
      }
      render(); return;
    }
    if (key.name === 'escape') {
      if (state.dir) { state.dir = null; editor.killLine(); resetPopup(); }
      else { state.popupHidden = true; state.navigated = false; }
      render(); return;
    }
    if (key.name === 'return' || key.name === 'enter') { onEnter(); return; }
    if (key.name === 'backspace') {
      // Backspace on an empty line inside a folder backs out of the folder.
      if (!editor.backspace() && state.dir) { state.dir = null; }
      resetPopup();
      render(); return;
    }
    if (key.name === 'delete')    { editor.del(); resetPopup(); render(); return; }

    if (str && !key.ctrl && !key.meta && str >= ' ') {
      editor.insert(str); // multi-char str = IME compose / paste
      resetPopup();
      render(); return;
    }
  });

  render();

  await new Promise(resolve => {
    const t = setInterval(() => { if (state.stopped) { clearInterval(t); resolve(); } }, 80);
  });
  restoreScreen();
}

module.exports = { startTui, visibleSlice, resolveCandidates, categoriesOf, formatTranscript, detectFields, substituteFields, stepNumber };
