'use strict';
/**
 * server/cli-shell.js — `whk shell`: interactive HTTP API shell
 *
 * EN: A zero-dependency incremental-search shell for humans. Type to filter a
 *     catalog of API commands (fzf-style), arrows to pick, Tab to adopt, Enter
 *     to run. Live tabIds / siteVersions from the running server are expanded
 *     into the candidates so you never type an id by hand. Falls back to a
 *     plain line-REPL when stdin is not a TTY (pipes, CI).
 * JA: ゼロ依存の人間用インタラクティブシェル。入力で APIコマンドカタログを
 *     インクリメンタル絞り込み（fzf風）、矢印で選択、Tab で取り込み、Enter で
 *     実行。稼働中サーバーから実際の tabId / siteVersion を候補に展開するので
 *     IDを手打ちしなくてよい。stdin が TTY でない場合は素朴な行REPLに落ちる。
 *
 * Keys: ↑/↓ select · Tab adopt · Enter run · Ctrl+P/N history · Ctrl+U clear
 *       line · Ctrl+L clear screen · Ctrl+C / Ctrl+D exit
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const MAX_SHOW    = 8;    // candidate rows under the prompt
const MAX_HISTORY = 500;
const PROMPT      = 'whiskor> ';

// ── Catalog ───────────────────────────────────────────────────────────────────

// Every entry carries a `cat` — the TUI renders categories as folders
// (action/, capture/, …) while the classic shell keeps the flat list.
function baseCatalog() {
  return [
    // server/
    { cat: 'server', text: 'GET /health',                   desc: 'Server status (extensions, sessions, secretGuard)' },
    { cat: 'server', text: 'GET /api/config',               desc: 'Current configuration' },
    { cat: 'server', text: 'GET /api/logs?limit=100',       desc: 'Recent server log lines (raw JSON)' },
    { cat: 'server', text: 'POST /api/extension/reload',    desc: 'Ask the connected extension to reload itself' },
    { cat: 'server', text: 'POST /api/collect {"tabId":0}', desc: 'Trigger data collection' },
    { cat: 'server', text: 'POST /api/embed {"texts":["hello"]}', desc: 'Embed texts (MiniLM vectors)' },

    // session/
    { cat: 'session', text: 'GET /api/sessions',            desc: 'List browser sessions' },
    { cat: 'session', text: 'GET /api/sessions/:tabId',     desc: 'Session detail for one tab' },
    { cat: 'session', text: 'GET /api/sessions/:tabId/raw/delta/smart.json', desc: 'Smart delta (aggregated motion)' },
    { cat: 'session', text: 'DELETE /api/sessions/:tabId',  desc: 'Delete a session' },

    // state/
    { cat: 'state', text: 'GET /api/graphs',                desc: 'List state graphs' },
    { cat: 'state', text: 'GET /api/graphs/:siteVersion/states', desc: 'Nodes of one state graph' },
    { cat: 'state', text: 'GET /api/sessions/:tabId/states', desc: 'State-graph nodes seen by a session' },
    { cat: 'state', text: 'GET /api/sessions/:tabId/map',    desc: 'ASCII state-graph map for a session (whk shell: map)' },

    // capture/
    { cat: 'capture', text: 'POST /api/screenshot {"tabId":0}',  desc: 'Capture a screenshot' },
    { cat: 'capture', text: 'POST /api/packed-som {"tabId":0}',  desc: 'Packed Set-of-Marks capture' },
    { cat: 'capture', text: 'POST /api/element-thumbnail {"tabId":0,"selector":""}', desc: 'Per-element thumbnail' },

    // action/ — one shortcut per action type (see skills/browser-whiskor-http)
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"click","text":""}}',            desc: 'Click by visible text (safest)' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"click","selector":""}}',        desc: 'Click by CSS selector' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"analyze_click","selector":""}}', desc: 'Dry-run clickability report (no side effects)' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"type","selector":"","text":"","clear":true}}', desc: 'Type into an input' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"press_key","key":"Enter"}}',    desc: 'Press a key (Enter/Tab/Escape/Arrow…)' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"hover","selector":""}}',        desc: 'Hover an element' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"scroll","deltaY":500}}',        desc: 'Scroll the page' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"navigate","url":"https://"}}',  desc: 'Navigate the tab to a URL' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"go_back"}}',                    desc: 'History back' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"reload"}}',                     desc: 'Reload the tab' },
    { cat: 'action', text: 'POST /api/action {"tabId":0,"action":{"type":"list_tabs"}}',                  desc: 'List browser tabs (read-only)' },

    // shell/
    { cat: 'shell', text: 'refresh', desc: 'Re-fetch sessions/graphs for completion' },
    { cat: 'shell', text: 'help',    desc: 'Shell help (keys + syntax)' },
    { cat: 'shell', text: 'clear',   desc: 'Clear the screen' },
    { cat: 'shell', text: 'exit',    desc: 'Leave the shell' },
  ];
}

function _shortUrl(url) {
  try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); }
  catch { return url || ''; }
}

/**
 * Expand templates with live values so concrete, runnable commands appear:
 *  - path `:tabId` / `:siteVersion` placeholders → one variant per live id
 *  - body `"tabId":0` (POST templates) → rewritten IN PLACE to the freshest
 *    session's tabId, so action/capture shortcuts target the page you are
 *    actually driving without retyping ids
 */
function expandCatalog(base, sessions = [], graphs = []) {
  const recent = [...sessions]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SHOW);
  const newest = recent[0] || null;
  const out = [];
  for (const entry of base) {
    if (newest && entry.text.includes('"tabId":0')) {
      out.push({
        ...entry,
        text: entry.text.replace('"tabId":0', `"tabId":${newest.tabId}`),
        desc: `${entry.desc} → ${_shortUrl(newest.url)}`.slice(0, 90),
      });
    } else {
      out.push(entry);
    }
    if (entry.text.includes(':tabId')) {
      for (const s of recent) {
        out.push({
          cat: entry.cat,
          text: entry.text.replaceAll(':tabId', String(s.tabId)),
          desc: `${_shortUrl(s.url)}${s.title ? ' — ' + s.title : ''}`.slice(0, 70),
          concrete: true,
        });
      }
    }
    if (entry.text.includes(':siteVersion')) {
      for (const g of graphs.slice(0, MAX_SHOW)) {
        out.push({
          cat: entry.cat,
          text: entry.text.replaceAll(':siteVersion', String(g.siteVersion)),
          desc: `graph ${g.siteVersion}: ${g.nodeCount} nodes / ${g.edgeCount} edges`,
          concrete: true,
        });
      }
    }
  }
  return out;
}

/**
 * Every whitespace-separated token of the query must hit text or desc
 * (case-insensitive). Rank: prefix on text > substring on text > desc hit.
 */
function filterCandidates(catalog, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return catalog.slice();
  const tokens = q.split(/\s+/);
  const scored = [];
  for (const c of catalog) {
    const text = c.text.toLowerCase();
    const desc = (c.desc || '').toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      if (text.startsWith(t))      score += 100;
      else if (text.includes(t))   score += 30;
      else if (desc.includes(t))   score += 10;
      else { ok = false; break; }
    }
    if (ok) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.c);
}

// ── Command parsing / execution ───────────────────────────────────────────────

const HTTP_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)(?:\s+(.+))?$/i;

function parseCommand(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return { kind: 'empty' };
  const lower = trimmed.toLowerCase();
  if (['exit', 'quit', 'q'].includes(lower)) return { kind: 'builtin', name: 'exit' };
  if (['help', '?'].includes(lower))         return { kind: 'builtin', name: 'help' };
  if (lower === 'clear')                     return { kind: 'builtin', name: 'clear' };
  if (lower === 'refresh')                   return { kind: 'builtin', name: 'refresh' };
  const m = trimmed.match(HTTP_RE);
  if (m) return { kind: 'http', method: m[1].toUpperCase(), path: m[2], body: m[3] || null };
  return { kind: 'unknown', line: trimmed };
}

function requestJson({ host, port }, method, pathname, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: host, port, path: pathname, method, timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let parsed; try { parsed = JSON.parse(d); } catch { parsed = d; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Shell ─────────────────────────────────────────────────────────────────────

const HISTORY_FILE = path.join(os.homedir(), '.whiskor', 'shell-history.txt');

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_HISTORY);
  } catch { return []; }
}

function appendHistory(line) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, line + '\n', 'utf8');
  } catch { /* history is best-effort */ }
}

function printHelp(write) {
  write(`
Syntax:   GET <path>   ·   POST <path> [json]   ·   DELETE <path>
Builtins: help · refresh (re-fetch ids for completion) · clear · exit
Keys:     type = filter   ↑/↓ = select   Tab = adopt   Enter = run
          Ctrl+P/N = history   Ctrl+U = clear line   Ctrl+L = clear screen
          Ctrl+C / Ctrl+D = exit
Note:     a :tabId / :siteVersion left in a path is a placeholder — pick one of
          the concrete candidates underneath, or run 'refresh' to fetch live ids.
`);
}

function formatResult(res, write) {
  const color = res.status < 400 ? '\x1b[32m' : '\x1b[31m';
  write(`${color}HTTP ${res.status}\x1b[0m\n`);
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
  const lines = text.split('\n');
  const CAP = 400;
  write(lines.slice(0, CAP).join('\n') + '\n');
  if (lines.length > CAP) {
    write(`\x1b[90m... (${lines.length - CAP} more lines — run it via 'whk ${'GET'} <path>' outside the shell for full output)\x1b[0m\n`);
  }
}

async function startShell({ host, port }) {
  const write = (s) => process.stdout.write(s);
  const addr = { host, port };

  let sessions = [];
  let graphs = [];
  let serverUp = false;

  async function refreshLive() {
    try {
      const h = await requestJson(addr, 'GET', '/health', null, 1500);
      serverUp = h.status === 200;
      const s = await requestJson(addr, 'GET', '/api/sessions', null, 3000);
      if (s.status === 200 && Array.isArray(s.body)) sessions = s.body;
      const g = await requestJson(addr, 'GET', '/api/graphs', null, 3000);
      if (g.status === 200 && Array.isArray(g.body)) graphs = g.body;
    } catch { serverUp = false; }
  }

  await refreshLive();
  let catalog = expandCatalog(baseCatalog(), sessions, graphs);

  write(`\x1b[36mwhiskor shell\x1b[0m — ${host}:${port} ` +
    (serverUp
      ? `\x1b[32m(connected · ${sessions.length} sessions · ${graphs.length} graphs)\x1b[0m\n`
      : `\x1b[33m(server not responding — start it with 'whk'; commands will fail until then)\x1b[0m\n`));
  write(`Type to search, Tab to adopt, Enter to run. 'help' for keys, 'exit' to leave.\n\n`);

  async function execute(line, ctx) {
    const cmd = parseCommand(line);
    switch (cmd.kind) {
      case 'empty': return;
      case 'builtin':
        if (cmd.name === 'exit')    { ctx.stop(); return; }
        if (cmd.name === 'help')    { printHelp(write); return; }
        if (cmd.name === 'clear')   { console.clear(); return; }
        if (cmd.name === 'refresh') {
          await refreshLive();
          catalog = expandCatalog(baseCatalog(), sessions, graphs);
          write(serverUp
            ? `refreshed: ${sessions.length} sessions, ${graphs.length} graphs\n`
            : `server not responding on ${host}:${port}\n`);
          return;
        }
        return;
      case 'http': {
        if (/:(tabId|siteVersion)\b/.test(cmd.path)) {
          write(`\x1b[33mPath still contains a placeholder (${cmd.path}) — pick a concrete candidate or fill in an id.\x1b[0m\n`);
          return;
        }
        appendHistory(line.trim());
        try {
          const res = await requestJson(addr, cmd.method, cmd.path, cmd.body);
          formatResult(res, write);
        } catch (e) {
          write(`\x1b[31mRequest failed: ${e.message}\x1b[0m` +
            (e.code === 'ECONNREFUSED' ? ' — is the server running? (start with: whk)' : '') + '\n');
        }
        return;
      }
      default:
        write(`\x1b[33mNot a command. Use 'GET <path>' / 'POST <path> [json]', or 'help'.\x1b[0m\n`);
    }
  }

  // ── Non-TTY fallback: plain line REPL (pipes / CI / weird terminals) ────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });
    let stopped = false;
    const ctx = { stop: () => { stopped = true; } };

    // Manual queue instead of `for await (... of rl)`: piped stdin hits EOF
    // while a command is still awaiting its HTTP response, and the readline
    // async iterator then throws ERR_USE_AFTER_CLOSE and drops buffered lines.
    const queue = [];
    let ended = false;
    let wake = null;
    rl.on('line',  (l) => { queue.push(l); if (wake) { const w = wake; wake = null; w(); } });
    rl.on('close', ()  => { ended = true;  if (wake) { const w = wake; wake = null; w(); } });

    rl.prompt();
    for (;;) {
      while (queue.length) {
        await execute(queue.shift(), ctx);
        if (stopped) { rl.close(); return; }
        if (!ended) rl.prompt(); // prompt() on a closed interface throws
      }
      if (ended) return;
      await new Promise(r => { wake = r; });
    }
  }

  // ── TTY mode: raw keypress loop with live filtering ─────────────────────────
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const history = loadHistory();
  const state = { input: '', sel: 0, navigated: false, histIdx: history.length, busy: false };
  let stopped = false;

  function visible() { return filterCandidates(catalog, state.input).slice(0, MAX_SHOW); }

  function draw() {
    const cands = visible();
    if (state.sel >= cands.length) state.sel = Math.max(0, cands.length - 1);
    const cols = process.stdout.columns || 100;
    let out = '\r\x1b[J' + PROMPT + state.input;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const mark = i === state.sel ? '\x1b[7m' : '';
      const line = `  ${mark}${c.text}\x1b[0m  \x1b[90m${c.desc || ''}\x1b[0m`;
      // Hard-truncate by display length so cursor math stays valid (no wrapping).
      const plain = `  ${c.text}  ${c.desc || ''}`;
      out += '\n' + (plain.length >= cols ? `  ${mark}${c.text.slice(0, cols - 4)}\x1b[0m` : line);
    }
    if (cands.length) out += `\x1b[${cands.length}A`;
    out += '\r' + (PROMPT.length + state.input.length > 0 ? `\x1b[${PROMPT.length + state.input.length}C` : '');
    write(out);
  }

  function clearBelow() { write('\r\x1b[J'); }

  function stop() {
    stopped = true;
    clearBelow();
    write('bye\n');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  const ctx = { stop };

  process.stdin.on('keypress', async (str, key = {}) => {
    if (stopped || state.busy) return;

    if ((key.ctrl && (key.name === 'c' || key.name === 'd'))) { stop(); return; }
    if (key.ctrl && key.name === 'u') { state.input = ''; state.sel = 0; state.navigated = false; draw(); return; }
    if (key.ctrl && key.name === 'l') { console.clear(); draw(); return; }

    if (key.ctrl && key.name === 'p') { // history prev
      if (history.length) {
        state.histIdx = Math.max(0, state.histIdx - 1);
        state.input = history[state.histIdx] || '';
        state.navigated = false; draw();
      }
      return;
    }
    if (key.ctrl && key.name === 'n') { // history next
      if (history.length) {
        state.histIdx = Math.min(history.length, state.histIdx + 1);
        state.input = history[state.histIdx] || '';
        state.navigated = false; draw();
      }
      return;
    }

    if (key.name === 'up')   { state.sel = Math.max(0, state.sel - 1); state.navigated = true; draw(); return; }
    if (key.name === 'down') { state.sel = Math.min(visible().length - 1, state.sel + 1); state.navigated = true; draw(); return; }

    if (key.name === 'tab') {
      const cands = visible();
      if (cands.length) { state.input = cands[state.sel].text; state.sel = 0; state.navigated = false; }
      draw(); return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      const cands = visible();
      // Enter runs the highlighted candidate when the user navigated to it,
      // typed nothing, or the input is just a search term (e.g. 'h' filtering
      // to 'GET /health') — only a line that parses as a runnable command is
      // sent as typed.
      const typedKind = parseCommand(state.input).kind;
      const line = cands.length && (state.navigated || typedKind === 'unknown' || typedKind === 'empty')
        ? cands[state.sel].text
        : state.input;
      clearBelow();
      if (!line.trim()) { draw(); return; }
      write(PROMPT + line + '\n');
      state.busy = true;
      try { await execute(line, ctx); } finally { state.busy = false; }
      if (stopped) return;
      if (line.trim() && history[history.length - 1] !== line.trim()) history.push(line.trim());
      state.histIdx = history.length;
      state.input = ''; state.sel = 0; state.navigated = false;
      draw();
      return;
    }

    if (key.name === 'backspace') {
      state.input = state.input.slice(0, -1);
      state.sel = 0; state.navigated = false;
      draw(); return;
    }

    if (str && !key.ctrl && !key.meta && str >= ' ') {
      state.input += str;
      state.sel = 0; state.navigated = false;
      draw(); return;
    }
  });

  draw();

  // Keep the process alive until stop() pauses stdin.
  await new Promise(resolve => {
    const t = setInterval(() => { if (stopped) { clearInterval(t); resolve(); } }, 100);
  });
}

module.exports = {
  startShell,
  // shared with the full-screen TUI (server/tui/app.js) and tests
  baseCatalog,
  expandCatalog,
  filterCandidates,
  parseCommand,
  requestJson,
  loadHistory,
  appendHistory,
};
