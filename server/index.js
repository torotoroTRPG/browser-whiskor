/**
 * server/index.js  –  browser-whiskor v3
 *
 * Ports:
 *   7891  WebSocket  ← extension connects here (SW + dashboard)
 *   7892  HTTP API   ← curl / AI agent / dashboard
 *
 * Usage:
 *   node server/index.js              # normal
 *   node server/index.js --mock       # inject mock data
 *   node server/index.js --verbose    # log every message
 *   node server/index.js --mcp        # force MCP stdio mode
 */
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const cache      = require('./cache-writer');
const mcp        = require('./mcp-server');
const actions    = require('./action-executor');
const screenshots = require('./screenshot-manager');
const stateMachine = require('./state-machine');
const stateNavigator = require('./state-navigator');
const configLog  = require('./config-change-log');
const deltaEngine = require('./delta-engine');
const { loadConfig, loadMcpToolsConfig } = require('./config-loader');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const VERBOSE   = args.includes('--verbose');
const MOCK      = args.includes('--mock');
const MCP_MODE  = args.includes('--mcp');

// ── Load config.json (+ .env overrides) ──────────────────────────────────────
const _cfg = loadConfig();

const WS_PORT   = _cfg.server?.wsPort   || 7891;
const HTTP_PORT = _cfg.server?.httpPort || 7892;
const HOST      = _cfg.server?.host     || '127.0.0.1';

// Security flags — passed into action/mcp modules
const SECURITY = {
  allowExecuteJs:     _cfg.security?.allowExecuteJs     === true,
  allowActions:       _cfg.security?.allowActions       !== false,
  allowScreenshots:   _cfg.security?.allowScreenshots   !== false,
  allowExplorer:      _cfg.security?.allowExplorer      !== false,
  executeJsTimeoutMs: _cfg.security?.executeJsTimeoutMs ?? 15000,
  actionTimeoutMs:    _cfg.security?.actionTimeoutMs    ?? 15000,
  allowedMcpOrigins:  _cfg.security?.allowedMcpOrigins  ?? ['*'],
};

// ── Global config (sent to extension) ────────────────────────────────────────
let globalConfig = {
  mode: 'always_on',
  plugins: _cfg.plugins || {},
  options: {
    textCoords:  { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000, ...(_cfg.textCoords || {}) },
    network:     { captureBody: true, bodyMaxLength: _cfg.collection?.networkBodyMaxBytes ?? 4096, captureTokens: true },
    react:       { maxDepth: 80, maxProps: 30, maxHooks: 25, ...(_cfg.react || {}) },
    console:     { levels: ['log', 'warn', 'error', 'info', 'debug'], maxBuffer: _cfg.collection?.maxConsoleLogs ?? 2000 },
  },
};

// ── Connected sockets ─────────────────────────────────────────────────────────
const swSockets        = new Set();
const dashboardSockets = new Set();

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of swSockets) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

function broadcastToDashboard(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of dashboardSockets) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

// Inject broadcast functions into action/screenshot modules
actions.setBroadcast(broadcast);
screenshots.setBroadcast(broadcast);

// ── Config push ───────────────────────────────────────────────────────────────
function pushConfig(patch, source = 'api') {
  // Validate change
  const warnings = configLog.validateChange(patch);

  // Log the change
  configLog.addChange({
    patch,
    source,
    warnings,
  });

  globalConfig = {
    ...globalConfig,
    ...patch,
    options: { ...globalConfig.options, ...(patch?.options || {}) },
    plugins: { ...globalConfig.plugins, ...(patch?.plugins || {}) },
  };
  broadcast({ type: 'SET_CONFIG', config: globalConfig });
  log('info', `[config] mode=${globalConfig.mode}`);

  if (warnings.length > 0) {
    log('warn', `[config] Non-recommended change detected:`, warnings.map(w => w.message).join('; '));
  }

  return { ok: true, warnings };
}

function triggerCollect(tabId, plugins) {
  if (tabId) {
    broadcast({ type: 'MANUAL_COLLECT', tabId, plugins });
  } else {
    broadcast({ type: 'MANUAL_COLLECT', plugins });
  }
  log('info', `[collect] tabId=${tabId || 'all'} plugins=${plugins || 'all'}`);
}

function triggerExplorer(tabId, active, strategy) {
  broadcast({ type: 'EXPLORER_CONTROL', tabId, active, strategy: strategy || 'breadth_first' });
  log('info', `[explorer] ${active ? 'start' : 'stop'} tabId=${tabId} strategy=${strategy}`);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  if (req.url === '/dashboard') {
    dashboardSockets.add(ws);
    ws.send(JSON.stringify({ type: 'INIT', sessions: cache.getSessionList(), config: globalConfig }));
    ws.on('close', () => dashboardSockets.delete(ws));
    ws.on('error', () => dashboardSockets.delete(ws));
    return;
  }

  // Extension SW connection
  swSockets.add(ws);
  log('info', `[ws] Extension connected (${swSockets.size} total)`);
  ws.send(JSON.stringify({ type: 'SET_CONFIG', config: globalConfig }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (VERBOSE) log('info', `[ws←] ${msg.type} tabId=${msg.tabId} size=${raw.length}B`);

    // Route by message type
    switch (msg.type) {

      // Data collection messages → cache
      case 'FRAMEWORK_DETECTION':
      case 'REACT_SNAPSHOT':
      case 'VUE_SNAPSHOT':
      case 'VUE2_SNAPSHOT':
      case 'ANGULAR_SNAPSHOT':
      case 'SVELTE_SNAPSHOT':
      case 'DOM_GENERIC_SNAPSHOT':
      case 'TEXT_COORDS':
      case 'NETWORK_REQUEST':
      case 'NETWORK_RESPONSE':
      case 'UI_CATALOG':
      case 'CSS_ANALYSIS':
      case 'ACCESSIBILITY_TREE':
      case 'STORAGE_SNAPSHOT':
      case 'CONSOLE_LOG':
      case 'PERF_METRICS':
      case 'SOURCE_CATALOG':
      case 'PAGE_NAVIGATED':
        cache.handleMessage(msg);
        broadcastToDashboard(msg);
        break;

      case 'VIEWPORT_UPDATE': {
        cache.handleMessage(msg);
        broadcastToDashboard(msg);
        // Feed viewport change into delta engine
        const payload = msg.payload || {};
        const s = cache.getSessionData(msg.tabId);
        const prevVp = s?.viewport || null;
        deltaEngine.addFrame(msg.tabId, {
          timestamp: Date.now(),
          viewport: {
            from: prevVp,
            to: payload,
          },
          deltas: [],
        });
        break;
      }

      // Beacon delta: feed into delta engine for smart aggregation
      case 'TEXT_COORD_DELTA': {
        broadcastToDashboard(msg);
        // Build frame from delta payload
        const payload = msg.payload || {};
        const frame = {
          timestamp: Date.now(),
          viewport: payload.viewStateOnly ? null : {
            from: payload.prevViewport || null,
            to: payload.viewport || null,
          },
          deltas: payload.deltas || [],
        };
        const smartDelta = deltaEngine.addFrame(msg.tabId, frame);
        // If delta engine flushed, store for MCP access
        if (smartDelta) {
          cache.storeSmartDelta(msg.tabId, smartDelta);
        }
        break;
      }

      // Action result → action-executor resolves pending promise
      case 'ACTION_RESULT':
        actions.handleResult(msg);
        break;

      // Screenshot result → screenshot-manager resolves pending promise
      case 'SCREENSHOT_RESULT':
        screenshots.handleResult(msg);
        break;

      // Explorer: state machine update
      case 'EXPLORER_STATE_UPDATE': {
        const { siteVersion, currentHash, reactHash, domHash, url, title, uiCatalog } = msg.payload || {};
        if (siteVersion && currentHash) {
          // Get React snapshot from cache if available
          const reactSnapshot = cache.readSessionFile(msg.tabId, 'raw/react_snapshot.json');
          stateMachine.addNode(siteVersion, {
            hash: currentHash,
            reactHash: reactHash || null,
            domHash: domHash || currentHash,
            url, title, uiCatalog,
            reactState: reactSnapshot || null,
          });
        }
        // Determine next action for explorer
        if (siteVersion && currentHash && uiCatalog) {
          const candidates = stateMachine.getUnvisitedActions(siteVersion, currentHash, uiCatalog);
          ws.send(JSON.stringify({
            type: 'EXPLORER_NEXT_ACTION',
            tabId: msg.tabId,
            payload: {
              target: candidates[0] || null,
              candidateCount: candidates.length,
              reason: candidates.length > 0
                ? `Unvisited interactive element: "${candidates[0].text}"`
                : 'No unvisited elements found — exploration complete for this state',
            },
          }));
        }
        broadcastToDashboard(msg);
        break;
      }

      // React state transition (was previously swallowed — BUG FIX)
      case 'REACT_TRANSITION': {
        const { from, to, fromReact, toReact, trigger } = msg.payload || {};
        if (msg.siteVersion && from && to) {
          stateMachine.addEdge(msg.siteVersion, {
            from, to,
            action: 'react-update',
            trigger: trigger || null,
          });
        }
        broadcastToDashboard(msg);
        break;
      }

      // State hash report (for navigate_to_state verification)
      case 'STATE_HASH_REPORT': {
        stateNavigator.handleHashReport(msg);
        broadcastToDashboard(msg);
        break;
      }

      // Explorer: edge recorded
      case 'EXPLORER_TRANSITION': {
        const { siteVersion, from, to, action: act, trigger } = msg.payload || {};
        if (siteVersion && from) {
          stateMachine.addEdge(siteVersion, { from, to, action: act, trigger });
        }
        break;
      }

      // SW keepalive ping
      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        break;

      default:
        if (VERBOSE) log('warn', `[ws] Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    swSockets.delete(ws);
    log('info', `[ws] Extension disconnected (${swSockets.size} remaining)`);
  });

  ws.on('error', (e) => {
    swSockets.delete(ws);
    log('warn', `[ws] Socket error: ${e.message}`);
  });
});

log('info', `[ws] Listening on ws://0.0.0.0:${WS_PORT}`);
if (SECURITY.allowExecuteJs) {
  console.warn('[SECURITY] ⚠ allowExecuteJs is ENABLED — execute_js tool can run arbitrary JS in page context');
}
console.warn('[SECURITY] State fingerprint uses FNV-1a 32-bit (base-36, 7 chars). Collisions possible on large graphs — handled via incremental suffix.');

// ── HTTP API ──────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url    = new URL(req.url, `http://0.0.0.0:${HTTP_PORT}`);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  };

  const readBody = () => new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });

  const p = url.pathname;

  // Health
  if (method === 'GET' && p === '/health') {
    return sendJson({ ok: true, wsConnections: swSockets.size, sessions: cache.getSessionList().length, pendingActions: actions.pendingCount() });
  }

  // Config
  if (method === 'GET'  && p === '/api/config')  return sendJson(globalConfig);
  if (method === 'POST' && p === '/api/config')  return readBody().then(b => { pushConfig(b); sendJson({ ok: true, config: globalConfig }); });

  // Plugin on/off
  const pluginM = p.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
  if (method === 'POST' && pluginM) {
    const [, id, act] = pluginM;
    pushConfig({ plugins: { [id]: act === 'enable' } });
    return sendJson({ ok: true, pluginId: id, enabled: act === 'enable' });
  }

  // Sessions
  if (method === 'GET' && p === '/api/sessions') return sendJson(cache.getSessionList());

  const sessionM = p.match(/^\/api\/sessions\/(\d+)$/);
  if (method === 'GET' && sessionM) {
    const d = cache.getSessionData(parseInt(sessionM[1]));
    return d ? sendJson(d) : sendJson({ error: 'Not found' }, 404);
  }

  const fileM = p.match(/^\/api\/sessions\/(\d+)\/(.+)$/);
  if (method === 'GET' && fileM) {
    const tabId = parseInt(fileM[1]);
    const dir   = cache.getSessionDir(tabId);
    if (!dir) return sendJson({ error: 'Session not found' }, 404);
    const full = path.join(dir, fileM[2]);
    if (!fs.existsSync(full)) return sendJson({ error: 'File not found' }, 404);
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(full, 'utf8'));
    } catch { return sendJson({ error: 'Read error' }, 500); }
  }

  // Collect trigger
  if (method === 'POST' && p === '/api/collect') {
    return readBody().then(b => {
      triggerCollect(b.tabId || null, b.plugins || null);
      sendJson({ ok: true });
    });
  }

  // Screenshot
  if (method === 'POST' && p === '/api/screenshot') {
    return readBody().then(async b => {
      try {
        const opts = { marks: b.marks === true };
        const result = await screenshots.capture(b.tabId, opts);
        sendJson(result);
      } catch (e) {
        sendJson({ ok: false, error: e.message }, 500);
      }
    });
  }

  // Action execution
  if (method === 'POST' && p === '/api/action') {
    return readBody().then(async b => {
      try {
        const result = await actions.execute(b.tabId, b.action, b.timeoutMs);
        sendJson(result);
      } catch (e) {
        sendJson({ ok: false, error: e.message }, 500);
      }
    });
  }

  // State graphs
  if (method === 'GET' && p === '/api/graphs') {
    return sendJson(stateMachine.getAllGraphs());
  }

  // Dashboard
  if (method === 'GET' && (p === '/' || p === '/dashboard')) {
    const hp = path.join(__dirname, 'dashboard.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '<h1>browser-whiskor v3</h1>');
  }

  return sendJson({ error: 'Not found', path: p }, 404);
});

httpServer.listen(HTTP_PORT, () => {
  log('info', `[http] Listening on http://0.0.0.0:${HTTP_PORT}`);
  log('info', `[http] Dashboard: http://0.0.0.0:${HTTP_PORT}/`);
  log('info', `[http] Health:    http://0.0.0.0:${HTTP_PORT}/health`);
});

// ── MCP ───────────────────────────────────────────────────────────────────────
const mcpToolsConfig = loadMcpToolsConfig();
mcp.setMcpToolsConfig(mcpToolsConfig);
mcp.setCallbacks(pushConfig, triggerCollect, triggerExplorer);

// Action helper for MCP tools
async function _callAction(tabId, action, timeoutMs) {
  if (!actions.execute) {
    return { ok: false, error: 'No browser connected — action execution requires an active extension WebSocket connection.' };
  }
  try {
    return await actions.execute(tabId, action, timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

mcp.setActionCallbacks(_callAction, screenshots.capture.bind(screenshots));
mcp.setSecurity(SECURITY);
mcp.setConfigLog(configLog);
mcp.setNavigateBroadcast(broadcast);
configLog.setAllowAgentConfig(_cfg.agentControl?.allowAgentConfig !== false);
if (MCP_MODE || !process.stdin.isTTY) mcp.startMcpServer();

// ── Auto-revert non-recommended config changes ────────────────────────────────
const revertReport = configLog.autoRevertIfNeeded(_cfg, pushConfig);
if (revertReport) {
  log('warn', '[config] Auto-reverted changes:', revertReport.message);
  // Push revert report to MCP for agent awareness
  mcp.setStartupWarnings([revertReport.message]);
}

// ── Mock ──────────────────────────────────────────────────────────────────────
if (MOCK) {
  const { injectMockData } = require('./mock-data');
  setTimeout(injectMockData, 500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(level, ...a) {
  const p = level === 'warn' ? '⚠ ' : level === 'error' ? '✗ ' : '';
  console.error(p, ...a);
}

process.on('SIGTERM', () => { wss.close(); httpServer.close(); process.exit(0); });
process.on('SIGINT',  () => { wss.close(); httpServer.close(); process.exit(0); });
