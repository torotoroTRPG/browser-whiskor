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
const os    = require('os');
const { WebSocketServer } = require('ws');

const cache      = require('./cache-writer');
const mcp        = require('./mcp-server');
const actions    = require('./action-executor');
const screenshots = require('./screenshot-manager');
const stateMachine = require('./state-machine');
const stateNavigator = require('./state-navigator');
const configLog  = require('./config-change-log');
const secretGuardFactory = require('./secret-guard');
const deltaEngine = require('./delta-engine');
const { loadConfig, loadMcpToolsConfig } = require('./config-loader');
const { WhiskorCore } = require('./core');
const { checkAndRepair, cleanupTempFiles } = require('./cache-integrity');
const patternRegistry = require('./pattern-registry');
const mcpRegistry = require('./mcp/registry');
const { TimeSeriesCorrelator } = require('./correlator');
const sourceStore = require('./source-store');
const conclusionCache = require('./conclusion-cache');
const AppRegistry = require('./app-registry');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const VERBOSE   = args.includes('--verbose');
const MOCK      = args.includes('--mock');
const MCP_MODE  = args.includes('--mcp');

// ── Load config.json (+ .env overrides) ──────────────────────────────────────
const _cfg = loadConfig();

// Secret guard: redacts the user's secrets from collected data before the agent,
// cache, or logs can see them. Built once from config; passthrough when disabled.
const secretGuard = secretGuardFactory.createGuard(_cfg.privacy?.secretGuard);

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

// Descriptive instance identity (label, not security) surfaced on /health and MCP
// serverInfo so multiple whiskor servers on different ports/machines are tellable
// apart. instanceId auto-derives to whiskor-<hostname>-<httpPort> when unset —
// unique per host:port, so no shared-default collision. See config.json identity.
const _sanitizeIdentity = (s) => String(s).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64) || 'whiskor';
const IDENTITY = {
  instanceId: _sanitizeIdentity(_cfg.identity?.instanceId || `whiskor-${os.hostname()}-${HTTP_PORT}`),
  name:       _cfg.identity?.name || 'whiskor',
};

// Check if Whiskor server is already running on HTTP_PORT
function checkExistingServer(host, port) {
  return new Promise((resolve) => {
    const options = {
      hostname: host,
      port: port,
      path: '/health',
      method: 'GET',
      timeout: 800,
    };
    const req = http.request(options, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Proxy → worker resilience. When the worker (the heavy process that owns the
// ports + cache) crashes, the supervisor restarts it within a second or two. The
// MCP/stdio process the agent talks to is THIS proxy — a separate, long-lived
// process — so a worker crash never reaches the agent. We just retry the HTTP
// forward across connection-level failures until the worker is back, turning a
// restart into a brief pause instead of a lost instruction.
//
// We only retry CONNECTION errors (the worker is down / restarting). HTTP error
// *responses* mean the worker handled the call, so those are returned as-is.
// A connection refused means the request never reached the worker, so re-sending
// it cannot double-execute an action.
const RETRY = {
  enabled:    _cfg.resilience?.proxyRetry?.enabled    !== false, // default ON in proxy mode
  totalMs:    _cfg.resilience?.proxyRetry?.totalMs    ?? 15000,   // give up after this long
  baseMs:     _cfg.resilience?.proxyRetry?.baseMs     ?? 200,
  maxMs:      _cfg.resilience?.proxyRetry?.maxMs      ?? 1000,
};
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE']);
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function _requestOnce(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: HTTP_PORT,
      path: pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: 'Failed to parse response', raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function requestServer(method, pathname, body = null) {
  const deadline = Date.now() + RETRY.totalMs;
  let attempt = 0;
  let lastErr;
  let warned = false;
  for (;;) {
    try {
      return await _requestOnce(method, pathname, body);
    } catch (err) {
      lastErr = err;
      const retryable = RETRY.enabled && RETRYABLE.has(err.code) && Date.now() < deadline;
      if (!retryable) throw err;
      if (!warned) { warned = true; log('warn', `[proxy] Worker unreachable (${err.code}) — retrying ${method} ${pathname} until it restarts...`); }
      const backoff = Math.min(RETRY.maxMs, RETRY.baseMs * Math.pow(2, attempt++));
      const remaining = deadline - Date.now();
      await _sleep(Math.max(0, Math.min(backoff, remaining)));
    }
  }
}

let core = null;
let wss = null;
let httpServer = null;
let PROXY_MODE = false;
let sourceIndex = null; // uploaded-source index (slice 1); created in non-proxy mode
let sourceCorrelations = null; // runtime→source correlation store (slice 2)
let appRegistry = new AppRegistry({}); // no-op default; replaced when non-proxy

(async () => {
  // Only check for proxy mode if we are in MCP mode or stdin is not a TTY
  if (MCP_MODE || !process.stdin.isTTY) {
    const hasExisting = await checkExistingServer(HOST, HTTP_PORT);
    if (hasExisting) {
      PROXY_MODE = true;
      log('info', `[mcp] Existing Whiskor server detected on ${HOST}:${HTTP_PORT}. Running in PROXY mode.`);
    }
  }

  let correlator = null;

  if (!PROXY_MODE) {
    // ── Create core with real modules ─────────────────────────────────────────────
    // Intelligence Layer: Correlator
    const intelligenceCfg = _cfg.plugins?.intelligence || {};
    const correlatorCfg   = intelligenceCfg.correlator || {};
    correlator = new TimeSeriesCorrelator({
      bufferCapacityPerTab: correlatorCfg.bufferCapacityPerTab || 200,
      retentionMs:          correlatorCfg.retentionMs          || 5000,
      confidenceFloor:      correlatorCfg.confidenceFloor      || 0.50,
      maxChainsPerSession:  correlatorCfg.maxChainsPerSession  || 500,
    });

    appRegistry = new AppRegistry(_cfg.appIsolation || {});
    if (appRegistry.enabled) {
      log('info', '[app-isolation] enabled — multi-app tab isolation is active');
    }

    const somCache = require('./som-cache').createSomCache();
    const somStats = require('./som-stats').createStatsStore();
    const somThumbs = require('./som-thumbnails').createThumbStore();
    // Packed-SoM cache + usage-stats + per-element thumbnails live on the worker
    // (the process that captures and runs actions), so they serve MCP stdio, HTTP,
    // and the proxy forward identically. Wiring them in the MCP layer instead would
    // silently disable them under the proxy (its MCP runs in a separate process).
    // See PACKED_SOM doc.
    screenshots.setSomCache(somCache);
    screenshots.setSomStats(somStats);
    screenshots.setSomThumbs(somThumbs);
    actions.setSomStats(somStats);
    sourceIndex = require('./source-index').createSourceIndex();
    sourceCorrelations = require('./source-correlation').createCorrelations();

    core = new WhiskorCore({
      cache,
      actions,
      screenshots,
      stateMachine,
      stateNavigator,
      deltaEngine,
      configLog,
      secretGuard,
      somCache,
      somThumbs,
      sourceIndex,
      sourceCorrelations,
      correlator,
      sourceStore,
      conclusionCache,
      appRegistry,
      identity: IDENTITY,
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
    actions.setBroadcast((msg) => core.sendToTab(msg));
    screenshots.setBroadcast((msg) => core.sendToTab(msg));

    // Forward core events for logging
    core.on('sw:connect', () => log('info', `[ws] Extension connected (${core.swSockets.size} total)`));
    core.on('sw:disconnect', () => log('info', `[ws] Extension disconnected (${core.swSockets.size} remaining)`));
    core.on('message', (msg) => {
      if (VERBOSE) log('info', `[ws←] ${msg.type} tabId=${msg.tabId}`);
    });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  if (!PROXY_MODE) {
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
        if (req.url === '/dashboard' || req.url.startsWith('/dashboard?')) {
          core.handleDashboardConnect(ws, cache.getSessionList(), core.globalConfig);
          return;
        }

        // Parse appId / token from WS URL query string
        let wsAppId = null;
        try {
          const wsUrl = new URL(req.url, `ws://${HOST}:${WS_PORT}`);
          wsAppId = wsUrl.searchParams.get('appId') || null;
          const wsToken = wsUrl.searchParams.get('token') || '';
          const err = appRegistry.validate(wsAppId, wsToken);
          if (err) {
            log('warn', `[app-isolation] WS rejected: ${err}`);
            ws.close(4001, err);
            return;
          }
        } catch { /* malformed URL — allow with no appId */ }

        core.handleSWConnect(ws, core.globalConfig, wsAppId);
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
  }

  // ── HTTP API ──────────────────────────────────────────────────────────────────
  let _firstHttpCall = true;
  httpServer = http.createServer((req, res) => {
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

    // Export endpoint — download a ZIP of the session cache (the panel "ZIP" button
    // opens this). Optional ?tabId= scopes the export to a single session.
    if (method === 'GET' && p === '/export') {
      try {
        const cacheRoot = process.env.WHISKOR_CACHE_DIR || path.join(__dirname, '..', 'cache', 'sessions');
        const wantTab = url.searchParams.get('tabId');
        const root = wantTab ? path.join(cacheRoot, wantTab) : cacheRoot;
        if (!fs.existsSync(root)) {
          return sendJson({ ok: false, error: wantTab ? `No cached session for tabId=${wantTab}.` : 'No cached sessions to export.' }, 404);
        }

        const { buildZip } = require('./zip-writer');
        const MAX_BYTES = 50 * 1024 * 1024; // guard against runaway archives
        const entries = [];
        let total = 0;
        const walk = (dir, base) => {
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const rel  = base ? `${base}/${name}` : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) { walk(full, rel); continue; }
            total += st.size;
            if (total > MAX_BYTES) throw new Error('Export exceeds 50MB — scope it with ?tabId=<id>.');
            entries.push({ name: rel, data: fs.readFileSync(full) });
          }
        };
        const prefix = wantTab ? `session-${wantTab}` : 'sessions';
        walk(root, prefix);
        if (!entries.length) return sendJson({ ok: false, error: 'Nothing to export (cache is empty).' }, 404);

        const zip = buildZip(entries);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="whiskor-${prefix}-${ts}.zip"`,
          'Content-Length': zip.length,
        });
        return res.end(zip);
      } catch (e) {
        log('error', `[export] ${e.message}`);
        return sendJson({ ok: false, error: e.message }, 500);
      }
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

    if (method === 'POST' && p === '/api/packed-som') {
      return readBody().then(async b => {
        try {
          const opts = { max: b.max, types: b.types };
          const result = await screenshots.capturePackedSom(b.tabId, opts);
          sendJson(result);
        } catch (e) {
          sendJson({ ok: false, error: e.message }, 500);
        }
      });
    }

    // Per-element thumbnail (T2) — cache-backed single-element crop.
    if (method === 'POST' && p === '/api/element-thumbnail') {
      return readBody().then(async b => {
        try {
          const opts = { selector: b.selector, rect: b.rect, padding: b.padding, format: b.format, quality: b.quality, maxPx: b.maxPx };
          const result = await screenshots.captureElementThumbnail(b.tabId, opts);
          sendJson(result);
        } catch (e) {
          sendJson({ ok: false, error: e.message }, 500);
        }
      });
    }

    // Uploaded-source endpoints (source-upload feature, slice 1).
    if (method === 'POST' && p === '/api/source/upload') {
      return readBody().then(b => {
        try {
          if (!sourceIndex) return sendJson({ ok: false, error: 'Source index unavailable.' }, 503);
          const r = sourceIndex.addFiles(b.projectId || 'default', b.files || {});
          sendJson({ ok: true, ...r });
        } catch (e) { sendJson({ ok: false, error: e.message }, 500); }
      });
    }
    if (method === 'POST' && p === '/api/source/context') {
      return readBody().then(b => {
        try {
          if (!sourceIndex) return sendJson({ error: 'Source index unavailable.' }, 503);
          sendJson(require('./source-index').queryContext(sourceIndex, b || {}, sourceCorrelations));
        } catch (e) { sendJson({ error: e.message }, 500); }
      });
    }

    // Embed endpoint (added for Proxy Mode compatibility)
    if (method === 'POST' && p === '/api/embed') {
      return readBody().then(async b => {
        try {
          const embedService = require('./services/embed-service');
          const vectors = await embedService.embedTexts(b.texts);
          sendJson({ ok: true, vectors });
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
    // Resolve caller appId from request headers (for app isolation)
    const httpAppId    = req.headers['x-whiskor-app-id']    || null;
    const httpAppToken = req.headers['x-whiskor-app-token'] || '';
    const httpAuthErr  = appRegistry.validate(httpAppId, httpAppToken);
    if (httpAuthErr) {
      return sendJson({ error: httpAuthErr }, 403);
    }

    const coreReq = { method, url: { pathname: p }, body: null, callerAppId: httpAppId };
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

  if (!PROXY_MODE) {
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
          const swept = cleanupTempFiles(cacheRoot);
          if (swept) log('info', `[cache] Removed ${swept} orphaned temp file(s) from a previous crash`);
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
  }

  // ── MCP ───────────────────────────────────────────────────────────────────────
  const mcpToolsConfig = loadMcpToolsConfig();
  mcp.setMcpToolsConfig(mcpToolsConfig);

  if (PROXY_MODE) {
    // ── Setup Proxy MCP callbacks and Cache ─────────────────────────────────────
    mcp.setCallbacks(
      (patch, source) => requestServer('POST', '/api/config', patch),
      (tabId, plugins) => requestServer('POST', '/api/collect', { tabId, plugins }),
      (tabId, active, strategy) => requestServer('POST', '/api/action', { tabId, action: { type: 'trigger_explorer', active, strategy } }),
    );

    const proxyCache = {
      getSessionList() { return requestServer('GET', '/api/sessions'); },
      getSessionData(tabId) { return requestServer('GET', `/api/sessions/${tabId}`); },
      async readSessionFile(tabId, filename) {
        const res = await requestServer('GET', `/api/sessions/${tabId}/${filename}`);
        // Standalone readSessionFile returns null for a missing file. Match that
        // contract instead of leaking the server's 404 body ({error:'File not found'}),
        // which downstream `if (!raw)` guards would otherwise treat as real data
        // (surfacing a bogus "File not found" from e.g. get_viewport).
        if (res && res.error === 'File not found') return null;
        return res;
      },
      getSmartDelta(tabId) { return requestServer('GET', `/api/sessions/${tabId}/raw/delta/smart.json`); },
      // withFreshness() is synchronous, so it cannot await an HTTP round-trip here.
      // Skip staleness annotation in proxy mode (return null → no _warnings) instead of
      // throwing "cache.freshnessInfo is not a function" on every read tool.
      freshnessInfo() { return null; },
      // In-memory console buffer is not reachable over HTTP; the persisted
      // raw/console/logs.json path is read via readSessionFile instead.
      getConsoleLogs() { return []; }
    };

    const proxyAction = async (tabId, action, timeoutMs) => {
      try {
        return await requestServer('POST', '/api/action', { tabId, action, timeoutMs });
      } catch (e) { return { ok: false, error: e.message }; }
    };

    mcp.setActionCallbacks(
      proxyAction,
      async (tabId, opts) => requestServer('POST', '/api/screenshot', { tabId, ...opts }),
      async (tabId, action) => requestServer('POST', '/api/action', { tabId, action: { type: 'capture_element_screenshot', ...action } }),
      async (tabId, opts) => requestServer('POST', '/api/packed-som', { tabId, ...opts })
    );
    mcp.setElementThumbnail(async (tabId, opts) => requestServer('POST', '/api/element-thumbnail', { tabId, ...opts }));
    mcp.setSourceContext((q) => requestServer('POST', '/api/source/context', q));

    mcp.setSecurity(SECURITY);

    const proxyConfigLog = {
      setAllowAgentConfig() {},
      autoRevertIfNeeded() { return null; }
    };
    mcp.setConfigLog(proxyConfigLog);
    mcp.setNavigateBroadcast(() => {});

    // Expose proxyCache to intelligence callbacks (correlator and sourceStore remain null since calculations are on target server)
    mcp.setIntelligenceCallbacks(null, null, proxyCache);

    // Override local embed-service to avoid local ONNX load, routing through proxy HTTP endpoint instead
    const embedService = require('./services/embed-service');
    embedService.getEmbedStatus = () => 'ready';
    embedService.embedTexts = async (texts) => {
      const res = await requestServer('POST', '/api/embed', { texts });
      if (res.error) throw new Error(res.error);
      return res.vectors;
    };
  } else {
    // ── Setup Standalone MCP callbacks and Cache ────────────────────────────────
    mcp.setCallbacks(
      (patch, source) => core.pushConfig(patch, source),
      (tabId, plugins) => core.triggerCollect(tabId, plugins),
      (tabId, active, strategy) => core.triggerExplorer(tabId, active, strategy),
    );
    mcp.setActionCallbacks(_callAction, screenshots.capture.bind(screenshots), screenshots.captureElement.bind(screenshots), screenshots.capturePackedSom.bind(screenshots));
    mcp.setElementThumbnail(screenshots.captureElementThumbnail.bind(screenshots));
    mcp.setSourceContext((q) => require('./source-index').queryContext(sourceIndex, q, sourceCorrelations));

    // Optional packed-SoM prefetch: pre-capture the packed view shortly after a
    // navigation and warm the cache, so the agent's first capture_packed_som on
    // the new page returns instantly. Off by default (avoids capturing for an
    // agent that never asks). Best-effort; later collection may re-invalidate it.
    // capturePackedSom stores into the worker-side cache itself, so warming it
    // just means calling it (no separate set needed).
    if (_cfg.agentControl?.packedSom?.prefetchOnNavigate === true) {
      core.on('message', (msg) => {
        if (!msg || msg.type !== 'PAGE_NAVIGATED' || !msg.tabId) return;
        const tabId = msg.tabId;
        setTimeout(() => {
          screenshots.capturePackedSom(tabId, {}).catch(() => { /* best-effort prefetch */ });
        }, 1500);
      });
    }

    mcp.setSecurity(SECURITY);
    mcp.setConfigLog(configLog);
    mcp.setSecretGuard(secretGuard);
    mcp.setNavigateBroadcast((msg) => core.broadcast(msg));
    mcp.setIntelligenceCallbacks(correlator, sourceStore, cache);
    configLog.setAllowAgentConfig(_cfg.agentControl?.allowAgentConfig !== false);
  }

  mcp.setConfig(_cfg);
  mcp.setIdentity(IDENTITY);
  log('info', `[identity] instance=${IDENTITY.instanceId} name=${IDENTITY.name}${PROXY_MODE ? ' (proxy)' : ''}`);

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

  // Action helper for standalone mode
  async function _callAction(tabId, action, timeoutMs) {
    try {
      return await actions.execute(tabId, action, timeoutMs);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Start MCP server immediately if in MCP mode
  if (MCP_MODE || !process.stdin.isTTY) {
    mcp.startMcpServer();
  }

  // Background startup tasks (only if NOT in proxy mode)
  if (!PROXY_MODE) {
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

    // ── Auto-revert non-recommended config changes ────────────────────────────────
    const revertReport = configLog.autoRevertIfNeeded(_cfg, (patch) => core.pushConfig(patch));
    if (revertReport) {
      log('warn', '[config] Auto-reverted changes:', revertReport.message);
      mcp.setStartupWarnings([revertReport.message]);
    }
  }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(level, ...a) {
  const p = level === 'warn' ? '⚠ ' : level === 'error' ? '✗ ' : '';
  console.error(p, ...a);
  if (core && core.broadcastLog) {
    core.broadcastLog(level, ...a);
  }
}

// ── Mock ──────────────────────────────────────────────────────────────────────
if (MOCK) {
  const { injectMockData } = require('./mock-data');
  setTimeout(injectMockData, 500);
}

// ── Graceful shutdown & crash safety ───────────────────────────────────────────
// A clean exit (signal) flushes and returns 0. A crash flushes and returns a
// NON-zero code so the supervisor (scripts/supervisor.js) knows to restart. The
// in-memory network/console buffers are flushed synchronously so a restart loses
// as little as possible; atomic writes (cache-writer) guarantee nothing on disk
// is left half-written, and the startup integrity check repairs any dangling refs.
let _shuttingDown = false;
function shutdown(code, reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { if (!PROXY_MODE) { const n = cache.flushAllSync(); log('info', `[shutdown] Flushed ${n} session(s) (${reason})`); } }
  catch (e) { try { log('warn', `[shutdown] Flush failed: ${e.message}`); } catch {} }
  try { if (wss) wss.close(); } catch {}
  try { if (httpServer && httpServer.listening) httpServer.close(); } catch {}
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT',  () => shutdown(0, 'SIGINT'));

process.on('uncaughtException', (err) => {
  try { log('error', `[fatal] Uncaught exception: ${err && err.stack || err}`); } catch {}
  shutdown(1, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  try { log('error', `[fatal] Unhandled rejection: ${reason && reason.stack || reason}`); } catch {}
  shutdown(1, 'unhandledRejection');
});
