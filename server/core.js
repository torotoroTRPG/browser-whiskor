/**
 * server/core.js  –  browser-whiskor v3 core logic
 *
 * Extracted from server/index.js for testability.
 * Contains: socket management, message routing, broadcast, config push.
 * Does NOT start any servers — pure logic only.
 */
'use strict';

const EventEmitter = require('events');

const DISCONNECT_CLEANUP_MS = 15 * 60 * 1000; // 15 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // check every 5 min

// Message types that change a page's interactive surface → invalidate any cached
// packed Set-of-Marks capture for that tab (see som-cache.js).
const SOM_CHANGE_TYPES = new Set([
  'PAGE_NAVIGATED', 'DOM_MUTATION', 'TEXT_COORDS', 'UI_CATALOG',
  'DOM_SNAPSHOT', 'DOM_GENERIC_SNAPSHOT', 'SHADOW_DOM_SNAPSHOT',
]);

class WhiskorCore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.swSockets = new Set();
    this.dashboardSockets = new Set();
    this.logSubscribers = new Set();  // For dashboard log subscriptions
    this._pendingActions = new Map();
    this._wsToTabs = new Map();       // WebSocket → Set<tabId>
    this._tabDisconnectedAt = new Map(); // tabId → timestamp
    this._wsToApp  = new Map();       // WebSocket → appId (null = unregistered/public)
    this._tabToApp = new Map();       // tabId    → appId
    // Task 1: deferred buffer — holds TEXT_COORD_DELTA 100ms to let DOM_MUTATION arrive first
    this._deferredDeltas = new Map(); // tabId → { timer, msg }

    // Periodic cleanup: remove sessions disconnected for > DISCONNECT_CLEANUP_MS
    this._cleanupTimer = setInterval(() => this._cleanupStaleSessions(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref();

    // Injected dependencies (real server passes actual modules)
    this.cache = opts.cache || { handleMessage() { return Promise.resolve(); }, getSessionList() { return []; }, getSessionData() { return null; }, getSessionDir() { return null; }, readSessionFile() { return null; }, storeSmartDelta() {} };
    this.actions = opts.actions || { handleResult() {}, execute() { return { ok: false, error: 'No actions module' }; }, pendingCount() { return 0; }, setBroadcast() {} };
    this.screenshots = opts.screenshots || { handleResult() {}, capture() { return { ok: false, error: 'No screenshots module' }; }, setBroadcast() {} };
    this.stateMachine = opts.stateMachine || { addNode() {}, addEdge() {}, getUnvisitedActions() { return []; }, getAllGraphs() { return []; } };
    this.stateNavigator = opts.stateNavigator || { handleHashReport() {} };
    this.deltaEngine = opts.deltaEngine || { addFrame() { return null; } };
    this.configLog = opts.configLog || { validateChange() { return []; }, addChange() {}, autoRevertIfNeeded() { return null; } };
    // Redacts the user's secrets from collected data before it is logged,
    // broadcast, persisted, or read by the agent. Passthrough unless configured.
    this.secretGuard = opts.secretGuard || { redactMessage(m) { return m; } };
    // Packed-SoM freshness cache (slice 2). Default no-op; real one wired in index.js.
    this.somCache = opts.somCache || { markChanged() {}, evictTab() {}, get() { return null; }, set() {} };
    // Per-element thumbnail cache (T2). Same view-aware invalidation signal as
    // somCache; default no-op, real one wired in index.js.
    this.somThumbs = opts.somThumbs || { markChanged() {}, evictTab() {} };
    // Source-upload correlation (slice 3): when a FRAMEWORK_DOM_MAP carries a
    // component + runtime debug-source, record the runtime→source link passively
    // so the map fills in from observation. Both null unless uploaded source exists.
    this.sourceIndex        = opts.sourceIndex        || null;
    this.sourceCorrelations = opts.sourceCorrelations || null;
    this.correlator       = opts.correlator       || null;
    this.sourceStore      = opts.sourceStore      || null;
    this._conclusionCache = opts.conclusionCache  || null;
    this.appRegistry      = opts.appRegistry      || null;
    this.identity         = opts.identity         || null;

    this.globalConfig = opts.initialConfig || {
      mode: 'always_on',
      plugins: {},
      options: {
        textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000 },
        network: { captureBody: true, bodyMaxLength: 4096, captureTokens: true },
        react: { maxDepth: 80, maxProps: 30, maxHooks: 25 },
        console: { levels: ['log', 'warn', 'error', 'info', 'debug'], maxBuffer: 2000 },
      },
    };
  }

  // ── Broadcast ───────────────────────────────────────────────────────────────
  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.swSockets) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  // Send a tab-scoped message (actions / screenshots) only to the SW that owns
  // msg.tabId. Without this, actions are broadcast to every connected browser, and a
  // browser that lacks the tab answers "No tab with id" and can win the result race
  // (the cause of flaky "No tab" / hangs when multiple browsers run the extension).
  // Falls back to broadcast when no connected SW is known to own the tab.
  sendToTab(msg) {
    const tabId = msg && msg.tabId;
    if (tabId != null) {
      for (const [ws, tabs] of this._wsToTabs) {
        if (tabs.has(tabId) && this.swSockets.has(ws) && ws.readyState === 1) {
          try { ws.send(JSON.stringify(msg)); } catch (_) {}
          return true;
        }
      }
    }
    this.broadcast(msg);
    return false;
  }

  broadcastToDashboard(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  broadcastLog(level, ...args) {
    const message = args.join(' ');
    const raw = JSON.stringify({ type: 'LOG_ENTRY', level, message, ts: Date.now() });
    for (const ws of this.logSubscribers) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────────
  pushConfig(patch, source = 'api') {
    const warnings = this.configLog.validateChange(patch);
    this.configLog.addChange({ patch, source, warnings });

    this.globalConfig = {
      ...this.globalConfig,
      ...patch,
      options: { ...this.globalConfig.options, ...(patch?.options || {}) },
      plugins: { ...this.globalConfig.plugins, ...(patch?.plugins || {}) },
    };
    this.broadcast({ type: 'SET_CONFIG', config: this.globalConfig });
    this.emit('config', this.globalConfig);

    return { ok: true, warnings };
  }

  triggerCollect(tabId, plugins) {
    if (tabId) {
      this.broadcast({ type: 'MANUAL_COLLECT', tabId, plugins });
    } else {
      this.broadcast({ type: 'MANUAL_COLLECT', plugins });
    }
  }

  triggerExplorer(tabId, active, strategy) {
    this.broadcast({ type: 'EXPLORER_CONTROL', tabId, active, strategy: strategy || 'breadth_first' });
  }

  // ── WebSocket connection handling ───────────────────────────────────────────

  /** Returns the appId associated with a given tabId (null if unregistered). */
  getTabApp(tabId) {
    return this._tabToApp.get(tabId) ?? null;
  }

  handleSWConnect(ws, config, appId = null) {
    this.swSockets.add(ws);
    this._wsToApp.set(ws, appId);
    ws.send(JSON.stringify({ type: 'SET_CONFIG', config }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }
      this.routeMessage(msg, ws).catch(err => {
        console.error('[core] routeMessage error:', err);
      });
    });

    const onDisconnect = () => {
      this.swSockets.delete(ws);
      this._wsToApp.delete(ws);
      // Mark all tabs for this ws as disconnected
      const tabs = this._wsToTabs.get(ws);
      if (tabs) {
        const now = Date.now();
        for (const tabId of tabs) this._tabDisconnectedAt.set(tabId, now);
      }
      this._wsToTabs.delete(ws);
      this.emit('sw:disconnect');
    };

    ws.on('close', onDisconnect);
    ws.on('error', onDisconnect);

    this.emit('sw:connect', ws);
  }

  handleDashboardConnect(ws, sessions, config) {
    this.dashboardSockets.add(ws);
    ws.send(JSON.stringify({ type: 'INIT', sessions, config }));

    ws.on('close', () => {
      this.dashboardSockets.delete(ws);
      this.emit('dashboard:disconnect');
    });

    ws.on('error', () => {
      this.dashboardSockets.delete(ws);
      this.emit('dashboard:disconnect');
    });

    this.emit('dashboard:connect', ws);
  }

  // ── Message routing ─────────────────────────────────────────────────────────
  async routeMessage(msg, fromWs) {
    // Redact secrets at the single ingestion point — before any logging,
    // dashboard broadcast, persistence, or agent-facing read can see them.
    this.secretGuard.redactMessage(msg);

    // Invalidate any cached packed-SoM capture for this tab when the page's
    // interactive surface changes (navigation, DOM mutation, scroll/recollect).
    if (msg.tabId && SOM_CHANGE_TYPES.has(msg.type)) { this.somCache.markChanged(msg.tabId); this.somThumbs.markChanged(msg.tabId); }
    this.emit('message', msg, fromWs);
    // Track which tabIds belong to this WebSocket for cleanup + app isolation
    if (msg.tabId && fromWs) {
      if (!this._wsToTabs.has(fromWs)) this._wsToTabs.set(fromWs, new Set());
      this._wsToTabs.get(fromWs).add(msg.tabId);
      this._tabDisconnectedAt.delete(msg.tabId); // reconnected
      // Bind tab → app (first reporter wins; stable for the tab's lifetime)
      if (!this._tabToApp.has(msg.tabId)) {
        this._tabToApp.set(msg.tabId, this._wsToApp.get(fromWs) ?? null);
      }
    }

    switch (msg.type) {
      case 'SUBSCRIBE_LOGS':
        if (this.dashboardSockets.has(fromWs)) {
          this.logSubscribers.add(fromWs);
          fromWs.send(JSON.stringify({ type: 'LOG_SUBSCRIBED' }));
        }
        break;
        
      // Data collection → cache + dashboard
      case 'FRAMEWORK_DETECTION':
      case 'DOM_GENERIC_SNAPSHOT':
      case 'SHADOW_DOM_SNAPSHOT':
      case 'DOM_SNAPSHOT':
      case 'TEXT_COORDS':
      case 'UI_CATALOG':
      case 'CSS_ANALYSIS':
      case 'ACCESSIBILITY_TREE':
      case 'STORAGE_SNAPSHOT':
      case 'CONSOLE_LOG':
      case 'PERF_METRICS':
      case 'SOURCE_CATALOG':
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        break;

      case 'PAGE_NAVIGATED':
        // Invalidate conclusion cache — page state has changed, prior conclusions are stale
        if (this._conclusionCache) this._conclusionCache.invalidate(msg.tabId);
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        break;

      // Framework snapshots → cache + dashboard + correlator (Rule 2/3 accuracy)
      case 'REACT_SNAPSHOT':
      case 'VUE_SNAPSHOT':
      case 'VUE2_SNAPSHOT':
      case 'VUE3_SNAPSHOT':
      case 'ANGULAR_SNAPSHOT':
      case 'SVELTE_SNAPSHOT':
      case 'PREACT_SNAPSHOT':
      case 'ALPINE_SNAPSHOT':
      case 'SOLID_SNAPSHOT':
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        if (this.correlator) {
          this.correlator.addMessage(msg);
          // No causal chains emitted from snapshots — they are state context
        }
        break;

      // Network events → cache + dashboard + correlator
      case 'NETWORK_REQUEST':
      case 'NETWORK_RESPONSE':
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        if (this.correlator) {
          const newChains = this.correlator.addMessage(msg);
          if (newChains.length) this._persistCausalChains(msg.tabId, newChains);
        }
        break;

      // Failed requests (CORS, connection refused, WS/SSE errors) → cache + dashboard.
      // Not fed to the correlator: an error is the absence of a response, not a
      // causal signal. Previously dropped entirely, so failures were invisible.
      case 'NETWORK_ERROR':
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        break;

      // ── Intelligence Layer messages ─────────────────────────────────────
      case 'DOM_MUTATION': {
        // Task 1: if a TEXT_COORD_DELTA is pending for this tab, cancel it — dom_mutation wins.
        const _mutTabId = msg.tabId;
        if (this._deferredDeltas.has(_mutTabId)) {
          clearTimeout(this._deferredDeltas.get(_mutTabId).timer);
          this._deferredDeltas.delete(_mutTabId);
        }
        // Feed to correlator for causal-chain building
        if (this.correlator) {
          const newChains = this.correlator.addMessage(msg);
          if (newChains.length) this._persistCausalChains(msg.tabId, newChains);
        }
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        break;
      }

      case 'FRAMEWORK_DOM_MAP': {
        // Persist to intelligence cache directory
        this._persistIntelligenceData(msg.tabId, 'framework-dom-map.json', msg.payload);
        // Slice 3: passively record the runtime→source link observed here, so the
        // correlation map fills in as whiskor watches components, with no agent
        // round-trip. Only when uploaded source exists and the component reported a
        // name (debug-source hint used when present for an exact match).
        this._recordObservedCorrelation(msg.payload);
        this.broadcastToDashboard(msg);
        break;
      }

      case 'CSS_ORIGIN_MAP': {
        this._persistIntelligenceData(msg.tabId, 'css-origin-map.json', msg.payload);
        this.broadcastToDashboard(msg);
        break;
      }

      case 'SOURCE_CONTENT': {
        if (this.sourceStore) {
          const sessionDir = this.cache.getSessionDir ? this.cache.getSessionDir(msg.tabId) : null;
          const changed    = this.sourceStore.handleSourceContent(msg, sessionDir, msg.sessionId);
          if (changed.length) {
            // Persist SOURCE_CHANGED events
            this._appendSourceChanges(msg.tabId, changed);
          }
        }
        this.broadcastToDashboard(msg);
        break;
      }

      case 'VIEWPORT_UPDATE': {
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        const payload = msg.payload || {};
        const s = this.cache.getSessionData(msg.tabId);
        const prevVp = s?.viewport || null;
        this.deltaEngine.addFrame(msg.tabId, {
          timestamp: Date.now(),
          viewport: { from: prevVp, to: payload },
          deltas: [],
        });
        break;
      }

      case 'TEXT_COORD_DELTA': {
        // Task 1: deferred correlator dispatch — wait 100ms for DOM_MUTATION to arrive.
        // MutationObserver fires synchronously; text-coord calculation is async, so
        // dom_mutation nearly always arrives first in practice. This makes it 100% certain.
        // Cache and dashboard updates are immediate (no delay needed there).
        const _tabId = msg.tabId;
        if (this._deferredDeltas.has(_tabId)) {
          clearTimeout(this._deferredDeltas.get(_tabId).timer);
        }
        this._deferredDeltas.set(_tabId, {
          timer: setTimeout(() => {
            this._deferredDeltas.delete(_tabId);
            // DOM_MUTATION did not arrive within 100ms — forward visual_delta to correlator
            if (this.correlator) {
              const newChains = this.correlator.addMessage(msg);
              if (newChains.length) this._persistCausalChains(msg.tabId, newChains);
            }
          }, 100),
          msg,
        });
        // Cache and dashboard are updated immediately (no accuracy concern there)
        this.broadcastToDashboard(msg);
        const payload = msg.payload || {};
        const frame = {
          timestamp: Date.now(),
          viewport: payload.viewStateOnly ? null : {
            from: payload.prevViewport || null,
            to: payload.viewport || null,
          },
          deltas: payload.deltas || [],
        };
        const smartDelta = this.deltaEngine.addFrame(msg.tabId, frame);
        if (smartDelta) {
          this.cache.storeSmartDelta(msg.tabId, smartDelta);
        }
        break;
      }

      case 'ACTION_RESULT':
        this.actions.handleResult(msg);
        break;

      case 'SCREENSHOT_RESULT':
      case 'ELEMENT_CAPTURE_RESULT':
      case 'PACKED_SOM_RESULT':
        this.screenshots.handleResult(msg);
        break;

      case 'EXPLORER_STATE_UPDATE': {
        const { siteVersion, currentHash, reactHash, domHash, url, title, uiCatalog } = msg.payload || {};
        if (siteVersion && currentHash) {
          const reactSnapshot = this.cache.readSessionFile(msg.tabId, 'raw/react_snapshot.json');
          this.stateMachine.addNode(siteVersion, {
            hash: currentHash,
            reactHash: reactHash || null,
            domHash: domHash || currentHash,
            url, title, uiCatalog,
            reactState: reactSnapshot || null,
          });
        }
        if (siteVersion && currentHash && uiCatalog) {
          const candidates = this.stateMachine.getUnvisitedActions(siteVersion, currentHash, uiCatalog);
          fromWs.send(JSON.stringify({
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
        this.broadcastToDashboard(msg);
        break;
      }

      case 'REACT_TRANSITION': {
        const { from, to, fromReact, toReact, trigger } = msg.payload || {};
        if (msg.siteVersion && from && to) {
          this.stateMachine.addEdge(msg.siteVersion, {
            from, to,
            action: 'react-update',
            trigger: trigger || null,
          });
        }
        // Feed to correlator — framework transitions improve causal-chain Rule 2/3
        if (this.correlator) {
          const newChains = this.correlator.addMessage(msg);
          if (newChains?.length) this._persistCausalChains(msg.tabId, newChains);
        }
        this.broadcastToDashboard(msg);
        break;
      }

      case 'STATE_HASH_REPORT':
        this.stateNavigator.handleHashReport(msg);
        this.broadcastToDashboard(msg);
        break;

      case 'EXPLORER_TRANSITION': {
        const { siteVersion, from, to, action: act, trigger } = msg.payload || {};
        if (siteVersion && from) {
          this.stateMachine.addEdge(siteVersion, { from, to, action: act, trigger });
        }
        break;
      }

      case 'PING':
        fromWs.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        break;

      default:
        this.emit('unknown', msg);
    }
  }

  // ── HTTP request handler (returns response data, doesn't send) ──────────────
  handleHttpRequest(req) {
    const { method, url, body } = req;
    const p = url.pathname;
    const callerAppId  = req.callerAppId  ?? null;
    const appRegistry  = this.appRegistry;

    if (method === 'GET' && p === '/health') {
      const sg = this.secretGuard;
      return { status: 200, body: {
        ok: true,
        identity: this.identity || null,
        wsConnections: this.swSockets.size,
        sessions: this.cache.getSessionList().length,
        pendingActions: this.actions.pendingCount(),
        // Secret-guard status — counts only, never the secret values.
        secretGuard: {
          active:      !!(sg && sg.active),
          knownValues: (sg && sg.count) || 0,
          patterns:    (sg && sg.patternCount) || 0,
          refs:        (sg && sg.refCount) || 0,
        },
      } };
    }

    if (method === 'GET' && p === '/api/config') {
      return { status: 200, body: this.globalConfig };
    }

    if (method === 'POST' && p === '/api/config') {
      this.pushConfig(body);
      return { status: 200, body: { ok: true, config: this.globalConfig } };
    }

    const pluginM = p.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
    if (method === 'POST' && pluginM) {
      const [, id, act] = pluginM;
      this.pushConfig({ plugins: { [id]: act === 'enable' } });
      return { status: 200, body: { ok: true, pluginId: id, enabled: act === 'enable' } };
    }

    if (method === 'GET' && p === '/api/sessions') {
      let sessions = this.cache.getSessionList();
      if (appRegistry?.enabled) {
        sessions = sessions.filter(s =>
          appRegistry.canAccess(callerAppId, this.getTabApp(s.tabId))
        );
      }
      return { status: 200, body: sessions };
    }

    const sessionM = p.match(/^\/api\/sessions\/(\d+)$/);
    if (method === 'GET' && sessionM) {
      const tabId = parseInt(sessionM[1]);
      if (appRegistry?.enabled && !appRegistry.canAccess(callerAppId, this.getTabApp(tabId))) {
        return { status: 403, body: { error: 'Access denied: this tab belongs to another app' } };
      }
      const d = this.cache.getSessionData(tabId);
      return d ? { status: 200, body: d } : { status: 404, body: { error: 'Not found' } };
    }

    // GET /api/sessions/:tabId/states  — list all state graph nodes
    const statesM = p.match(/^\/api\/sessions\/(\d+)\/states$/);
    if (method === 'GET' && statesM) {
      const tabId = parseInt(statesM[1]);
      const sessionData = this.cache.getSessionData(tabId);
      if (!sessionData) return { status: 404, body: { error: 'Session not found' } };
      const siteVersion = sessionData.siteVersion;
      const states = this.stateMachine.store?.getAllNodesFlat ? this.stateMachine.store.getAllNodesFlat({ siteVersion, limit: 999 }) : [];
      return { status: 200, body: states };
    }

    // GET /api/sessions/:tabId/states/:hash  — single state detail
    const stateHashM = p.match(/^\/api\/sessions\/(\d+)\/states\/([^/]+)$/);
    if (method === 'GET' && stateHashM) {
      const tabId = parseInt(stateHashM[1]);
      const hash = stateHashM[2];
      const sessionData = this.cache.getSessionData(tabId);
      if (!sessionData) return { status: 404, body: { error: 'Session not found' } };
      const node = this.stateMachine.store?.getNodeByHash ? this.stateMachine.store.getNodeByHash(sessionData.siteVersion, hash) : null;
      return node ? { status: 200, body: node } : { status: 404, body: { error: 'State not found' } };
    }

    // GET /api/sessions/:tabId/raw/delta/smart.json  — smart delta data (in-memory)
    const deltaM = p.match(/^\/api\/sessions\/(\d+)\/raw\/delta\/smart\.json$/);
    if (method === 'GET' && deltaM) {
      const tabId = parseInt(deltaM[1]);
      const delta = this.cache.getSmartDelta ? this.cache.getSmartDelta(tabId) : null;
      return { status: 200, body: delta || { elapsed_ms: 0, frame_count: 0, motion_groups: [], _patterns: { new: null, known: null } } };
    }

    const fileM = p.match(/^\/api\/sessions\/(\d+)\/(.+)$/);
    if (method === 'GET' && fileM) {
      const tabId = parseInt(fileM[1]);
      const dir = this.cache.getSessionDir(tabId);
      if (!dir) return { status: 404, body: { error: 'Session not found' } };
      const filePart = fileM[2].replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
      return { status: 200, file: `${dir}/${filePart}` };
    }

    if (method === 'POST' && p === '/api/collect') {
      this.triggerCollect(body?.tabId || null, body?.plugins || null);
      return { status: 200, body: { ok: true } };
    }

    if (method === 'POST' && p === '/api/action') {
      const id = `act_${Date.now()}`;
      const result = this.actions.execute(body?.tabId, body?.action, body?.timeoutMs);
      return { status: 200, body: result, actionId: id };
    }

    // POST /api/sessions/:tabId/pin  — toggle session keep flag
    const pinM = p.match(/^\/api\/sessions\/(\d+)\/pin$/);
    if (method === 'POST' && pinM) {
      const tabId = parseInt(pinM[1]);
      this.cache.setSessionKeep(tabId, true);
      return { status: 200, body: { ok: true, tabId, keep: true } };
    }
    if (method === 'DELETE' && pinM) {
      const tabId = parseInt(pinM[1]);
      this.cache.setSessionKeep(tabId, false);
      return { status: 200, body: { ok: true, tabId, keep: false } };
    }

    // DELETE /api/sessions/:tabId  — remove session entirely
    if (method === 'DELETE' && sessionM) {
      const tabId = parseInt(sessionM[1]);
      this.cache.removeSession(tabId);
      this._tabDisconnectedAt.delete(tabId);
      this.broadcastToDashboard({ type: 'SESSION_REMOVED', tabId });
      return { status: 200, body: { ok: true, tabId } };
    }

    if (method === 'GET' && p === '/api/graphs') {
      return { status: 200, body: this.stateMachine.getAllGraphs() };
    }

    return { status: 404, body: { error: 'Not found', path: p } };
  }


  // ── Intelligence Layer helpers ──────────────────────────────────────────────

  // Slice 3 — record a runtime→source correlation observed in a FRAMEWORK_DOM_MAP
  // message. Passive + best-effort: needs uploaded source and a named component.
  // Prefers the React debug-source hint (exact) over a symbol-name match. The
  // correlation map thus fills in as whiskor watches the page, so the agent's later
  // get_source_context({component}) resolves instantly with no extra round-trip.
  _recordObservedCorrelation(payload) {
    if (!this.sourceIndex || !this.sourceCorrelations) return;
    const comp = payload && payload.component;
    if (!comp || !comp.name) return;
    const projectId = this.sourceIndex.listProjects()[0];
    if (!projectId) return;
    try {
      this.sourceCorrelations.correlate(projectId, comp.name, this.sourceIndex, {
        file: comp.sourceFile || null,
        line: typeof comp.sourceLine === 'number' ? comp.sourceLine : null,
      });
    } catch (_) { /* best-effort observation; never break routing */ }
  }

  _persistIntelligenceData(tabId, filename, data) {
    const sessionDir = this.cache.getSessionDir ? this.cache.getSessionDir(tabId) : null;
    if (!sessionDir || !data) return;
    try {
      const fs   = require('fs');
      const path = require('path');
      const dir  = path.join(sessionDir, 'raw', 'intelligence');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      // Non-fatal: best-effort persistence
    }
  }

  _persistCausalChains(tabId, newChains) {
    const sessionDir = this.cache.getSessionDir ? this.cache.getSessionDir(tabId) : null;
    if (!sessionDir || !newChains.length) return;
    try {
      const fs   = require('fs');
      const path = require('path');
      const dir  = path.join(sessionDir, 'raw', 'intelligence');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fpath  = path.join(dir, 'causal-chains.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch (_) {}
      const merged = [...existing, ...newChains]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 500); // maxChainsPerSession
      fs.writeFileSync(fpath, JSON.stringify(merged, null, 2), 'utf8');
    } catch (_) {}
  }

  _appendSourceChanges(tabId, changed) {
    const sessionDir = this.cache.getSessionDir ? this.cache.getSessionDir(tabId) : null;
    if (!sessionDir || !changed.length) return;
    try {
      const fs   = require('fs');
      const path = require('path');
      const dir  = path.join(sessionDir, 'raw', 'intelligence');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fpath  = path.join(dir, 'source-changes.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch (_) {}
      const merged = [...existing, ...changed].slice(-200);
      fs.writeFileSync(fpath, JSON.stringify(merged, null, 2), 'utf8');
    } catch (_) {}
  }

  // ── Stale session cleanup ──────────────────────────────────────────────────
  _cleanupStaleSessions() {
    const now = Date.now();
    for (const [tabId, disconnectedAt] of this._tabDisconnectedAt) {
      if (now - disconnectedAt > DISCONNECT_CLEANUP_MS) {
        // Skip pinned sessions
        const s = this.cache.getSessionData(tabId);
        if (s && s.keep) continue;
        this.cache.removeSession(tabId);
        this._tabDisconnectedAt.delete(tabId);
      }
    }
  }
}

module.exports = { WhiskorCore };
