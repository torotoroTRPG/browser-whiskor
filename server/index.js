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
const ocrService = require('./services/ocr-service');
const configLog  = require('./config-change-log');
const secretGuardFactory = require('./secret-guard');
const deltaEngine = require('./delta-engine');
const { loadConfig, loadMcpToolsConfig } = require('./config-loader');
const { WhiskorCore } = require('./core');
const { checkAndRepair, cleanupTempFiles, enforceDiskLimit } = require('./cache-integrity');
const patternRegistry = require('./pattern-registry');
const devGate     = require('./dev-gate');
const devIntake   = require('./dev-intake');
const devAudit    = require('./dev-audit');
const devArtifacts = require('./dev-artifacts');
const devVerdict  = require('./dev-verdict');
const { randomUUID } = require('crypto');
const mcpRegistry = require('./mcp/registry');
const { TimeSeriesCorrelator } = require('./correlator');
const sourceStore = require('./source-store');
const conclusionCache = require('./conclusion-cache');
const AppRegistry = require('./app-registry');
const { checkOrigin } = require('./http-origin-guard');

/**
 * Capture a tab (or a cropped region) and run OCR on it. Worker-side helper shared
 * by the MCP ocr_region tool (direct mode) and the HTTP POST /api/ocr route, so
 * both — and the proxy forward to /api/ocr — go through one path.
 *   - selector/rect → crop that element (reuses the element-capture pipeline)
 *   - neither       → OCR the full visible tab (the canvas/WebGL case)
 * PNG is captured (lossless) to give OCR the cleanest input. Never throws.
 */
async function ocrCapture(b = {}) {
  const tabId = b.tabId;
  let cap, usedRect = null;
  try {
    if (b.selector || b.rect) {
      cap = await screenshots.captureElement(tabId, {
        selector: b.selector || undefined,
        rect:     b.rect || undefined,
        padding:  typeof b.padding === 'number' ? b.padding : 4,
        format:   'png',
      });
      usedRect = cap && cap.rect;
    } else {
      cap = await screenshots.capture(tabId, { format: 'png' });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!cap || !cap.ok) {
    return { ok: false, error: (cap && cap.error) || 'capture_failed', ...(cap && cap.tabGone ? { tabGone: true, liveTabs: cap.liveTabs } : {}) };
  }
  const b64 = (cap.dataUrl || '').split(',')[1] || '';
  if (!b64) return { ok: false, error: 'capture_empty' };
  const ocr = await ocrService.recognize(Buffer.from(b64, 'base64'), { lang: b.lang, psm: b.psm });
  if (!ocr.ok) return ocr;
  return { ...ocr, rect: usedRect || null, capturedAt: cap.capturedAt };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const VERBOSE   = args.includes('--verbose');
const MOCK      = args.includes('--mock');
const MCP_MODE  = args.includes('--mcp');
const STATIC_TOOLS_FLAG = args.includes('--static-tools');

// ── Load config.json (+ .env overrides) ──────────────────────────────────────
const _cfg = loadConfig();

// Secret guard: redacts the user's secrets from collected data before the agent,
// cache, or logs can see them. Built once from config; passthrough when disabled.
const secretGuard = secretGuardFactory.createGuard(_cfg.privacy?.secretGuard);

// dev-exec static policy (dev.* config). dev mode itself stays OFF — activation is
// an explicit, operator-only runtime action (whk dev on). See dev-exec.md 7.2/D-3.
devGate.setPolicy(_cfg.dev);
devArtifacts.setMax(_cfg.dev?.exec?.artifactCacheMax);

/**
 * Worker-side dev-exec orchestrator: gate → intake → audit(before-ack) → dispatch
 * → redact. Shared by the exec_module MCP tool (direct) and POST /api/dev/exec
 * (and the proxy forward), so all three take one path. Never throws.
 * (docs/vision/whiskor-for-dev/dev-exec.md SECTION 2.1, invariants I-3/I-5/I-6)
 */
async function devExec(b = {}, initiator = 'agent') {
  if (!devGate.isActive()) {
    return { ok: false, blocked: 'dev_mode_inactive',
      error: 'dev mode is not active. An operator must run `whk dev on` first.' };
  }
  const tabId = b.tabId;
  if (tabId == null) return { ok: false, error: 'tabId required.' };
  const execId  = randomUUID();
  const mode    = b.mode === 'harness' ? 'harness' : 'probe';
  const policy  = devGate.getPolicy();
  const devCfg  = (_cfg.dev && _cfg.dev.exec) || {};

  // A gate/intake rejection is a 'blocked' verdict (5.3) — same vocabulary as a
  // page-side csp/origin block — so it lands in BOTH audit and verdicts.jsonl and
  // the caller sees a verdict either way. Never reaches the page.
  const blockedResult = (auditRec, reason, error, extra = {}) => {
    devAudit.appendAudit(tabId, { execId, initiator, backend: 'blob', mode, verdict: 'blocked', blocked: reason, ...auditRec });
    const { verdict, evidence } = devVerdict.buildVerdict({ outcome: 'blocked' });
    devVerdict.appendVerdict(tabId, { execId, initiator, mode, backend: 'blob',
      artifactHash: auditRec.artifactHash || null, artifactName: auditRec.artifactName || null,
      verdict, evidence }, devCfg.maxVerdicts);
    return { ok: false, execId, blocked: reason, verdict, evidence, error, ...extra };
  };

  // Resolve the artifact from exactly one of the three intake paths (4.1):
  //   inline   code
  //   push     artifactId  (previously POSTed to /api/dev/artifact)
  //   file     path        (confined to dev.exec.fileRoots)
  let code = b.code;
  let artifactName = b.name || null;
  if (code == null && b.artifactId) {
    const a = devArtifacts.get(b.artifactId);
    if (!a) return { ok: false, execId, error: `No artifact for id "${b.artifactId}" (evicted from the LRU or never pushed).` };
    code = a.code; artifactName = artifactName || a.name;
  }
  if (code == null && b.path) {
    const r = devIntake.resolveFilePath(b.path, policy.fileRoots);
    if (!r.ok) return blockedResult({ artifactHash: null, artifactName: b.path, bytes: 0 }, r.blocked, r.error);
    code = r.code; artifactName = artifactName || require('path').basename(r.absPath);
  }
  if (code == null) {
    return { ok: false, error: 'exec_module needs one of: code (inline), path (in fileRoots), or artifactId (pushed).' };
  }

  const v = devIntake.validateArtifact(code, { maxBytes: devCfg.maxArtifactBytes });
  if (!v.ok) {
    return blockedResult({ artifactHash: v.hash || null, artifactName, bytes: v.bytes || 0 }, v.blocked, v.error, { hint: v.hint });
  }

  // I-3: the audit line lands BEFORE dispatch (hence before the ack).
  devAudit.appendAudit(tabId, { execId, artifactHash: v.hash, artifactName, initiator,
    backend: 'blob', mode, bytes: v.bytes, verdict: 'pending' });

  const timeoutMs = Number.isFinite(b.timeoutMs) ? b.timeoutMs : (devCfg.timeoutMs ?? 10000);
  const action = {
    type: 'execute_module', code, mode, timeoutMs,
    allowedOrigins:    policy.allowedOrigins, // I-5 enforced page-side against these
    maxConsoleEntries: devCfg.maxConsoleEntries ?? 200,
    settleQuietMs:     devCfg.settleQuietMs ?? 500,   // verdict engine 5.2
    settleMaxMs:       devCfg.settleMaxMs   ?? 8000,
  };

  let res;
  // The page-side budget is eval (timeoutMs) + settle (settleMaxMs); give the RPC
  // that plus slack so a legitimately slow settle isn't cut off as a tab timeout.
  const rpcWaitMs = timeoutMs + (action.settleMaxMs || 0) + 3000;
  try { res = await actions.execute(tabId, action, rpcWaitMs); }
  catch (e) { res = { ok: false, error: e.message }; }

  // actions.execute → { ok, result } (result = executor's return object, always an
  // ok:true envelope carrying `outcome`), OR { ok:false, error } on a real action-
  // layer failure (tab gone / RPC timeout).
  const payload = (res && res.ok !== false && res.result) ? res.result : res;
  const outcome = (payload && payload.outcome) ? payload.outcome
                : (res && res.ok === false ? 'error' : 'ok');
  // A real action-layer failure (tab gone / RPC timeout) never reached the page,
  // so there is no baseline/observed — treat it as inconclusive, not a bare error.
  const actionFailed = !!(res && res.ok === false);
  const vEngineOutcome = actionFailed ? 'timeout' : outcome;
  const { verdict, evidence } = devVerdict.buildVerdict({
    outcome:     vEngineOutcome,
    baseline:    payload && payload.baseline,
    observed:    payload && payload.observed,
    consoleLogs: (payload && payload.consoleLogs) || [],
    mode,
    value:       payload && payload.value,
  });

  const out = {
    ok: outcome === 'ok',
    execId, artifactHash: v.hash, artifactName, initiator,
    backend: (payload && payload.backend) || 'blob', mode, outcome,
    verdict, evidence,
    value:       payload && payload.value,
    consoleLogs: (payload && payload.consoleLogs) || [],
    error:       (payload && payload.error) || (res && res.ok === false ? res.error : undefined),
    blocked:     payload && payload.blocked,
    stack:       payload && payload.stack,
    timings:     payload && payload.timings,
    hint:        payload && payload.hint,
    ...(res && res.tabGone ? { tabGone: true, liveTabs: res.liveTabs } : {}),
  };
  // I-6: redaction before the exec output leaves the server boundary.
  if (secretGuard && secretGuard.active && typeof secretGuard.redactDeep === 'function') {
    try { secretGuard.redactDeep(out); } catch (_) {}
  }

  // Persist the verdict (5.5) AFTER redaction — the stored evidence carries no
  // secrets either. Body stays out (I-4): hash + name + verdict + evidence only.
  devVerdict.appendVerdict(tabId, {
    execId, artifactHash: v.hash, artifactName, initiator, mode,
    backend: out.backend, verdict, evidence: out.evidence,
  }, devCfg.maxVerdicts);

  return out;
}

function devStatus() { return { ok: true, ...devGate.status() }; }

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
  // Fail-CLOSED fallback: if the security block is missing entirely, restrict to
  // localhost like the shipped config.json — '*' (allow all) must always be an
  // explicit opt-in in config, never something a missing block falls back to.
  allowedMcpOrigins:  _cfg.security?.allowedMcpOrigins  ?? ['localhost', '127.0.0.1'],
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
    screenshots.setThumbPrefetch(_cfg.agentControl?.packedSom?.prefetchThumbs === true);
    // Native OCR (bring-your-own binary). Resolved worker-side — the process that
    // captures — so MCP stdio, HTTP /api/ocr, and the proxy forward share one
    // engine. Inert (returns ocr_unavailable) when no binary is found.
    {
      const eng = ocrService.init(_cfg);
      if (eng) log('info', `[ocr] engine ready: ${eng.binPath} (v${eng.version})`);
      else if (_cfg.intelligence?.ocr?.enabled !== false) log('info', '[ocr] no engine found — ocr_region returns ocr_unavailable until a Tesseract binary is on PATH / WHISKOR_OCR_PATH / intelligence.ocr.binPath');
    }
    cache.setSelfOrigin(HTTP_PORT); // never capture our own dashboard / API as a site
    actions.setSomStats(somStats);
    // type_secret resolves the secret value here on the worker (where secrets live),
    // so it works under the proxy — the agent/proxy only ever carry the ref name.
    actions.setSecretGuard(secretGuard);
    // Secret-guard screenshot masking, resolved worker-side so it applies over MCP
    // stdio, HTTP, and the proxy forward alike (it used to be in the MCP tool and
    // was dead under the proxy). Reads the tab's already-redacted text-coords —
    // their boxes mark where to black out — and returns the rects to mask.
    {
      const { findRedactedRects } = require('./secret-guard');
      screenshots.setMaskProvider(async (tabId) => {
        const cfg = _cfg.privacy && _cfg.privacy.secretGuard;
        if (!secretGuard.active || !cfg || cfg.redactScreenshots === false) return null;
        const tc = await cache.readSessionFile(tabId, 'raw/visual/text-coords.json');
        return findRedactedRects(tc);
      });
    }
    sourceIndex = require('./source-index').createSourceIndex();
    sourceCorrelations = require('./source-correlation').createCorrelations();

    // Timer-driven delta flushes (the common case — quiet pages never fill the
    // frame buffer) must land in the cache, or get_delta / raw/delta/smart.json
    // stay empty forever. Full-buffer flushes return through addFrame in core.js.
    deltaEngine.setFlushSink((tabId, delta) => cache.storeSmartDelta(tabId, delta));

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
        // agentControl subset the SERVICE WORKER reads from SET_CONFIG / SI_CONFIG
        // (ensureTabActive's autoSwitchTab check, cdpConsoleTap.configure). The
        // full agentControl stays server-side; only SW-consumed keys travel —
        // omitting this whole block silently disabled those checks (the config
        // shape the SW received never contained agentControl at all).
        agentControl: {
          autoSwitchTab: _cfg.agentControl?.autoSwitchTab !== false,
          console: { captureAllWorlds: _cfg.agentControl?.console?.captureAllWorlds === true },
        },
        options: {
          textCoords:  { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000, includeFormValues: false, ...(_cfg.textCoords || {}) },
          network:     { captureBody: true, bodyMaxLength: _cfg.collection?.networkBodyMaxBytes ?? 4096, captureTokens: true },
          react:       { maxDepth: 80, maxProps: 30, maxHooks: 25, ...(_cfg.react || {}) },
          console:     { levels: ['log', 'warn', 'error', 'info', 'debug'], maxBuffer: _cfg.collection?.maxConsoleLogs ?? 2000 },
        },
      },
    });

    // Inject broadcast functions into action/screenshot modules
    actions.setBroadcast((msg) => core.sendToTab(msg));
    screenshots.setBroadcast((msg) => core.sendToTab(msg));

    // dev mode visibility (可視): broadcast activation/expiry to connected
    // extensions so they can badge the toolbar icon (録画インジケータ発想).
    devGate.onChange((snap) => {
      try { core.broadcast({ type: 'DEV_MODE', active: snap.active, expiresAt: snap.expiresAt }); } catch (_) {}
    });

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
    const { allow: originAllowed, acao } = checkOrigin(origin, {
      host: HOST, httpPort: HTTP_PORT, allowedMcpOrigins: SECURITY.allowedMcpOrigins,
    });
    res.setHeader('Access-Control-Allow-Origin', acao);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (!originAllowed) {
      // Cross-origin request from a page outside allowedMcpOrigins. The ACAO
      // header above only blocks the page from reading this response — it does
      // not stop "simple" (no-preflight) requests from being delivered, so
      // reject here before the body is read or any action is dispatched.
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: `Origin not allowed: ${origin}` }));
    }

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

    // Graceful remote shutdown — lets `whk stop` / `whk restart` stop the
    // server without hunting down the port owner. Reuses the signal handlers'
    // shutdown(): buffers are flushed synchronously and the exit code is 0
    // (clean), so a supervisor stops too instead of restarting (supervisor.js
    // exit semantics). Loopback-only like every other endpoint.
    if (method === 'POST' && p === '/api/shutdown') {
      log('info', '[http] Shutdown requested (POST /api/shutdown)');
      sendJson({ ok: true, shuttingDown: true });
      setTimeout(() => shutdown(0, 'api/shutdown'), 150);
      return;
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
          // Honor the same capture knobs the MCP tool does (format/quality/maxWidth
          // were previously ignored on HTTP — the documented asymmetry). returnImage
          // defaults to true here for backward compat with the dashboard + bundled
          // skill (which read dataUrl); pass returnImage:false to omit the base64
          // and use the filePath/url instead.
          const sc = (_cfg.agentControl && _cfg.agentControl.screenshot) || {};
          // Explicit request flag wins; otherwise fall back to the config default
          // (httpInlineImage, default true = backward compatible). Set
          // httpInlineImage:false for a text-first default (url/filePath only).
          const wantImage = b.returnImage != null ? b.returnImage !== false : (sc.httpInlineImage !== false);
          const opts = {
            marks:    b.marks === true,
            format:   b.format || sc.format || 'jpeg',
            quality:  typeof b.quality  === 'number' ? b.quality  : (typeof sc.quality  === 'number' ? sc.quality  : 70),
            maxWidth: typeof b.maxWidth === 'number' ? b.maxWidth : (typeof sc.maxWidth === 'number' ? sc.maxWidth : 0),
          };
          const result = await screenshots.capture(b.tabId, opts);
          if (!result || !result.ok) { sendJson(result); return; }
          const response = {
            ok: true,
            capturedAt: result.capturedAt,
            filePath:   result.filePath,
            url:        result.filePath ? `/api/screenshots/${path.basename(result.filePath)}` : undefined,
            width:      result.width,
            height:     result.height,
          };
          if (result.elements) response.elements = result.elements;
          if (wantImage) response.dataUrl = result.dataUrl;
          else response._note = 'base64 omitted (returnImage:false). Fetch the image via url or read filePath locally.';
          sendJson(response);
        } catch (e) {
          sendJson({ ok: false, error: e.message }, 500);
        }
      });
    }

    // Capture page sources via the DevTools panel (getResources, CORS-free) and
    // ingest them as SOURCE_CONTENT. Requires the whiskor DevTools panel open on
    // the tab. Shared by the capture_sources MCP tool (proxy forwards here).
    if (method === 'POST' && p === '/api/source/capture') {
      return readBody().then(async b => {
        try {
          if (!b || b.tabId == null) { sendJson({ ok: false, error: 'tabId required' }, 400); return; }
          const result = await core.requestSourceCapture(b.tabId, b);
          sendJson(result);
        } catch (e) {
          sendJson({ ok: false, error: e.message }, 500);
        }
      });
    }

    // Captured sources for a session: list metadata, or download as a
    // folder-structured ZIP (host/path/file.ext, rebuilt from the manifest).
    //   GET /api/sources/:tabId       → { tabId, files: [...] }
    //   GET /api/sources/:tabId/zip   → application/zip
    if (method === 'GET' && p.startsWith('/api/sources/')) {
      const rest  = p.slice('/api/sources/'.length).split('/');
      const tabId = parseInt(rest[0], 10);
      const sub   = rest[1] || '';
      if (!Number.isFinite(tabId)) return sendJson({ error: 'Invalid tabId' }, 400);
      const sessionDir = core.cache.getSessionDir ? core.cache.getSessionDir(tabId) : null;
      if (!sessionDir) return sendJson({ error: 'No session for tabId' }, 404);
      if (sub === 'zip') {
        const buf = core.sourceStore && core.sourceStore.buildSourcesZip(sessionDir);
        if (!buf) return sendJson({ error: 'No stored sources for this session' }, 404);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="sources-${tabId}.zip"`,
          'Content-Length': buf.length,
        });
        return res.end(buf);
      }
      const files = (core.sourceStore && core.sourceStore.getSessionSources(sessionDir)) || [];
      return sendJson({ tabId, count: files.length, files });
    }

    // Serve a saved screenshot by filename so HTTP consumers can fetch the image
    // via the `url` field instead of inlining base64. Filename only (basename) —
    // path traversal is blocked by rejecting anything that isn't a bare name.
    if (method === 'GET' && p.startsWith('/api/screenshots/')) {
      const name = p.slice('/api/screenshots/'.length);
      if (!name || name !== path.basename(name)) return sendJson({ error: 'Invalid screenshot name' }, 400);
      const fp = path.join(screenshots.SCREENSHOT_DIR, name);
      if (!fs.existsSync(fp)) return sendJson({ error: 'Screenshot not found' }, 404);
      const ext = path.extname(name).slice(1).toLowerCase();
      const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      try {
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
        return res.end(buf);
      } catch (e) {
        return sendJson({ error: e.message }, 500);
      }
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

    // Native OCR: capture a tab (or cropped region) and read text from pixels.
    // Shared worker-side path (ocrCapture) so MCP direct, HTTP, and the proxy
    // forward behave identically. GET reports engine availability.
    if (method === 'GET' && p === '/api/ocr') {
      return sendJson(ocrService.getStatus());
    }
    if (method === 'POST' && p === '/api/ocr') {
      return readBody().then(async b => {
        try {
          sendJson(await ocrCapture(b));
        } catch (e) {
          sendJson({ ok: false, error: e.message }, 500);
        }
      });
    }

    // ── dev-exec endpoints ──────────────────────────────────────────────────
    // Control (status/on/off) is the OPERATOR surface (whk dev). It is not an MCP
    // tool, so the agent's tool channel cannot activate dev mode (I-2). Capability
    // endpoints (exec) return 404 when dev mode is off — absence, not refusal (I-1).
    if (method === 'GET' && p === '/api/dev/status') {
      return sendJson({ ok: true, ...devGate.status() });
    }
    if (method === 'POST' && p === '/api/dev/on') {
      return readBody().then(b => {
        const r = devGate.activate({ ttlMs: b && b.ttlMs, project: b && b.project });
        log('info', r.ok ? `[dev] mode ON (${Math.round((r.remainingMs || 0) / 60000)}m TTL)` : `[dev] activate refused: ${r.error}`);
        // Always 200 so the ok:false reason (e.g. policy disabled) reaches the CLI
        // instead of being flattened to "HTTP 400". This is an operator control
        // endpoint, not a capability endpoint.
        sendJson(r, 200);
      });
    }
    if (method === 'POST' && p === '/api/dev/off') {
      const r = devGate.deactivate('operator');
      log('info', '[dev] mode OFF (operator)');
      return sendJson(r);
    }
    if (method === 'POST' && p === '/api/dev/exec') {
      if (!devGate.isActive()) return sendJson({ error: 'Not found' }, 404); // I-1: absent when off
      return readBody().then(async b => {
        try { sendJson(await devExec(b, (b && b.initiator === 'operator') ? 'operator' : 'agent')); }
        catch (e) { sendJson({ ok: false, error: e.message }, 500); }
      });
    }
    // push intake: a toolchain build hook drops a freshly built artifact here and
    // gets an artifactId to exec later. Capability endpoint → 404 when off (I-1).
    if (method === 'POST' && p === '/api/dev/artifact') {
      if (!devGate.isActive()) return sendJson({ error: 'Not found' }, 404);
      return readBody().then(b => {
        try {
          let code = b && b.code;
          // Optional zip: accept a build output archive that contains exactly one
          // .js module (the artifact). More than one → ambiguous, reject.
          if (code == null && b && b.zipBase64) {
            const files = require('./zip-reader').readZip(Buffer.from(b.zipBase64, 'base64'));
            const js = Object.keys(files).filter(n => n.endsWith('.js'));
            if (js.length !== 1) return sendJson({ ok: false, error: `zip must contain exactly one .js module (found ${js.length}).` }, 400);
            code = files[js[0]];
            if (!b.name) b.name = js[0];
          }
          if (typeof code !== 'string' || !code) return sendJson({ ok: false, error: 'artifact `code` (or a single-.js `zipBase64`) required.' }, 400);
          const r = devArtifacts.add(b && b.name, code);
          sendJson({ ok: true, ...r });
        } catch (e) { sendJson({ ok: false, error: e.message }, 500); }
      });
    }

    // Uploaded-source endpoints (source-upload feature, slice 1).
    if (method === 'POST' && p === '/api/source/upload') {
      return readBody().then(b => {
        try {
          if (!sourceIndex) return sendJson({ ok: false, error: 'Source index unavailable.' }, 503);
          // Accept either a JSON file map { files: { path: content } } or a
          // base64-encoded .zip { zipBase64 } (read with the dependency-free reader).
          let files = b.files || {};
          if (b.zipBase64) {
            const buf = Buffer.from(b.zipBase64, 'base64');
            files = { ...require('./zip-reader').readZip(buf), ...files };
          }
          const r = sourceIndex.addFiles(b.projectId || 'default', files);
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

      // GET /api/search — cross-session text search (server/session-search.js, shared
      // with the search_all_tabs MCP tool). Handled here rather than in core's HTTP
      // handler because it is async (file reads + optional MiniLM) and the core GET
      // path serialises result.body without awaiting; this branch can await directly.
      if (method === 'GET' && p === '/api/search') {
        const { searchSessions } = require('./session-search');
        const sp = url.searchParams;
        const mode = sp.get('mode') || 'exact';
        let backend = null;
        if (mode === 'semantic') {
          try { backend = await require('./mcp/tools/backend-selector').resolveBackend(_cfg); } catch (_) {}
        }
        // Respect app isolation: only scan tabs the caller may access. searchSessions
        // only uses getSessionList + readSessionFile, so a thin filtered wrapper suffices.
        const searchCache = appRegistry.enabled ? {
          getSessionList: (o) => cache.getSessionList(o).filter(s => appRegistry.canAccess(httpAppId, core.getTabApp(s.tabId))),
          readSessionFile: (t, f) => cache.readSessionFile(t, f),
        } : cache;
        const out = await searchSessions(searchCache, {
          q:         sp.get('q'),
          mode,
          level:     sp.get('level'),
          minScore:  sp.get('minScore'),
          maxPerTab: sp.get('maxPerTab'),
          backend,
        });
        return sendJson(out);
      }

      // GET /api/sessions — relevance-sorted / searchable / pageable session list
      // (server/session-list.js, shared with the get_sessions MCP tool). Handled
      // here rather than in core's HTTP handler for the same reason as /api/search:
      // semantic mode needs an awaited MiniLM backend, and core's non-action GET
      // path serialises result.body without awaiting. With no enhanced params this
      // returns the same bare (now relevance-sorted) array the old endpoint did.
      if (method === 'GET' && p === '/api/sessions') {
        const { selectSessions } = require('./session-list');
        const sp = url.searchParams;
        const verbose = sp.get('verbose');
        const brief = !(verbose === '1' || verbose === 'true');
        let list = cache.getSessionList({ brief });
        if (appRegistry.enabled) {
          list = list.filter(s => appRegistry.canAccess(httpAppId, core.getTabApp(s.tabId)));
        }
        const mode = sp.get('mode') || 'exact';
        let backend = null;
        if (mode === 'semantic' && sp.get('q')) {
          try { backend = await require('./mcp/tools/backend-selector').resolveBackend(_cfg); } catch (_) {}
        }
        const out = await selectSessions(list, {
          q:        sp.get('q'),
          mode,
          sort:     sp.get('sort'),
          minScore: sp.get('minScore'),
          page:     sp.get('page'),
          pageSize: sp.get('pageSize'),
          tabId:    sp.get('tabId'),
          backend,
        });
        return sendJson(out);
      }

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

      // Update check (non-blocking, best-effort). Only in normal server mode
      // (this callback never runs under MCP stdio). Compares this build against
      // the published version.json; result is surfaced on /health. Never blocks
      // or crashes startup — the module swallows all failures.
      setImmediate(async () => {
        try {
          const { runUpdateCheck } = require('./update-checker');
          const currentVersion = require('../package.json').version;
          const status = await runUpdateCheck(_cfg.updateCheck, currentVersion, log);
          if (core && core.setUpdateStatus) core.setUpdateStatus(status);
        } catch (e) {
          log('warn', `[update] check errored: ${e.message}`);
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

          // Bound session-cache disk usage (LRU eviction of oldest session dirs).
          // The limit existed (cache-integrity.enforceDiskLimit, stateGraph.maxDiskMB)
          // but was never called — wire it here at startup.
          const maxDiskMB = _cfg.stateGraph?.maxDiskMB;
          if (maxDiskMB > 0) {
            const disk = enforceDiskLimit(cacheRoot, maxDiskMB);
            if (disk && disk.evicted) log('info', `[cache] Disk limit: evicted ${disk.evicted} old session(s), ${disk.evictedSizeMB.toFixed(1)}MB (now ${disk.totalSizeMB.toFixed(1)}/${maxDiskMB}MB)`);
          }
        } catch (e) {
          log('warn', `[cache] Integrity check skipped: ${e.message}`);
        }

        // Bound the screenshot directory too (separate tree, not covered above).
        try {
          const shot = _cfg.agentControl?.screenshot || {};
          screenshots.setRetention({
            maxMB:    shot.maxDiskMB != null ? shot.maxDiskMB : 100,
            maxAgeMs: (shot.maxAgeHours != null ? shot.maxAgeHours : 24) * 60 * 60 * 1000,
          });
          const pruned = screenshots.pruneOldScreenshots();
          if (pruned && pruned.deleted) log('info', `[cache] Pruned ${pruned.deleted} old screenshot(s), freed ${pruned.freedMB.toFixed(1)}MB (now ${pruned.remainingMB.toFixed(1)}MB)`);
        } catch (e) {
          log('warn', `[cache] Screenshot prune skipped: ${e.message}`);
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
      getSessionList(opts) { return requestServer('GET', opts && opts.brief === false ? '/api/sessions?verbose=1' : '/api/sessions'); },
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
    // OCR runs on the worker (it captures + shells out to the engine); forward.
    mcp.setOcrRegion(async (opts) => requestServer('POST', '/api/ocr', opts));
    // Proxy mode: the worker owns the tab inventory; fetch the uninstrumented diff.
    mcp.setUninstrumentedTabs(async () => { try { return (await requestServer('GET', '/api/uninstrumented-tabs'))?.tabs || []; } catch { return []; } });
    mcp.setSourceContext((q) => requestServer('POST', '/api/source/context', q));
    mcp.setSourceCapture((args) => requestServer('POST', '/api/source/capture', args || {}));
    // dev-exec lives on the worker (gate/audit/dispatch); forward. The proxy's own
    // dev-gate is never activated — worker /health.dev is the source of truth.
    mcp.setDevExec(
      (args) => requestServer('POST', '/api/dev/exec', args || {}),
      () => requestServer('GET', '/api/dev/status'),
    );

    mcp.setSecurity(SECURITY);

    const proxyConfigLog = {
      setAllowAgentConfig() {},
      autoRevertIfNeeded() { return null; }
    };
    mcp.setConfigLog(proxyConfigLog);
    mcp.setNavigateBroadcast(() => {});

    // T11(b): the proxy process holds no secret guard — the secrets live in the
    // worker — so serverInfo's redaction notice was silently absent under the
    // proxy. Ask the worker's /health (counts only, never values) at initialize
    // time, bounded so a down worker can't stall the MCP handshake (the notice
    // is informational; on any failure it is simply omitted, as before).
    mcp.setRedactionStatus(async () => {
      const health = await Promise.race([
        requestServer('GET', '/health'),
        new Promise((resolve) => { const t = setTimeout(() => resolve(null), 2000); if (t.unref) t.unref(); }),
      ]).catch(() => null);
      const sg = health && health.secretGuard;
      return (sg && sg.active) ? sg : null;
    });

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
    mcp.setOcrRegion(ocrCapture); // capture + recognize, worker-side

    // Direct mode: read the inventory diff straight off core.
    mcp.setUninstrumentedTabs(() => {
      if (appRegistry.enabled) return []; // don't leak cross-app tab URLs
      const ids = cache.getSessionList({ brief: true }).map(s => s.tabId);
      return core.getUninstrumentedTabs(ids);
    });
    mcp.setSourceContext((q) => require('./source-index').queryContext(sourceIndex, q, sourceCorrelations));
    mcp.setSourceCapture((args) => core.requestSourceCapture(args && args.tabId, args || {}));

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
    mcp.setDevExec(devExec, devStatus); // in-process gate/intake/audit/dispatch
    configLog.setAllowAgentConfig(_cfg.agentControl?.allowAgentConfig !== false);
  }

  mcp.setConfig(_cfg);
  mcp.setIdentity(IDENTITY);
  log('info', `[identity] instance=${IDENTITY.instanceId} name=${IDENTITY.name}${PROXY_MODE ? ' (proxy)' : ''}`);

  {
    const toolManager = require('./tool-manager');

    // Absence principle (I-1): the dev profile is visible only while dev mode is
    // active. Standalone reads the in-process gate directly. The proxy MCP is a
    // separate process whose own gate is never activated, so it polls the worker's
    // /health.dev (unref'd) and reflects that — activation shows up within a poll,
    // and the next tools/call emits tools/list_changed.
    if (PROXY_MODE) {
      let _proxyDevActive = false;
      const pollDev = async () => {
        try { const h = await requestServer('GET', '/health'); _proxyDevActive = !!(h && h.dev && h.dev.active); }
        catch { /* keep last known */ }
      };
      const iv = setInterval(pollDev, 3000); if (iv.unref) iv.unref();
      pollDev();
      toolManager.setDevModeChecker(() => _proxyDevActive);
    } else {
      toolManager.setDevModeChecker(() => devGate.isActive());
    }

    const rawEnvSid = process.env.WHISKOR_MCP_SESSION_ID;
    const envSid = rawEnvSid ? toolManager.sanitizeSessionId(rawEnvSid) : null;
    if (rawEnvSid && !envSid) {
      log('warn', `[mcp] Ignoring WHISKOR_MCP_SESSION_ID="${rawEnvSid}" (must match /^[A-Za-z0-9_.:-]{1,64}$/)`);
    }
    const sid = envSid || `mcp-${Date.now()}`;
    if (envSid) log('info', `[mcp] Using fixed session id from env: ${sid}`);
    mcp.setSessionId(sid);

    // Static tools mode: every profile permanently visible (no dynamic
    // load/unload), for MCP clients that fetch tools/list once and never follow
    // tools/list_changed. requiresConfig gates and mcp-tools.json enabled flags
    // still apply. Enable via config mcpServer.staticTools or --static-tools.
    if (STATIC_TOOLS_FLAG || _cfg.mcpServer?.staticTools === true) {
      toolManager.setStaticMode(true);
      log('info', '[mcp] Static tools mode — all profiles permanently visible (dynamic load/unload disabled)');
    }
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
      const modelCached = fs.existsSync(path.join(cacheDir, 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2'));

      if (!modelCached) {
        log('info', '[model] Downloading MiniLM embedding model (first startup, ~50MB)...');
        log('info', '[model] This may take 30-60 seconds depending on your connection.');
        const { pipeline } = require('@xenova/transformers');
        await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { quantized: true });
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
