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
const { WhiskorCore } = require('./core');
const { checkAndRepair } = require('./cache-integrity');
const patternRegistry = require('./pattern-registry');
const mcpRegistry = require('./mcp/registry');
const { TimeSeriesCorrelator } = require('./correlator');
const sourceStore = require('./source-store');
const conclusionCache = require('./conclusion-cache');

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

// ── Create core with real modules ─────────────────────────────────────────────

// Intelligence Layer: Correlator
const intelligenceCfg = _cfg.plugins?.intelligence || {};
const correlatorCfg   = intelligenceCfg.correlator || {};
const correlator = new TimeSeriesCorrelator({
  bufferCapacityPerTab: correlatorCfg.bufferCapacityPerTab || 200,
  retentionMs:          correlatorCfg.retentionMs          || 5000,
  confidenceFloor:      correlatorCfg.confidenceFloor      || 0.50,
  maxChainsPerSession:  correlatorCfg.maxChainsPerSession  || 500,
});

const core = new WhiskorCore({
  cache,
  actions,
  screenshots,
  stateMachine,
  stateNavigator,
  deltaEngine,
  configLog,
  correlator,
  sourceStore,
  conclusionCache,
  initialConfig: {
    mode: 'always_on',
    plugins: _cfg.plugins || {},
    options: {
      textCoords:  { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000, ...(_cfg.textCoords || {}) },
      network:     { captureBody: true, bodyMaxLength: _cfg.collection?.networkBodyMaxBytes ?? 4096, captureTokens: true },
      react:       { maxDepth: 80, maxProps: 30, maxHooks: 25, ...(_cfg.react || {}) },
      console:     { levels: ['log', 'warn', 'error', 'info', 'debug'], maxBuffer: _cfg.collection?.maxConsoleLogs ?? 2000 },
    },
  },
});

// Inject broadcast functions into action/screenshot modules
actions.setBroadcast((msg) => core.broadcast(msg));
screenshots.setBroadcast((msg) => core.broadcast(msg));

// Forward core events for logging
core.on('sw:connect', () => log('info', `[ws] Extension connected (${core.swSockets.size} total)`));
core.on('sw:disconnect', () => log('info', `[ws] Extension disconnected (${core.swSockets.size} remaining)`));
core.on('message', (msg) => {
  if (VERBOSE) log('info', `[ws←] ${msg.type} tabId=${msg.tabId}`);
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
let wss;
try {
  wss = new WebSocketServer({ port: WS_PORT, host: HOST });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    log('warn', `[ws] Port ${WS_PORT} already in use — reusing existing server`);
  } else {
    log('error', `[ws] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

if (wss) {
  wss.on('connection', (ws, req) => {
    if (req.url === '/dashboard') {
      core.handleDashboardConnect(ws, cache.getSessionList(), core.globalConfig);
      return;
    }
    core.handleSWConnect(ws, core.globalConfig);
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('warn', `[ws] Port ${WS_PORT} already in use — reusing existing server`);
    } else {
      log('error', `[ws] Server error: ${err.message}`);
    }
  });
}

log('info', `[ws] Listening on ws://${HOST}:${WS_PORT}`);
if (SECURITY.allowExecuteJs) {
  console.warn('[SECURITY] ⚠ allowExecuteJs is ENABLED — execute_js tool can run arbitrary JS in page context');
}
console.warn('[SECURITY] State fingerprint uses FNV-1a 32-bit (base-36, 7 chars). Collisions possible on large graphs — handled via incremental suffix.');

// ── HTTP API ──────────────────────────────────────────────────────────────────
let _firstHttpCall = true;
const httpServer = http.createServer((req, res) => {
  const url    = new URL(req.url, `http://${HOST}:${HTTP_PORT}`);
  const method = req.method;

  // Print UTF-8 warning only on first actual API call (not health-check pings)
  if (_firstHttpCall && !url.pathname.startsWith('/health')) {
    _firstHttpCall = false;
    console.warn('');
    console.warn('================================================================================');
    console.warn('  ⚠  TERMINAL ENCODING WARNING (one-time only)');
    console.warn('  If you call the HTTP API from PowerShell, your terminal MUST use UTF-8.');
    console.warn('  Run this ONCE per shell session:  chcp 65001');
    console.warn('  Otherwise non-ASCII text will appear as garbled mojibake.');
    console.warn('================================================================================');
    console.warn('');
  }

  const origin = req.headers['origin'] || '';
  const serverOrigin = `http://${HOST}:${HTTP_PORT}`;
  const httpAllowedOrigins = SECURITY.allowedMcpOrigins.includes('*')
    ? [serverOrigin]
    : SECURITY.allowedMcpOrigins;
  if (httpAllowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', serverOrigin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'none'); // browser will reject
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  };

  const readBody = () => new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { log('warn', `[http] Failed to parse request body: ${d.slice(0, 200)}`); resolve({}); } });
  });

  const p = url.pathname;

  // Dashboard HTML (GET, no body needed)
  if (method === 'GET' && (p === '/' || p === '/dashboard')) {
    const hp = path.join(__dirname, 'dashboard.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '<h1>browser-whiskor v3</h1>');
  }

  // Collect endpoint — handled early to avoid bodyPromise issues
  if (method === 'POST' && (p === '/api/collect' || p === '/api/gather')) {
    return readBody().then(async b => {
      try {
        core.triggerCollect(b?.tabId || null, b?.plugins || null);
        log('info', `[collect] triggered for tabId=${b?.tabId}`);
        sendJson({ ok: true, collected: true });
      } catch (e) {
        log('error', `[collect] error: ${e.message}`);
        sendJson({ ok: false, error: e.message }, 500);
      }
    });
  }

  // Screenshot endpoint (not in core, needs its own body read)
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

  // GET /api/sessions/:tabId/raw/delta/patterns.json — pattern registry data
  const patternsM = method === 'GET' && p.match(/^\/api\/sessions\/(\d+)\/raw\/delta\/patterns\.json$/);
  if (patternsM) {
    const tabId = parseInt(patternsM[1]);
    try {
      const patterns = patternRegistry.getPatternsForTab(String(tabId));
      return sendJson({ patterns });
    } catch { return sendJson({ patterns: [], note: 'Pattern registry unavailable' }); }
  }

  // GET /api/sessions/:tabId/profiles — tool profile status (via MCP)
  const profilesM = method === 'GET' && p.match(/^\/api\/sessions\/(\d+)\/profiles$/);
  if (profilesM) {
    const tabId = parseInt(profilesM[1]);
    try {
      const status = require('./tool-manager').getProfileStatus ? require('./tool-manager').getProfileStatus(`mcp-${tabId}`) : null;
      return sendJson(status || { note: 'Tool profiles active via MCP session', hint: 'Use MCP tools: load_profile, unload_profile, profile_status' });
    } catch { return sendJson({ note: 'Tool-manager not available' }); }
  }

  // GET /api/sessions/:tabId/tools — search visible MCP tools
  const toolsM = method === 'GET' && p.match(/^\/api\/sessions\/(\d+)\/tools$/);
  if (toolsM) {
    const tabId = parseInt(toolsM[1]);
    try {
      const tm = require('./tool-manager');
      const allTools = mcpRegistry.getAllTools();
      const visible = tm.getVisibleTools ? tm.getVisibleTools(`mcp-${tabId}`, allTools, core.globalConfig) : [];
      return sendJson({ tools: visible, total: allTools.length, visible: visible.length });
    } catch { return sendJson({ tools: [], note: 'Tool discovery unavailable via HTTP' }); }
  }

  // Delegate to core HTTP handler
  const coreReq = { method, url: { pathname: p }, body: null };
  let bodyPromise = Promise.resolve(null);
  if (method === 'POST') {
    bodyPromise = readBody();
  }

  bodyPromise.then(async body => {
    coreReq.body = body;

    // Intercept POST /api/action for server-side action types
    if (method === 'POST' && p === '/api/action') {
      const tabId = body?.tabId;
      const action = body?.action || {};
      let result;

      switch (action.type) {
        case 'trigger_explorer':
          core.triggerExplorer(tabId, action.active, action.strategy);
          result = { ok: true, explorer: action.active ? 'activated' : 'deactivated' };
          break;
        case 'navigate_to_state':
          try {
            result = await stateNavigator.navigate(tabId, action.hash, {
              timeoutMs: action.timeoutMs || 30000,
              verifyEachStep: true,
              allowUrlFallback: true,
            }, (tid, act) => actions.execute(tid, act), () => {});
          } catch (e) { result = { ok: false, error: e.message }; }
          break;
        case 'get_navigation_path':
          try {
            const nav = require('./state-navigator');
            if (action.fromHash) {
              result = nav.getNavigationPath(action.fromHash, action.toHash || action.hash, action.siteVersion);
            } else {
              result = { ok: false, error: 'fromHash required. Use navigate_to_state to navigate from current state.' };
            }
          } catch (e) { result = { ok: false, error: e.message }; }
          break;
        case 'load_profile':
          try {
            const tm = require('./tool-manager');
            tm.loadProfile(`mcp-${tabId}`, action.profile, mcpRegistry.getAllTools(), core.globalConfig);
            result = { ok: true, profile: action.profile };
          } catch (e) { result = { ok: false, error: e.message }; }
          break;
        case 'unload_profile':
          try {
            const tm = require('./tool-manager');
            tm.unloadProfile(`mcp-${tabId}`, action.profile);
            result = { ok: true, profile: action.profile };
          } catch (e) { result = { ok: false, error: e.message }; }
          break;
        case 'capture_element_screenshot':
          try { result = await screenshots.captureElement(tabId, action); }
          catch (e) { result = { ok: false, error: e.message }; }
          break;
        default:
          const coreResult = core.handleHttpRequest(coreReq);
          if (coreResult && typeof coreResult.body?.then === 'function') {
            try { result = await coreResult.body; } catch (e) { result = { ok: false, error: e.message }; }
          } else {
            result = coreResult;
          }
      }

      if (result && result.file) {
        const full = result.file;
        if (!fs.existsSync(full)) return sendJson({ error: 'File not found' }, 404);
        try {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(fs.readFileSync(full, 'utf8'));
        } catch { return sendJson({ error: 'Read error' }, 500); }
      }
      return sendJson(result.body || result, result.status || 200);
    }

    const result = core.handleHttpRequest(coreReq);

    // Handle file serving for session files
    if (result.file) {
      const full = result.file;
      if (!fs.existsSync(full)) return sendJson({ error: 'File not found' }, 404);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(fs.readFileSync(full, 'utf8'));
      } catch { return sendJson({ error: 'Read error' }, 500); }
    }

    sendJson(result.body, result.status);
  }).catch(err => {
    if (!res.headersSent) sendJson({ ok: false, error: err.message }, 500);
  });
});

httpServer.listen(HTTP_PORT, HOST, () => {
  log('info', `[http] Listening on http://${HOST}:${HTTP_PORT}`);
  log('info', `[http] Dashboard: http://${HOST}:${HTTP_PORT}/`);
  log('info', `[http] Health:    http://${HOST}:${HTTP_PORT}/health`);


  // Load existing sessions from disk (non-blocking)
  setImmediate(async () => {
    try {
      await cache.loadSessionsFromDisk();
      log('info', `[cache] Loaded ${cache.getSessionList().length} session(s) from disk`);
    } catch (e) {
      log('warn', `[cache] Failed to load sessions from disk: ${e.message}`);
    }
  });

  // Cache integrity check (non-blocking)
  const cacheRoot = process.env.WHISKOR_CACHE_DIR || path.join(__dirname, '..', 'cache', 'sessions');
  setImmediate(() => {
    try {
      const result = checkAndRepair(cacheRoot, { verbose: true, autoRepair: true });
      if (result && result.healthy) log('info', `[cache] Integrity check OK (${result.sessions} session(s))`);
    } catch (e) {
      log('warn', `[cache] Integrity check skipped: ${e.message}`);
    }
  });
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('warn', `[http] Port ${HTTP_PORT} already in use — reusing existing server`);
  } else {
    log('error', `[http] Server error: ${err.message}`);
    console.error(err);
  }
});

// ── MCP ───────────────────────────────────────────────────────────────────────
const mcpToolsConfig = loadMcpToolsConfig();
mcp.setMcpToolsConfig(mcpToolsConfig);
mcp.setCallbacks(
  (patch, source) => core.pushConfig(patch, source),
  (tabId, plugins) => core.triggerCollect(tabId, plugins),
  (tabId, active, strategy) => core.triggerExplorer(tabId, active, strategy),
);
mcp.setConfig(_cfg);
{
  const toolManager = require('./tool-manager');
  const rawEnvSid = process.env.WHISKOR_MCP_SESSION_ID;
  const envSid = rawEnvSid ? toolManager.sanitizeSessionId(rawEnvSid) : null;
  if (rawEnvSid && !envSid) {
    log('warn', `[mcp] Ignoring WHISKOR_MCP_SESSION_ID="${rawEnvSid}" (must match /^[A-Za-z0-9_.:-]{1,64}$/)`);
  }
  const sid = envSid || `mcp-${Date.now()}`;
  if (envSid) log('info', `[mcp] Using fixed session id from env: ${sid}`);
  mcp.setSessionId(sid);
}
mcp.initToolManager();

// Action helper for MCP tools
async function _callAction(tabId, action, timeoutMs) {
  try {
    return await actions.execute(tabId, action, timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

mcp.setActionCallbacks(_callAction, screenshots.capture.bind(screenshots), screenshots.captureElement.bind(screenshots));
mcp.setSecurity(SECURITY);
mcp.setConfigLog(configLog);
mcp.setNavigateBroadcast((msg) => core.broadcast(msg));
// Intelligence Layer: expose correlator, sourceStore, and cache to MCP tools
mcp.setIntelligenceCallbacks(correlator, sourceStore, cache);
configLog.setAllowAgentConfig(_cfg.agentControl?.allowAgentConfig !== false);

// Start MCP server immediately in MCP mode so client doesn't timeout
if (MCP_MODE || !process.stdin.isTTY) {
  mcp.startMcpServer();
}

// Background startup tasks (model download & cache loading)
(async () => {
  // Pre-download embedding model on first startup
  try {
    const { env } = require('@xenova/transformers');
    const cacheDir = path.resolve(__dirname, '..', '.model-cache');
    env.cacheDir = cacheDir;
    
    // Check if model is already cached
    const modelCached = fs.existsSync(path.join(cacheDir, 'models', 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2'));
    
    if (!modelCached) {
      log('info', '[model] Downloading MiniLM embedding model (first startup, ~50MB)...');
      log('info', '[model] This may take 30-60 seconds depending on your connection.');
      const { pipeline } = require('@xenova/transformers');
      await pipeline('feature-extraction', 'paraphrase-multilingual-MiniLM-L12-v2', { quantized: true });
      log('info', '[model] Model downloaded successfully!');
    } else {
      log('info', '[model] MiniLM embedding model already cached.');
    }
  } catch (e) {
    log('warn', `[model] Failed to download model: ${e.message}`);
    log('warn', '[model] Semantic search will not be available. Run "npm run download-model" manually.');
  }

  try {
    await cache.loadSessionsFromDisk();
    log('info', `[cache] Loaded ${cache.getSessionList().length} session(s) from disk`);
  } catch (e) {
    log('warn', `[cache] Failed to load sessions from disk: ${e.message}`);
  }
})();

// ── Auto-revert non-recommended config changes ────────────────────────────────
const revertReport = configLog.autoRevertIfNeeded(_cfg, (patch) => core.pushConfig(patch));
if (revertReport) {
  log('warn', '[config] Auto-reverted changes:', revertReport.message);
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
  if (core && core.broadcastLog) {
    core.broadcastLog(level, ...a);
  }
}

process.on('SIGTERM', () => { wss.close(); httpServer.close(); process.exit(0); });
process.on('SIGINT',  () => { wss.close(); httpServer.close(); process.exit(0); });
