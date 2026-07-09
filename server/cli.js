#!/usr/bin/env node
/**
 * server/cli.js  –  browser-whiskor CLI entry point
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const args = process.argv.slice(2);
const clientArgs = args.filter(a => !a.startsWith('--'));
const command = clientArgs[0]?.toUpperCase();

function listSkills() {
  const skillsDir = path.join(__dirname, '..', 'skills');
  
  try {
    const skillFolders = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    console.log('\n--- Available Skills ---');
    skillFolders.forEach(skill => {
      console.log(`  ${skill}`);
    });
    console.log('\nUsage:');
    console.log('  whk skill <name>        Show skill content');
    console.log('  whk skill <name> ref    Show skill reference.md');
    console.log('  whk skill <name> 10-20  Show lines 10 to 20');
    console.log('  whk skill <name> 10+5   Show 5 lines starting from line 10');
    console.log('  whk skill <name> A-     Show from line A to end');
    console.log('  whk skill <name> ...A   Show section containing A');
  } catch (err) {
    process.stderr.write('\x1b[31m[whk] Error reading skills directory:\x1b[0m\n');
    process.stderr.write('      ' + err.message + '\n');
    process.exit(1);
  }
}

function showSkill(skillName, option) {
  if (!skillName) {
    process.stderr.write('\x1b[31m[whk] Skill name required.\x1b[0m\n');
    process.stderr.write('Usage: whk skill <name> [ref|lines]\n');
    process.exit(1);
  }
  
  const skillDir = path.join(__dirname, '..', 'skills', skillName);
  
  try {
    // Check if skill exists
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      process.stderr.write('\x1b[31m[whk] Skill not found: ' + skillName + '\x1b[0m\n');
      process.exit(1);
    }
    
    // Show reference.md if 'ref' option is specified
    if (option === 'ref') {
      const refPath = path.join(skillDir, 'reference.md');
      if (fs.existsSync(refPath)) {
        console.log(fs.readFileSync(refPath, 'utf8'));
      } else {
        process.stderr.write('\x1b[31m[whk] No reference.md found for skill: ' + skillName + '\x1b[0m\n');
        process.exit(1);
      }
      return;
    }
    
    // Show SKILL.md by default
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      process.stderr.write('\x1b[31m[whk] No SKILL.md found for skill: ' + skillName + '\x1b[0m\n');
      process.exit(1);
    }
    
    const content = fs.readFileSync(skillPath, 'utf8');
    const lines = content.split('\n');
    
    // Handle line range options
    if (option) {
      const rangeMatch = option.match(/^(\d+)-(\d+)$/);
      const plusMatch = option.match(/^(\d+)\+(\d+)$/);
      const fromMatch = option.match(/^(\d+)-$/);
      const searchMatch = option.match(/^\.\.\.(.+)$/);
      
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        if (start > 0 && end >= start && end <= lines.length) {
          console.log(lines.slice(start - 1, end).join('\n'));
          return;
        }
      } else if (plusMatch) {
        const start = parseInt(plusMatch[1]);
        const count = parseInt(plusMatch[2]);
        if (start > 0 && start <= lines.length) {
          console.log(lines.slice(start - 1, start - 1 + count).join('\n'));
          return;
        }
      } else if (fromMatch) {
        const start = parseInt(fromMatch[1]);
        if (start > 0 && start <= lines.length) {
          console.log(lines.slice(start - 1).join('\n'));
          return;
        }
      } else if (searchMatch) {
        const searchTerm = searchMatch[1];
        const matchingLines = lines.filter(line => line.includes(searchTerm));
        if (matchingLines.length > 0) {
          console.log(matchingLines.join('\n'));
        } else {
          process.stderr.write('\x1b[31m[whk] No lines found containing: ' + searchTerm + '\x1b[0m\n');
        }
        return;
      }
    }
    
    // Show entire file if no specific option
    console.log(content);
  } catch (err) {
    process.stderr.write('\x1b[31m[whk] Error reading skill: ' + skillName + '\x1b[0m\n');
    process.stderr.write('      ' + err.message + '\n');
    process.exit(1);
  }
}

function printHelp(topic) {
  const version = require('../package.json').version;
  const logo = `
   /\\_/\\  
  ( o.o )  browser-whiskor v${version}
   > ^ <   Agent-grade browser instrumentation
`;

  if (!topic) {
    console.log(logo);
    console.log(`Usage: whk <command> [options]

Core Commands:
  (no command)        Same as 'restart' — refresh extension files, replace any
                      running server with a fresh one (plain start when none runs)
  server              Start the whiskor HTTP/WebSocket server (plain; port must be free)
  mcp                 Start the whiskor server in MCP stdio mode (JSON-RPC)
  setup               Install/refresh the browser extension into ~/.whiskor, then
                      start the server (or hot-reload the extension if one is running)
  stop                Gracefully stop the running server (flushes buffers, exit 0)
  restart             Refresh extension files → reload extension → stop → start fresh
  where               Show resolved paths (this CLI, managed dir) + the live server
  shell               Interactive HTTP API shell — type to search commands,
                      arrows to pick, Tab to adopt, Enter to run (alias: tui)

HTTP API Client Commands:
  GET <path>          Send a GET request to the local whiskor server
  POST <path> [body]  Send a POST request. Body: inline JSON, --file <path>, or '-' (stdin)
  DELETE <path>       Send a DELETE request

Help Commands:
  help server         Show help for server and MCP options
  help api            Show detailed API endpoints and payloads
  help mcp-tools      Show MCP tools and categories
  help scripts        Show available npm scripts

Skill Commands:
  skills               List bundled skills (browser-whiskor-http)
  skill <name>         Show skill content (e.g., whk skill browser-whiskor-http)
  skill <name> ref     Show skill reference.md
  skill <name> 10-20   Show lines 10 to 20
  skill <name> 10+5    Show 5 lines starting from line 10
  skill <name> A-      Show from line A to end
  skill <name> ...A    Show section containing A

Global Options:
  --verbose           Enable verbose logging
  --mock              Inject mock browser data
  --static-tools      Bypass dynamic tool manager (for static MCP clients)
  --help, -h          Show help message

Examples:
  whk server --verbose
  whk GET /health
  whk POST /api/collect '{"tabId":123}'
  whk POST /api/action --file body.json   (shell-quoting-proof: body from a file)
  Get-Content body.json -Raw | whk POST /api/action -   (or from stdin)
`);
    return;
  }

  topic = topic.toLowerCase();
  if (topic === 'shell' || topic === 'tui') {
    console.log(`\n--- Shell Help ---`);
    console.log(`Usage: whk shell [--classic]`);
    console.log(`\nFull-screen interactive HTTP API shell (zero-dependency TUI):`);
    console.log(`scrollable output pane, candidate popup with incremental search,`);
    console.log(`a real line editor, status bar with live server health.`);
    console.log(`\nLive completion: tabIds and siteVersions are fetched from the running`);
    console.log(`server and expanded into concrete candidates ('refresh' re-fetches).`);
    console.log(`Enter runs the highlighted candidate unless the typed line is itself`);
    console.log(`a runnable command (GET/POST/... or a builtin).`);
    console.log(`\nKeys:`);
    console.log(`  type       filter candidates       ↑/↓       select (or history when line is empty)`);
    console.log(`  Tab        adopt candidate         Enter     run`);
    console.log(`  PgUp/PgDn  scroll output           Ctrl+R    reverse history search`);
    console.log(`  ←/→ Home/End Ctrl+A/E              cursor movement`);
    console.log(`  Ctrl+W/K/U del word / to end / line  Ctrl+L  clear output`);
    console.log(`  → on empty   open folder or field-edit for a command`);
    console.log(`  Esc        hide popup              Ctrl+C    exit`);
    console.log(`\nField-edit (→ on a command with editable values):`);
    console.log(`  Prefills current values, Tab/Enter = next field, last = apply`);
    console.log(`  Ctrl+↑/↓ = ±1, Alt+↑/↓ = ±10 on numeric fields`);
    console.log(`  Esc or Backspace-on-empty = cancel`);
    console.log(`\nShell escape:`);
    console.log(`  !<command>  runs in your local shell (pwsh / $SHELL), output below`);
    console.log(`\nVariants:`);
    console.log(`  --classic        original inline prompt (no full-screen takeover)`);
    console.log(`  piped stdin      plain line REPL, same syntax (scripts/CI)`);
    console.log(`\nHistory persists in ~/.whiskor/shell-history.txt.`);
  } else if (topic === 'stop' || topic === 'restart') {
    console.log(`\n--- Stop / Restart Help ---`);
    console.log(`Usage: whk stop`);
    console.log(`       whk restart [--no-sync] [server options]`);
    console.log(`\nwhk stop:`);
    console.log(`  Asks the running server to shut down gracefully (POST /api/shutdown).`);
    console.log(`  Buffers are flushed and the exit code is 0, so a supervisor stops too.`);
    console.log(`\nwhk restart (cross-platform sibling of scripts/restart.ps1):`);
    console.log(`  1. Refreshes the managed extension files in ~/.whiskor (skip: --no-sync)`);
    console.log(`  2. Asks the connected extension to reload from the refreshed files`);
    console.log(`  3. Stops the running server (if any), then starts a fresh one`);
    console.log(`     (other --flags pass through to the server, e.g. --verbose)`);
    console.log(`\nBare 'whk' (no command) runs this same restart flow.`);
  } else if (topic === 'setup') {
    console.log(`\n--- Setup Help ---`);
    console.log(`Usage: whk setup [--no-start] [server options]`);
    console.log(`\nFirst run:`);
    console.log(`  Copies the bundled extension(s) into the managed directory (~/.whiskor/)`);
    console.log(`  and prints the one-time "load unpacked" instructions for your browser.`);
    console.log(`\nEvery run after that (acts like start.ps1 / restart):`);
    console.log(`  1. Refreshes the managed extension files in place`);
    console.log(`  2. Server not running  → starts it (supervised when available)`);
    console.log(`     Server running      → asks the connected extension to reload itself`);
    console.log(`\nOptions:`);
    console.log(`  --no-start          Sync the extension files only; do not start anything.`);
    console.log(`  (other --flags pass through to the server, e.g. --verbose)`);
    console.log(`\nNotes:`);
    console.log(`  The managed path stays local — it is never sent over HTTP/MCP.`);
    console.log(`  Layouts without bundled extension sources skip the install step.`);
  } else if (topic === 'server' || topic === 'mcp') {
    console.log(`\n--- Server & MCP Mode Help ---`);
    console.log(`Usage: whk server [options]`);
    console.log(`Usage: whk mcp    [options]`);
    console.log(`\nStarts the whiskor backend process.`);
    console.log(`\nPorts:`);
    console.log(`  7891  WebSocket (browser extension connection)`);
    console.log(`  7892  HTTP API  (REST API, Dashboard)`);
    console.log(`\nOptions:`);
    console.log(`  --mcp               Run as MCP stdio server. Disables HTTP server if not already running.`);
    console.log(`  --verbose           Detailed WebSocket logging.`);
    console.log(`  --mock              Inject mock data on startup.`);
    console.log(`  --static-tools      Make all MCP tools permanently visible without dynamic loading.`);
  } else if (topic === 'api' || topic === 'get' || topic === 'post') {
    console.log(`\n--- HTTP API Client Help ---`);
    console.log(`Usage: whk [METHOD] [PATH] [JSON_BODY]`);
    console.log(`\nCommon GET Endpoints:`);
    console.log(`  /health                               Check server status (identity, extensions, secretGuard)`);
    console.log(`  /api/config                           Get global config`);
    console.log(`  /api/sessions                         List active browser sessions (?q=&sort=&page=)`);
    console.log(`  /api/sessions/:id                     Get session data for a tab`);
    console.log(`  /api/search?q=<term>                  Cross-session text search`);
    console.log(`  /api/graphs                           Get state graphs`);
    console.log(`  /api/graphs/:siteVersion/states       List nodes of one state graph`);
    console.log(`  /api/sessions/:id/states              State nodes seen by a session`);
    console.log(`  /api/sessions/:id/map                 ASCII state-graph visualization`);
    console.log(`  /api/sources/:id                      List captured source files`);
    console.log(`  /api/sources/:id/zip                  Download sources as a folder ZIP`);
    console.log(`  /api/ocr                              OCR engine availability`);
    console.log(`  /api/logs?limit=N                     Server log ring buffer`);
    console.log(`  /export                               Download session cache as ZIP (?tabId= to scope)`);
    console.log(`  /                                     Dashboard`);
    console.log(`\nCommon POST Endpoints:`);
    console.log(`  /api/collect                          Trigger data collection (Body: {"tabId": 123})`);
    console.log(`  /api/screenshot                       Capture screenshot (Body: {"tabId": 123})`);
    console.log(`  /api/packed-som                       Capture packed SoM (Body: {"tabId": 123})`);
    console.log(`  /api/element-thumbnail                Crop element (Body: {"tabId": 1, "selector": "..."})`);
    console.log(`  /api/ocr                              OCR text from pixels (Body: {"tabId": 1, "selector"?, "lang"?})`);
    console.log(`  /api/source/capture                   Capture page sources via DevTools (Body: {"tabId": 1})`);
    console.log(`  /api/source/upload                    Upload project source (files or base64 zip)`);
    console.log(`  /api/source/context                   Query uploaded source slices`);
    console.log(`  /api/action                           Execute action (Body: {"tabId": 1, "action": {"type":"..."}})`);
    console.log(`  /api/embed                            Embed texts (Body: {"texts": ["hello"]})`);
    console.log(`  /api/extension/reload                 Ask connected extension(s) to self-reload`);
    console.log(`  /api/shutdown                         Graceful stop (flushes → exit 0)`);
    console.log(`\nExamples:`);
    console.log(`  whk GET /api/sessions`);
    console.log(`  whk POST /api/action '{"tabId": 123, "action": {"type": "trigger_explorer", "active": true}}'`);
  } else if (topic === 'mcp-tools' || topic === 'tools' || topic === 'mcp-tool') {
    console.log(`\n--- MCP Tools & Architecture Help ---`);
    console.log(`Whiskor exposes MCP tools across several categories:`);
    console.log(`\nCategories:`);
    console.log(`  read         Read DOM, state, network, console, text-coords, config`);
    console.log(`  write        Execute actions (click, type, scroll, navigate, execute_js)`);
    console.log(`  tabs         List and switch browser tabs`);
    console.log(`  capture      Take screenshots, Packed SoM, Element thumbnails`);
    console.log(`  control      Trigger explorer mode, manage collection, load/unload profiles`);
    console.log(`  intelligence Causal chains, source mapping, OCR text from pixels (ocr_region)`);
    console.log(`  source       Upload local source code and query context`);
    console.log(`  replay       Replay recorded sessions`);
    console.log(`\nTo view active tools for a tab:`);
    console.log(`  whk GET /api/sessions/:tabId/tools`);
  } else if (topic === 'scripts' || topic === 'npm') {
    console.log(`\n--- npm Scripts Help ---`);
    console.log(`Available via 'npm run <script>':`);
    console.log(`\nExecution:`);
    console.log(`  start             Start with supervisor (auto-restart)`);
    console.log(`  start:raw         Start without supervisor`);
    console.log(`  mcp               Start in MCP stdio mode`);
    console.log(`  stop / restart    Manage background server (PowerShell)`);
    console.log(`\nTesting:`);
    console.log(`  test              Run unit, integration, and stress tests`);
    console.log(`  test:e2e          Run Playwright tests`);
    console.log(`  test:coverage     Run tests with coverage`);
    console.log(`\nUtils:`);
    console.log(`  download-model    Pre-download MiniLM embedding model`);
    console.log(`  sync-version      Auto-fix version inconsistencies`);
  } else if (topic === 'skills' || topic === 'skill') {
    console.log(`\n--- Skills Help ---`);
    console.log(`Usage: whk skills`);
    console.log(`       whk skill <name> [ref|lines]`);
    console.log(`\nCommands:`);
    console.log(`  whk skills                          List all available skills`);
    console.log(`  whk skill <name>                    Show skill content (SKILL.md)`);
    console.log(`  whk skill <name> ref               Show skill reference.md`);
    console.log(`  whk skill <name> 10-20             Show lines 10 to 20`);
    console.log(`  whk skill <name> 10+5              Show 5 lines starting from line 10`);
    console.log(`  whk skill <name> A-                Show from line A to end`);
    console.log(`  whk skill <name> ...A              Show section containing A`);
    console.log(`\nExamples:`);
    console.log(`  whk skills`);
    console.log(`  whk skill browser-whiskor-http`);
    console.log(`  whk skill browser-whiskor-http ref`);
    console.log(`  whk skill browser-whiskor-http 1-20`);
    console.log(`  whk skill browser-whiskor-http ...GET`);
  } else {
    console.log(`Unknown help topic: ${topic}`);
    console.log(`Try 'whk help' to see all options.`);
  }
}

if (args.includes('--help') || args.includes('-h') || command === 'HELP') {
  printHelp(clientArgs[1] || (command === 'HELP' ? null : command));
  process.exit(0);
}

// Handle skills commands
if (command === 'SKILLS') {
  listSkills();
  process.exit(0);
}

if (command === 'SKILL') {
  showSkill(clientArgs[1], clientArgs[2]);
  process.exit(0);
}

// ── whk setup ─────────────────────────────────────────────────────────────────
// First run: install the bundled extension(s) into the managed directory
// (~/.whiskor/) and print load instructions. Every run after that behaves like
// start.ps1: refresh the managed files, then either start the server or — if
// one is already running — ask it to reload the connected extension(s).
if (command === 'SETUP') {
  runSetup().catch((err) => {
    process.stderr.write('\x1b[31m[whk] setup failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
  return; // async — keep the process alive
}

// ── whk stop / whk restart ────────────────────────────────────────────────────
// Cross-platform siblings of scripts/stop.ps1 / scripts/restart.ps1, built on
// POST /api/shutdown (graceful: flush + clean exit 0, so a supervisor stops too).
if (command === 'STOP') {
  runStop().catch((err) => {
    process.stderr.write('\x1b[31m[whk] stop failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
  return;
}

if (command === 'RESTART') {
  runRestart().catch((err) => {
    process.stderr.write('\x1b[31m[whk] restart failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
  return;
}

// ── whk where ─────────────────────────────────────────────────────────────────
// Show the REAL, resolved paths and the live server — not assumptions. Answers
// "which whiskor is this / where is it installed / what's actually running?".
// Everything is read locally (filesystem + /health of the local server); no new
// path is exposed over HTTP/MCP (the managed dir stays a local-only concept).
if (command === 'WHERE') {
  runWhere().catch((err) => {
    process.stderr.write('\x1b[31m[whk] where failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
  return;
}

// ── whk dev ───────────────────────────────────────────────────────────────────
// Operator control of dev-exec mode (docs/vision/whiskor-for-dev/dev-exec.md).
// Activation is intentionally operator-only — there is no MCP tool and no
// set_config path (I-2). Subcommands: on / off / status / exec.
if (command === 'DEV') {
  runDev(clientArgs[1]).catch((err) => {
    process.stderr.write('\x1b[31m[whk] dev failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
  return;
}

// ── whk shell ─────────────────────────────────────────────────────────────────
// Interactive HTTP API shell for humans. Default on a TTY: the full-screen TUI
// (server/tui/app.js — scrollback pane, real line editor, status bar, Ctrl+R).
// `--classic` keeps the original inline prompt (server/cli-shell.js); piped
// stdin always gets the plain line REPL.
if (command === 'SHELL' || command === 'TUI') {
  const { host, port } = _serverAddr();
  const useTui = !args.includes('--classic') && process.stdin.isTTY && process.stdout.isTTY;
  const onErr = (err) => {
    process.stderr.write('\x1b[31m[whk] shell failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  };
  if (useTui) {
    require('./tui/app').startTui({ host, port }).then(() => process.exit(0)).catch(onErr);
  } else {
    require('./cli-shell').startShell({ host, port }).then(() => process.exit(0)).catch(onErr);
  }
  return;
}

async function runSetup() {
  const { syncExtensions } = require('./extension-installer');
  const packageRoot = path.join(__dirname, '..');
  const noStart = args.includes('--no-start');
  const serverFlags = args.filter(a => a.startsWith('--') && a !== '--no-start');

  // 1. Sync bundled extension sources → managed directory
  const { managedRoot, results } = syncExtensions(packageRoot);
  const installed = results.filter(r => !r.skipped);
  const firstRuns = installed.filter(r => r.firstRun);

  console.log('\n--- Extension install (managed directory) ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.label.padEnd(20)} skipped (${r.reason})`);
    } else {
      console.log(`  ${r.label.padEnd(20)} v${r.version}  →  ${r.dest}${r.firstRun ? '  [NEW]' : ''}`);
    }
  }
  if (installed.length === 0) {
    console.log('\n  No extension sources bundled in this layout — nothing to install.');
  }
  if (firstRuns.length > 0) {
    console.log('\n--- One-time browser step ---');
    for (const r of firstRuns) {
      if (r.browser === 'chrome') {
        console.log(`  Chrome/Edge: chrome://extensions → Developer mode ON → "Load unpacked" →`);
        console.log(`               ${r.dest}`);
      } else {
        console.log(`  Firefox:     about:debugging → This Firefox → "Load Temporary Add-on" →`);
        console.log(`               ${path.join(r.dest, 'manifest.json')}`);
      }
    }
    console.log('  (Load it from this managed path — future `whk setup` runs update it in place.)');
  }

  if (noStart) {
    console.log('\n(--no-start: files synced, not starting the server)');
    return;
  }

  // 2. Server already running? → just ask it to reload the extension(s).
  const { host, port } = _serverAddr();
  const running = await _isRunning(host, port);

  if (running) {
    try {
      const res = await _httpJson('POST', host, port, '/api/extension/reload');
      console.log(`\nServer already running on ${host}:${port} — extension reload requested` +
        (typeof res?.sent === 'number' ? ` (${res.sent} connected)` : '') + '.');
      if ((res?.sent ?? 0) === 0) {
        console.log('No extension is connected yet — reload it manually in the browser once.');
      }
    } catch (e) {
      console.log(`\nServer already running on ${host}:${port}, but reload request failed: ${e.message}`);
      console.log('Reload the extension manually in the browser, or restart the server.');
    }
    return;
  }

  // 3. No server yet → start one (supervised when available, like start.ps1).
  _startServerForeground(packageRoot, serverFlags);
}

// Read a flag value from argv: --tab 123 / --tab=123. Returns undefined if absent.
function _flagValue(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}

// Parse a duration like "4h" / "30m" / "90s" / "1500ms" / bare ms into milliseconds.
function _parseDuration(s) {
  if (s == null) return undefined;
  const m = String(s).trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  switch ((m[2] || 'ms').toLowerCase()) {
    case 'h': return n * 3600000;
    case 'm': return n * 60000;
    case 's': return n * 1000;
    default:  return n;
  }
}

async function runDev(sub) {
  const { host, port } = _serverAddr();
  if (!(await _isRunning(host, port))) {
    console.log(`No whiskor server responding on ${host}:${port}. Start one first (whk server / whk).`);
    process.exit(1);
  }
  const action = (sub || 'status').toLowerCase();

  if (action === 'status') {
    const s = await _httpJson('GET', host, port, '/api/dev/status');
    if (s.active) {
      const mins = Math.round((s.remainingMs || 0) / 60000);
      console.log(`dev mode: \x1b[32mACTIVE\x1b[0m — expires in ~${mins}m (roots: ${s.roots}${s.project ? `, project: ${s.project}` : ''})`);
    } else {
      console.log(`dev mode: \x1b[2mOFF\x1b[0m${s.policyEnabled === false ? ' (policy disabled — set dev.exec.enabled=true in config.local.json)' : ''}`);
    }
    return;
  }

  if (action === 'on') {
    const ttlMs = _parseDuration(_flagValue('ttl'));
    const project = _flagValue('project');
    const r = await _httpJson('POST', host, port, '/api/dev/on', { ttlMs, project });
    if (r.ok) {
      const mins = Math.round((r.remainingMs || 0) / 60000);
      console.log(`dev mode ON — expires in ~${mins}m. dev tools now visible to agents on this server.`);
      console.log('Turn it off with: whk dev off  (also auto-expires; a server restart always clears it).');
    } else {
      process.stderr.write('\x1b[31m[whk] ' + (r.error || 'activation refused') + '\x1b[0m\n');
      process.exit(1);
    }
    return;
  }

  if (action === 'off') {
    const r = await _httpJson('POST', host, port, '/api/dev/off');
    console.log(r.wasActive ? 'dev mode OFF.' : 'dev mode was already off.');
    return;
  }

  if (action === 'exec') {
    const file = clientArgs[2];
    if (!file) { process.stderr.write('\x1b[31m[whk] usage: whk dev exec <file.js> --tab <id> [--harness]\x1b[0m\n'); process.exit(1); }
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) { process.stderr.write('\x1b[31m[whk] file not found: ' + abs + '\x1b[0m\n'); process.exit(1); }
    const tabId = parseInt(_flagValue('tab'), 10);
    if (!Number.isFinite(tabId)) { process.stderr.write('\x1b[31m[whk] --tab <id> is required\x1b[0m\n'); process.exit(1); }
    const code = fs.readFileSync(abs, 'utf8');
    const mode = args.includes('--harness') ? 'harness' : 'probe';
    // Generous client timeout — the server-side exec can run up to its own
    // timeout (default 10s) plus settle/dispatch overhead.
    const r = await _httpJson('POST', host, port, '/api/dev/exec', { tabId, code, mode, initiator: 'operator' }, 30000);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r && r.ok ? 0 : 1);
  }

  process.stderr.write(`\x1b[31m[whk] unknown dev subcommand: ${action}\x1b[0m\n`);
  process.stderr.write('      usage: whk dev on [--ttl 4h] [--project <path>] | off | status | exec <file> --tab <id> [--harness]\n');
  process.exit(1);
}

async function runStop() {
  const { host, port } = _serverAddr();
  if (!(await _isRunning(host, port))) {
    console.log(`No whiskor server responding on ${host}:${port} — nothing to stop.`);
    return;
  }
  try {
    await _httpJson('POST', host, port, '/api/shutdown');
  } catch (e) {
    process.stderr.write('\x1b[31m[whk] Shutdown request failed: ' + e.message + '\x1b[0m\n');
    process.stderr.write('      Older server builds lack /api/shutdown — use npm run stop (scripts/stop.ps1).\n');
    process.exit(1);
  }
  if (await _waitForDown(host, port)) {
    console.log('Server stopped.');
  } else {
    process.stderr.write('\x1b[31m[whk] Shutdown was accepted but the server is still responding — try npm run stop.\x1b[0m\n');
    process.exit(1);
  }
}

async function runRestart() {
  const { syncExtensions } = require('./extension-installer');
  const packageRoot = path.join(__dirname, '..');
  const noSync = args.includes('--no-sync');
  const serverFlags = args.filter(a => a.startsWith('--') && a !== '--no-sync');
  const { host, port } = _serverAddr();

  // 1. Refresh the managed extension files (the restart.ps1 "rebuild" step).
  if (noSync) {
    console.log('(--no-sync: keeping the managed extension files as they are)');
  } else {
    const { results } = syncExtensions(packageRoot);
    const installed = results.filter(r => !r.skipped);
    console.log(installed.length
      ? 'Managed extension files refreshed: ' + installed.map(r => `${r.browser} v${r.version}`).join(', ')
      : '(no bundled extension sources in this layout — skipping the file refresh)');
  }

  // 2. Stop the running server, if any — but first let it tell the extension
  //    to reload from the refreshed files while the WS link still exists.
  if (await _isRunning(host, port)) {
    if (!noSync) {
      try {
        const r = await _httpJson('POST', host, port, '/api/extension/reload', { reason: 'restart' });
        if ((r?.sent ?? 0) > 0) console.log(`Extension reload requested (${r.sent} connected).`);
      } catch (_) {
        // Older build without the endpoint — the version-mismatch auto-reload
        // on the new server covers version bumps; same-version edits need a
        // manual extension reload.
      }
    }
    try {
      await _httpJson('POST', host, port, '/api/shutdown');
    } catch (e) {
      process.stderr.write('\x1b[31m[whk] Could not stop the running server: ' + e.message + '\x1b[0m\n');
      process.stderr.write('      Older server builds lack /api/shutdown — use npm run restart (scripts/restart.ps1).\n');
      process.exit(1);
    }
    if (!(await _waitForDown(host, port))) {
      process.stderr.write('\x1b[31m[whk] Server is still responding after the shutdown request — aborting restart.\x1b[0m\n');
      process.exit(1);
    }
    console.log('Old server stopped.');
    // Brief settle so the OS fully releases the ports before rebinding.
    await new Promise(r => setTimeout(r, 300));
  } else {
    console.log(`No server running on ${host}:${port} — starting fresh.`);
  }

  // 3. Start fresh.
  _startServerForeground(packageRoot, serverFlags);
}

function _serverAddr() {
  const { loadConfig } = require('./config-loader');
  const cfg = loadConfig();
  return { host: cfg.server?.host || '127.0.0.1', port: cfg.server?.httpPort || 7892 };
}

async function runWhere() {
  const { getManagedRoot, readManifestVersion, BROWSER_DIRS } = require('./extension-installer');
  const packageRoot = path.join(__dirname, '..');
  let pkgVersion = '?';
  try { pkgVersion = require(path.join(packageRoot, 'package.json')).version; } catch (_) {}

  const line = (label, value) => console.log(`  ${label.padEnd(18)} ${value}`);

  console.log('\n\x1b[1mbrowser-whiskor — where\x1b[0m');

  // This CLI: the actual file being executed and the package it belongs to.
  console.log('\n\x1b[2mThis CLI\x1b[0m');
  line('entry', process.argv[1] || __filename);
  line('package root', packageRoot);
  line('version', `v${pkgVersion}  (source of truth: package.json)`);
  line('node', `${process.version}  (${process.execPath})`);

  // Managed extension directory — the resolved absolute path (env override or
  // ~/.whiskor), and which browsers are actually staged there, at what version.
  const managedRoot = getManagedRoot();
  console.log('\n\x1b[2mManaged extension dir\x1b[0m' +
    (process.env.WHISKOR_MANAGED_DIR ? ' \x1b[2m(WHISKOR_MANAGED_DIR)\x1b[0m' : ''));
  line('path', managedRoot);
  if (!fs.existsSync(managedRoot)) {
    line('status', 'not created yet — run `whk setup`');
  } else {
    let anyStaged = false;
    for (const b of BROWSER_DIRS || []) {
      const dir = path.join(managedRoot, b.dir);
      if (fs.existsSync(path.join(dir, 'manifest.json'))) {
        anyStaged = true;
        let v = '?'; try { v = readManifestVersion(dir) || '?'; } catch (_) {}
        line(b.label || b.dir, `v${v}  ${dir}`);
      }
    }
    if (!anyStaged) line('status', 'dir exists but no extension staged — run `whk setup`');
  }

  // Running server — actual live values from /health (version, identity, ports),
  // not what config says it *should* be.
  const { host, port } = _serverAddr();
  console.log('\n\x1b[2mRunning server\x1b[0m');
  line('configured addr', `${host}:${port}  (config.json server.host/httpPort)`);
  try {
    const h = await _httpJson('GET', host, port, '/health');
    line('status', '\x1b[32mrunning\x1b[0m');
    if (h.identity) line('identity', `${h.identity.instanceId || '?'}${h.identity.name ? ` (${h.identity.name})` : ''}`);
    if (h.update && h.update.current) {
      line('server version', `v${h.update.current}${h.update.updateAvailable ? ` \x1b[33m(update available: v${h.update.latest})\x1b[0m` : ''}`);
    }
    const exts = Array.isArray(h.extensions) ? h.extensions : [];
    line('extensions', exts.length ? exts.map(e => `${e.browser} v${e.version}`).join(', ') : '(none connected)');
    line('sessions', String(h.sessions ?? '?'));
    if (h.update && h.update.current && h.update.current !== pkgVersion) {
      console.log(`\n  \x1b[33mNote:\x1b[0m the running server is v${h.update.current} but this CLI is v${pkgVersion} — a different install is serving this port.`);
    }
  } catch (_) {
    line('status', '\x1b[2mnot responding — no server on this address\x1b[0m');
  }
  console.log('');
}

function _isRunning(host, port) {
  return _httpJson('GET', host, port, '/health').then(() => true).catch(() => false);
}

async function _waitForDown(host, port, totalMs = 6000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (!(await _isRunning(host, port))) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function _startServerForeground(packageRoot, serverFlags) {
  const supervisorPath = path.join(packageRoot, 'scripts', 'supervisor.js');
  if (fs.existsSync(supervisorPath)) {
    console.log('\nStarting server (supervised — auto-restart on crash). Ctrl+C to stop.\n');
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [supervisorPath, ...serverFlags], {
      cwd: packageRoot, stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    console.log('\nStarting server (raw — no supervisor in this layout). Ctrl+C to stop.\n');
    process.argv = ['node', 'index.js', ...serverFlags];
    require('./index.js');
  }
}

function _httpJson(method, hostname, port, pathname, body = null, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: pathname, method, timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

if (HTTP_METHODS.has(command)) {
  const { loadConfig } = require('./config-loader');
  const _cliCfg = loadConfig();
  const _port   = _cliCfg.server?.httpPort || 7892;
  const _host   = _cliCfg.server?.host     || '127.0.0.1';
  const pathname = clientArgs[1] || '/';

  // Body sources: `--file <path>` reads the body from a file, a lone `-` reads
  // it from stdin, anything else is the literal inline argument. File/stdin
  // exist because shell quoting mangles inline JSON (PowerShell especially —
  // any execute_js body with quotes/backslashes dies in transit); a file or a
  // pipe carries the bytes untouched.
  // NOTE: --file must be read from the RAW args — clientArgs has every --flag
  // filtered out at the top of this file, which also leaves the filename value
  // behind as a stray positional (never treat it as an inline body).
  const _resolveBody = async () => {
    const fi = args.indexOf('--file');
    if (fi >= 0) {
      const fp = args[fi + 1];
      if (!fp || fp.startsWith('--')) {
        process.stderr.write('\x1b[31m[whk] --file requires a path (whk POST /api/action --file body.json)\x1b[0m\n');
        process.exit(1);
      }
      try { return require('fs').readFileSync(fp, 'utf8'); }
      catch (e) {
        process.stderr.write('\x1b[31m[whk] Cannot read body file: ' + e.message + '\x1b[0m\n');
        process.exit(1);
      }
    }
    const rest = clientArgs.slice(2);
    if (rest[0] === '-') {
      let data = '';
      for await (const chunk of process.stdin) data += chunk;
      return data;
    }
    return rest[0] || null;
  };

  _runHttpCommand();
  async function _runHttpCommand() {
  let bodyArg = await _resolveBody();
  if (bodyArg != null && bodyArg.trim() === '') bodyArg = null;
  // Validate JSON BEFORE sending: quoting damage should fail here with a usable
  // hint, not as a confusing server-side parse error two hops later.
  if (bodyArg) {
    try { JSON.parse(bodyArg); }
    catch (e) {
      process.stderr.write('\x1b[31m[whk] Body is not valid JSON: ' + e.message + '\x1b[0m\n');
      process.stderr.write('      Received: ' + bodyArg.slice(0, 120).replace(/\n/g, '\\n') + (bodyArg.length > 120 ? '…' : '') + '\n');
      process.stderr.write('      Shell quoting likely mangled it. Write the JSON to a file and use:\n');
      process.stderr.write('        whk ' + command + ' ' + pathname + ' --file body.json\n');
      process.stderr.write('      or pipe it:  Get-Content body.json -Raw | whk ' + command + ' ' + pathname + ' -\n');
      process.exit(1);
    }
  }

  const req = http.request(
    { hostname: _host, port: _port, path: pathname, method: command,
      headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          process.stderr.write('\x1b[31m[whk] HTTP Error ' + res.statusCode + '\x1b[0m\n');
          if (res.statusCode === 404) {
            process.stderr.write('      Hint: The requested endpoint was not found.\n');
          } else if (res.statusCode === 500) {
            process.stderr.write('      Hint: An internal server error occurred.\n');
          }
        }
        try { process.stdout.write(JSON.stringify(JSON.parse(data), null, 2) + '\n'); }
        catch { process.stdout.write(data + '\n'); }
        process.exit(res.statusCode >= 400 ? 1 : 0);
      });
    }
  );
  req.on('error', (err) => {
    process.stderr.write('\x1b[31m[whk] Cannot connect to whiskor on ' + _host + ':' + _port + '\x1b[0m\n');
    process.stderr.write('      Is the server running? Try: whk server\n');
    process.stderr.write('      Error: ' + err.message + '\n');
    if (err.code === 'ECONNREFUSED') {
      process.stderr.write('      Hint: The server may not be running or the port may be incorrect.\n');
    } else if (err.code === 'ETIMEDOUT') {
      process.stderr.write('      Hint: The connection timed out. The server may be busy.\n');
    }
    process.exit(1);
  });
  if (bodyArg) req.write(bodyArg);
  req.end();
  }
} else if (!command) {
  // Bare `whk` = restart semantics: always end up with a fresh server running
  // the current code (refreshes extension files, stops an old server if one is
  // running). With nothing running it is just a start. Flags pass through.
  runRestart().catch((err) => {
    process.stderr.write('\x1b[31m[whk] restart failed: ' + err.message + '\x1b[0m\n');
    process.exit(1);
  });
} else if (command === 'SERVER' || command === 'MCP') {
  // Plain start — no stop/sync. Fails if the port is already taken.
  const serverArgs = ['node', 'index.js', ...args.filter(a => a.startsWith('--'))];
  // Re-inject --mcp if command was 'mcp'
  if (command === 'MCP' && !serverArgs.includes('--mcp')) {
      serverArgs.push('--mcp');
  }
  process.argv = serverArgs;
  require('./index.js');
} else {
  // A typo must not silently start a server in the foreground.
  process.stderr.write('\x1b[31m[whk] Unknown command: ' + clientArgs[0] + '\x1b[0m\n');
  process.stderr.write("      Try 'whk help' to see all commands.\n");
  process.exit(1);
}
