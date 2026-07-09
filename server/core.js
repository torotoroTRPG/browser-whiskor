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

// Browser-internal pages where content scripts cannot run by policy — a tab on
// one of these has no whiskor session and never can, so get_sessions reports it
// as 'restricted' (not an actionable "reload me"). Used by getUninstrumentedTabs.
const RESTRICTED_URL_RE = /^(chrome|chrome-extension|edge|brave|about|view-source|devtools|moz-extension|resource|chrome-search|chrome-untrusted):/i;
function isRestrictedUrl(url) {
  const u = String(url || '');
  if (!u) return true; // no URL we can act on
  if (RESTRICTED_URL_RE.test(u)) return true;
  // The web stores also block content scripts.
  return /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(u);
}

// Server version for the extension version handshake (EXT_HELLO). Extension
// manifests are kept in lockstep with package.json by sync-version, so a
// differing extension version means its on-disk files are stale.
const SERVER_VERSION = require('../package.json').version;

const { generateAsciiGraph } = require('./state-visualizer');

class WhiskorCore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.swSockets = new Set();
    this.dashboardSockets = new Set();
    this.logSubscribers = new Set();  // For dashboard log subscriptions
    this._pendingActions = new Map();
    this._pendingCaptures = new Map(); // reqId → { resolve, timer, tabId } (DevTools source capture)
    this._wsToTabs = new Map();       // WebSocket → Set<tabId>
    this._tabDisconnectedAt = new Map(); // tabId → timestamp
    this._wsToApp  = new Map();       // WebSocket → appId (null = unregistered/public)
    this._tabToApp = new Map();       // tabId    → appId
    this._wsToExtInfo = new Map();    // WebSocket → { browser, version } from EXT_HELLO
    this._tabInventory = [];          // latest full browser tab list (TAB_INVENTORY push)
    this._tabInventoryAt = 0;         // when it was last reported
    this._updateStatus = null;        // startup update-check result (see update-checker.js), surfaced on /health
    // Recent server log lines (everything routed through index.js log()).
    // Powers GET /api/logs so the shell/TUI can show and export server logs.
    this._logBuffer = [];
    this._logBufferMax = 2000;
    // Stale versions we already asked to reload — once per version per process.
    // If the on-disk files are still old, reloading again changes nothing; this
    // guard turns a would-be reload loop into a single attempt + warning.
    this._extReloadAskedVersions = new Set();
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
    // Premise-change feed: per-tab ring buffer of EXTERNAL changes (outside every
    // agent action window), piggybacked on the next tool response. Null = disabled.
    this.changeFeed       = opts.changeFeed       || null;

    this.globalConfig = opts.initialConfig || {
      mode: 'always_on',
      plugins: {},
      options: {
        textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000, includeFormValues: false },
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

  // Ask the DevTools panel on this tab to capture all page resources via
  // getResources() (which reads the browser cache, so it bypasses the CORS
  // limits that block the page-context source-fetcher) and ingest them as
  // SOURCE_CONTENT. The file contents ride the normal SOURCE_CONTENT path; this
  // promise resolves with a summary once the panel acks (SOURCE_CAPTURE_DONE),
  // or { ok:false } on timeout / no panel open. Agent-facing entry point shared
  // by POST /api/source/capture and the capture_sources MCP tool.
  requestSourceCapture(tabId, opts = {}) {
    return new Promise((resolve) => {
      const reqId = 'cap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        this._pendingCaptures.delete(reqId);
        resolve({
          ok: false, error: 'capture_timeout', tabId,
          hint: 'No DevTools panel responded. Open the browser-whiskor DevTools panel on the target tab — getResources() requires DevTools to be open.',
        });
      }, opts.timeoutMs || 15000);
      this._pendingCaptures.set(reqId, { resolve, timer, tabId });
      this.sendToTab({ type: 'SOURCE_CAPTURE_REQUEST', reqId, tabId, opts });
    });
  }

  broadcastToDashboard(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  // Store the startup update-check result for /health (and the dashboard banner).
  setUpdateStatus(status) {
    this._updateStatus = status || null;
  }

  broadcastLog(level, ...args) {
    const message = args.join(' ');
    const ts = Date.now();
    this._logBuffer.push({ ts, level, message });
    if (this._logBuffer.length > this._logBufferMax) {
      this._logBuffer.splice(0, this._logBuffer.length - this._logBufferMax);
    }
    const raw = JSON.stringify({ type: 'LOG_ENTRY', level, message, ts });
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

  /**
   * Ask every connected extension to reload itself (chrome.runtime.reload()).
   * Used after `whk setup` refreshes the managed extension files. Returns the
   * number of sockets the request was sent to. Carries no paths — the managed
   * directory never crosses the wire.
   */
  requestExtensionReload(reason = 'manual') {
    const raw = JSON.stringify({ type: 'RELOAD_EXTENSION', reason, serverVersion: SERVER_VERSION });
    let sent = 0;
    for (const ws of this.swSockets) {
      if (ws.readyState === 1) {
        try { ws.send(raw); sent++; } catch (_) {}
      }
    }
    return sent;
  }

  // ── WebSocket connection handling ───────────────────────────────────────────

  /** Returns the appId associated with a given tabId (null if unregistered). */
  getTabApp(tabId) {
    return this._tabToApp.get(tabId) ?? null;
  }

  /**
   * Tabs that exist in the browser (last TAB_INVENTORY push) but have no whiskor
   * session — i.e. the agent can't see or act on them via get_sessions. Each is
   * classified so the agent knows whether it's actionable:
   *   - 'restricted'   : a browser-internal page (chrome://, extensions, web store,
   *                      about:, view-source, devtools) — content scripts can't run
   *                      there by browser policy. Not fixable.
   *   - 'reload_needed': a normal page with no session — usually opened before the
   *                      extension loaded; reloading the tab instruments it.
   * @param {number[]} sessionTabIds - tabIds that DO have a session
   * @returns {Array<{tabId, url, title, reason}>}
   */
  getUninstrumentedTabs(sessionTabIds) {
    const have = new Set(sessionTabIds || []);
    return (this._tabInventory || [])
      .filter(t => t && typeof t.tabId === 'number' && !have.has(t.tabId))
      .map(t => ({
        tabId: t.tabId,
        url:   t.url || '',
        title: t.title || '',
        reason: isRestrictedUrl(t.url) ? 'restricted' : 'reload_needed',
      }));
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
      this._wsToExtInfo.delete(ws);
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

      // Full browser tab list from the extension (pushed on connect + tab changes).
      // Lets get_sessions warn about tabs that exist but aren't instrumented —
      // restricted pages or tabs that need a reload — which otherwise have no
      // session at all and are invisible to the agent.
      case 'TAB_INVENTORY':
        this._tabInventory = Array.isArray(msg.tabs) ? msg.tabs : [];
        this._tabInventoryAt = Date.now();
        break;

      // The browser tab was closed (tabs.onRemoved in the extension). Mark the
      // session closed — get_sessions shows `closed: true` and the cache sweep
      // removes it after the closed-session retention window — and drop the
      // tab's capture caches immediately (a closed tab can never be recaptured).
      case 'TAB_CLOSED':
        if (msg.tabId != null) {
          if (typeof this.cache.markSessionClosed === 'function') this.cache.markSessionClosed(msg.tabId);
          this.somCache.evictTab(msg.tabId);
          this.somThumbs.evictTab(msg.tabId);
          if (this.changeFeed) this.changeFeed.dropTab(msg.tabId); // a closed tab has no premise left
          this.broadcastToDashboard(msg);
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
        // External navigation (agent navigations happen inside an action window
        // and are filtered by the feed's attribution rule).
        if (this.changeFeed && msg.payload?.url) {
          this.changeFeed.record(msg.tabId, { kind: 'navigate', note: `navigated: now at ${String(msg.payload.url).slice(0, 200)}` });
        }
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
        // Modal boundary → premise-change feed (flags set by the dom-mutations
        // analyzer; external-only per the feed's attribution rule).
        if (this.changeFeed && Array.isArray(msg.payload?.records)) {
          for (const r of msg.payload.records) {
            if (r && r.dialogAppeared) this.changeFeed.record(_mutTabId, { kind: 'modal', note: `modal opened: ${r.dialogSelector || r.targetSelector || 'dialog'}` });
            else if (r && r.dialogRemoved) this.changeFeed.record(_mutTabId, { kind: 'modal', note: `modal closed: ${r.dialogSelector || r.targetSelector || 'dialog'}` });
          }
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
        // External scroll → feed, coalesced: a burst stays ONE line whose `to` is
        // the final position and whose `from` is what the agent last knew.
        if (this.changeFeed && (Number.isFinite(payload.scrollX) || Number.isFinite(payload.scrollY))) {
          this.changeFeed.record(msg.tabId, { kind: 'scroll', key: 'scroll', data: {
            from: prevVp ? { x: prevVp.scrollX, y: prevVp.scrollY } : null,
            to:   { x: payload.scrollX, y: payload.scrollY },
          } });
        }
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
        // Flat-payload wire shape used by tests/dashboards. The live injected
        // explorer speaks EXPLORER_GET_NEXT_ACTION below; both funnel into
        // _recordExplorerState (node write + next-action reply).
        const p = msg.payload || {};
        this._recordExplorerState(msg, fromWs, {
          siteVersion: p.siteVersion,
          hash: p.currentHash,
          reactHash: p.reactHash,
          domHash: p.domHash,
          url: p.url,
          title: p.title,
          uiCatalog: p.uiCatalog,
        });
        this.broadcastToDashboard(msg);
        break;
      }

      // Live protocol of injected/explorer.js: the exploration loop polls with
      // its current composite hash + ui-catalog and expects an
      // EXPLORER_NEXT_ACTION reply (which the SW relays into the MAIN world).
      // Until this case existed the poll fell through to `default` and the
      // autonomous explorer never received an answer.
      case 'EXPLORER_GET_NEXT_ACTION': {
        const p = msg.payload || {};
        this._recordExplorerState(msg, fromWs, {
          siteVersion: msg.siteVersion || p.siteVersion,
          hash: p.stateHash,
          reactHash: p.reactHash,
          domHash: p.domHash,
          url: msg.tabUrl, // bridge-trusted; the explorer doesn't send a url
          title: null,
          uiCatalog: p.uiCatalog,
        });
        this.broadcastToDashboard(msg);
        break;
      }

      // Explorer hit a state-revisit loop and is backtracking — surface it on
      // the dashboard (and keep the producer/consumer contract test honest).
      case 'EXPLORER_LOOP_DETECTED':
        this.broadcastToDashboard(msg);
        break;

      case 'REACT_TRANSITION': {
        // No graph write here: from/to are REACT hashes, while nodes are keyed
        // by COMPOSITE hashes — edges written in the react keyspace can never
        // join a node and accumulate as permanent orphans (the pre-S0 bug that
        // left every passively-browsed graph at nodeCount:0). Graph writes
        // happen on STATE_TRANSITION below, in the composite keyspace.
        // Feed to correlator — framework transitions improve causal-chain
        // Rule 2/3, and that use is keyspace-agnostic.
        if (this.correlator) {
          const newChains = this.correlator.addMessage(msg);
          if (newChains?.length) this._persistCausalChains(msg.tabId, newChains);
        }
        this.broadcastToDashboard(msg);
        break;
      }

      // Passive state-graph writer: the always-on hash engine in
      // state-reporter.js reports each SETTLED composite-hash transition
      // during normal browsing. Explorer runs remain a denser variant of the
      // same write path (_recordExplorerState).
      case 'STATE_TRANSITION': {
        const p = msg.payload || {};
        const sv = msg.siteVersion || p.siteVersion;
        const okHash = (h) => typeof h === 'string' && h.length > 0 && h.length <= 128;
        if (!sv || typeof sv !== 'string' || !okHash(p.to)) {
          this.broadcastToDashboard(msg);
          break;
        }

        // Same trust model as _recordExplorerState: everything in the payload
        // is page-influenced; the url is clamped to the bridge-verified origin
        // and the write itself is origin-bound in state-store.
        const origin = this._pageOrigin(msg);
        let safeUrl = p.url || msg.tabUrl || null;
        if (origin && safeUrl) {
          try { if (new URL(safeUrl).origin !== origin) safeUrl = msg.tabUrl; }
          catch (_) { safeUrl = msg.tabUrl; }
        }

        const node = this.stateMachine.addNode(sv, {
          hash: p.to,
          reactHash: okHash(p.reactHash) ? p.reactHash : null,
          domHash: okHash(p.domHash) ? p.domHash : p.to,
          url: safeUrl,
          title: typeof p.title === 'string' ? p.title.slice(0, 300) : null,
          origin,
        });

        if (node !== null && okHash(p.from) && p.from !== p.to) {
          // Edge action, best evidence first: a recent click gives a real
          // replayable trigger; a URL change replays as navigate; anything
          // else is recorded as a non-replayable observation (it still shapes
          // the graph and feeds reverse-edge candidates, but findPath must
          // never try to execute it).
          const inter = p.interaction;
          const fromUrl = this.stateMachine.store?.getNodeByHash?.(sv, p.from)?.url || null;
          let action = 'observed', trigger = null, replayAction = null, replayable = false;
          if (inter && inter.type === 'click' && typeof inter.text === 'string' && inter.text.trim()) {
            action = 'click';
            trigger = inter.text.trim().slice(0, 80);
            replayAction = { type: 'click', text: trigger };
            replayable = true;
          } else if (fromUrl && safeUrl && fromUrl !== safeUrl) {
            action = 'navigate';
            trigger = safeUrl;
            replayAction = { type: 'navigate', url: safeUrl };
            replayable = true;
          }
          this.stateMachine.addEdge(sv, {
            from: p.from, to: p.to, action, trigger, replayAction, replayable, origin,
          });
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
        const sv = siteVersion || msg.siteVersion;
        if (sv && from) {
          this.stateMachine.addEdge(sv, { from, to, action: act, trigger, origin: this._pageOrigin(msg) });
        }
        break;
      }

      case 'PING':
        fromWs.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        break;

      // Version handshake sent by the extension right after the WS opens.
      // Manifest versions track package.json (sync-version), so a mismatch
      // means the extension's on-disk files are stale relative to this server.
      case 'EXT_HELLO': {
        const info = { browser: msg.browser || 'unknown', version: msg.version || null };
        this._wsToExtInfo.set(fromWs, info);
        if (info.version && info.version !== SERVER_VERSION) {
          const autoReload = this.globalConfig?.extensionUpdate?.autoReload !== false;
          if (autoReload && !this._extReloadAskedVersions.has(info.version)) {
            this._extReloadAskedVersions.add(info.version);
            console.warn(`[ext] ${info.browser} extension v${info.version} != server v${SERVER_VERSION} — requesting reload to pick up updated files`);
            try {
              fromWs.send(JSON.stringify({ type: 'RELOAD_EXTENSION', reason: 'version_mismatch', serverVersion: SERVER_VERSION }));
            } catch (_) {}
          } else {
            console.warn(`[ext] ${info.browser} extension v${info.version} != server v${SERVER_VERSION} — still stale after reload request. Refresh its files (whk setup) and reload it in the browser.`);
          }
        }
        break;
      }

      case 'SOURCE_CAPTURE_DONE': {
        // Ack for requestSourceCapture(). The file contents (if any) already
        // arrived separately as SOURCE_CONTENT; this just resolves the waiter.
        const p = this._pendingCaptures.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          this._pendingCaptures.delete(msg.reqId);
          p.resolve({
            ok: msg.ok !== false,
            stored: msg.stored ?? null,
            count: msg.count ?? null,
            error: msg.error || null,
            tabId: msg.tabId,
          });
        }
        break;
      }

      default:
        this.emit('unknown', msg);
    }
  }

  /**
   * The one identity a page cannot forge: its own URL, stamped as tabUrl by the
   * bridge (ISOLATED world) on every relayed collector message. Returns the
   * origin, or null when the message didn't come through the bridge (tests,
   * direct WS clients) — callers then skip origin enforcement.
   */
  _pageOrigin(msg) {
    if (!msg || !msg.tabUrl) return null;
    try { return new URL(msg.tabUrl).origin; } catch (_) { return null; }
  }

  /**
   * Shared state-graph write + next-action reply for EXPLORER_STATE_UPDATE and
   * EXPLORER_GET_NEXT_ACTION. All identity fields here (siteVersion, hashes,
   * url) arrive page-influenced, so: hashes are shape-checked, the node url is
   * clamped to the tab's bridge-verified origin, and the graph write itself is
   * origin-bound in state-store (a page can only poison the graph of its own
   * origin — which it could do anyway by lying about its DOM).
   */
  _recordExplorerState(msg, fromWs, { siteVersion, hash, reactHash, domHash, url, title, uiCatalog }) {
    const okHash = (h) => typeof h === 'string' && h.length > 0 && h.length <= 128;
    if (!siteVersion || typeof siteVersion !== 'string' || !okHash(hash)) return;

    const origin = this._pageOrigin(msg);
    let safeUrl = url || msg.tabUrl || null;
    if (origin && safeUrl) {
      try { if (new URL(safeUrl).origin !== origin) safeUrl = msg.tabUrl; }
      catch (_) { safeUrl = msg.tabUrl; }
    }

    const reactSnapshot = this.cache.readSessionFile(msg.tabId, 'raw/react_snapshot.json');
    const node = this.stateMachine.addNode(siteVersion, {
      hash,
      reactHash: okHash(reactHash) ? reactHash : null,
      domHash: okHash(domHash) ? domHash : hash,
      url: safeUrl,
      title: title || null,
      uiCatalog,
      reactState: reactSnapshot || null,
      origin,
    });
    if (node === null) return; // graph belongs to another origin — rejected

    if (uiCatalog) {
      const candidates = this.stateMachine.getUnvisitedActions(siteVersion, hash, uiCatalog);
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
  }

  /**
   * Find a state node by hash — try the given siteVersion first, then every
   * graph. Session siteVersion and graph keys can drift apart (see the
   * /api/sessions/:tabId/states fallback), so a session-scoped detail lookup
   * must not miss a node that visibly exists in /api/graphs.
   */
  _findStateNode(siteVersion, hash) {
    const store = this.stateMachine.store;
    if (!store?.getNodeByHash) return null;
    const direct = store.getNodeByHash(siteVersion, hash);
    if (direct) return direct;
    for (const g of this.stateMachine.getAllGraphs() || []) {
      const n = store.getNodeByHash(g.siteVersion, hash);
      if (n) return n;
    }
    return null;
  }

  /**
   * Resolve a graph siteVersion for /map — try the session's own siteVersion
   * first, then fall back to the graph with the most nodes (same drift as
   * /api/sessions/:tabId/states, but a single "best" graph instead of all of them).
   */
  _resolveGraphSiteVersion(sessionSiteVersion) {
    const store = this.stateMachine.store;
    const own = store?.getGraph?.(sessionSiteVersion);
    if (own && Object.keys(own.nodes || {}).length > 0) return sessionSiteVersion;
    const graphs = this.stateMachine.getAllGraphs() || [];
    if (!graphs.length) return sessionSiteVersion;
    const best = graphs.reduce((a, b) => (b.nodeCount > a.nodeCount ? b : a));
    // getAllGraphs() can report graphs loaded straight from disk without
    // caching them — load it into the in-memory map so generateAsciiGraph
    // (which reads via getGraph) can actually find it.
    store?.getOrCreate?.(best.siteVersion);
    return best.siteVersion;
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
        // Connected extension(s) as reported by EXT_HELLO — browser + version
        // only, never an install path.
        extensions: [...this._wsToExtInfo.values()],
        sessions: this.cache.getSessionList().length,
        pendingActions: this.actions.pendingCount(),
        // Secret-guard status — counts only, never the secret values.
        secretGuard: {
          active:      !!(sg && sg.active),
          knownValues: (sg && sg.count) || 0,
          patterns:    (sg && sg.patternCount) || 0,
          refs:        (sg && sg.refCount) || 0,
        },
        // Startup update check (update-checker.js). null until it has run or if
        // disabled. { current, latest, updateAvailable, tag, url } when it ran.
        update: this._updateStatus,
        // dev-exec mode (dev-gate.js). Runtime state, always OFF after a restart.
        // Paths are never disclosed — roots is a count. See dev-exec.md 7.2.
        dev: require('./dev-gate').status(),
      } };
    }

    if (method === 'GET' && p === '/api/config') {
      return { status: 200, body: this.globalConfig };
    }

    if (method === 'POST' && p === '/api/config') {
      this.pushConfig(body);
      return { status: 200, body: { ok: true, config: this.globalConfig } };
    }

    // Recent server log lines (ring buffer fed by broadcastLog). ?limit=N
    // caps the count (newest last), ?level=warn returns warn+error only.
    if (method === 'GET' && p === '/api/logs') {
      let logs = this._logBuffer;
      const level = url.searchParams?.get?.('level');
      if (level === 'warn')  logs = logs.filter(l => l.level === 'warn' || l.level === 'error');
      if (level === 'error') logs = logs.filter(l => l.level === 'error');
      const limit = parseInt(url.searchParams?.get?.('limit'), 10);
      if (Number.isFinite(limit) && limit > 0) logs = logs.slice(-limit);
      return { status: 200, body: logs };
    }

    // Browser tabs that exist but have no whiskor session (restricted pages or
    // tabs needing a reload). Shared by get_sessions in both direct and proxy mode
    // (the MCP process has no core, so it fetches this from the worker over HTTP).
    if (method === 'GET' && p === '/api/uninstrumented-tabs') {
      // App isolation: the raw browser tab list isn't app-scoped, so don't leak
      // other apps' tab URLs across isolation boundaries — report nothing.
      if (appRegistry?.enabled) return { status: 200, body: { tabs: [] } };
      const sessionTabIds = this.cache.getSessionList({ brief: true }).map(s => s.tabId);
      return { status: 200, body: { tabs: this.getUninstrumentedTabs(sessionTabIds) } };
    }

    // Ask connected extension(s) to reload themselves — used by `whk setup`
    // after refreshing the managed extension files while a server is running.
    if (method === 'POST' && p === '/api/extension/reload') {
      const sent = this.requestExtensionReload(body?.reason || 'api');
      return { status: 200, body: { ok: true, sent } };
    }

    const pluginM = p.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
    if (method === 'POST' && pluginM) {
      const [, id, act] = pluginM;
      this.pushConfig({ plugins: { [id]: act === 'enable' } });
      return { status: 200, body: { ok: true, pluginId: id, enabled: act === 'enable' } };
    }

    // NOTE: GET /api/sessions (the list) is handled upstream in server/index.js
    // (session-list.selectSessions) because semantic search needs an awaited
    // backend and this non-action GET path serialises result.body without
    // awaiting. The sub-paths below (/:tabId, /:tabId/states, /map, ...) stay here.

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
      const store = this.stateMachine.store;
      if (!store?.getAllNodesFlat) return { status: 200, body: [] };
      // The session's siteVersion (cache-writer defaults to 'default') and the
      // graph key (named by the state reporter, e.g. 'v1') historically drift
      // apart. Rather than answering [] while /api/graphs shows nodes, fall
      // back to all graphs — same behaviour as the MCP list_states tool.
      let states = store.getAllNodesFlat({ siteVersion: sessionData.siteVersion, limit: 999 });
      if (!states.length) states = store.getAllNodesFlat({ limit: 999 });
      return { status: 200, body: states };
    }

    // GET /api/sessions/:tabId/states/:hash  — single state detail
    const stateHashM = p.match(/^\/api\/sessions\/(\d+)\/states\/([^/]+)$/);
    if (method === 'GET' && stateHashM) {
      const tabId = parseInt(stateHashM[1]);
      const hash = stateHashM[2];
      const sessionData = this.cache.getSessionData(tabId);
      if (!sessionData) return { status: 404, body: { error: 'Session not found' } };
      const node = this._findStateNode(sessionData.siteVersion, hash);
      return node ? { status: 200, body: node } : { status: 404, body: { error: 'State not found' } };
    }

    // GET /api/sessions/:tabId/map  — ASCII state-graph visualization for a
    // session's tab (best-effort: falls back to the graph with the most nodes
    // when the session's own siteVersion has none, same drift as /states above).
    // ?maxNodes= caps the rendered tree (default 40, max 200).
    const mapM = p.match(/^\/api\/sessions\/(\d+)\/map$/);
    if (method === 'GET' && mapM) {
      const tabId = parseInt(mapM[1]);
      const sessionData = this.cache.getSessionData(tabId);
      if (!sessionData) return { status: 404, body: { error: 'Session not found' } };
      const sv = this._resolveGraphSiteVersion(sessionData.siteVersion);
      let maxNodes = parseInt(url.searchParams?.get?.('maxNodes'), 10);
      if (!Number.isFinite(maxNodes) || maxNodes <= 0) maxNodes = 40;
      maxNodes = Math.min(maxNodes, 200);
      return { status: 200, body: { siteVersion: sv, graph: generateAsciiGraph(sv, maxNodes) } };
    }

    // GET /api/changes/:tabId — premise-change feed: EXTERNAL changes (outside
    // agent action windows) since the last drain. ?drain=1 reads AND clears
    // (what the MCP proxy uses for the _sinceYourLastLook piggyback); without it,
    // a non-destructive peek. In-memory only — see docs/ideas/PREMISE_CHANGE_FEED.md.
    const changesM = p.match(/^\/api\/changes\/(\d+)$/);
    if (method === 'GET' && changesM) {
      const tabId = parseInt(changesM[1]);
      if (!this.changeFeed) return { status: 200, body: { enabled: false, changes: [] } };
      const drain = url.searchParams?.get?.('drain');
      const changes = (drain === '1' || drain === 'true') ? this.changeFeed.drain(tabId) : this.changeFeed.peek(tabId);
      return { status: 200, body: { enabled: true, changes } };
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
      this.somCache.evictTab(tabId);   // drop the tab's packed-SoM + thumbnail cache
      this.somThumbs.evictTab(tabId);  // (defined for "tab closed" but was never called)
      this._tabDisconnectedAt.delete(tabId);
      this.broadcastToDashboard({ type: 'SESSION_REMOVED', tabId });
      return { status: 200, body: { ok: true, tabId } };
    }

    // GET /api/graphs/:siteVersion/states  — nodes of one state graph
    // (the natural follow-up to GET /api/graphs, no session lookup involved)
    const graphStatesM = p.match(/^\/api\/graphs\/([^/]+)\/states$/);
    if (method === 'GET' && graphStatesM) {
      const sv = decodeURIComponent(graphStatesM[1]);
      const store = this.stateMachine.store;
      if (!store?.getGraph || !store.getGraph(sv)) {
        return { status: 404, body: { error: `No graph for siteVersion "${sv}"` } };
      }
      return { status: 200, body: store.getAllNodesFlat({ siteVersion: sv, limit: 999 }) };
    }

    // GET /api/graphs/:siteVersion/states/:hash  — single node of one graph
    const graphStateHashM = p.match(/^\/api\/graphs\/([^/]+)\/states\/([^/]+)$/);
    if (method === 'GET' && graphStateHashM) {
      const sv = decodeURIComponent(graphStateHashM[1]);
      const node = this.stateMachine.store?.getNodeByHash
        ? this.stateMachine.store.getNodeByHash(sv, graphStateHashM[2])
        : null;
      return node ? { status: 200, body: node } : { status: 404, body: { error: 'State not found' } };
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
        this.somCache.evictTab(tabId);
        this.somThumbs.evictTab(tabId);
        this._tabDisconnectedAt.delete(tabId);
      }
    }
  }
}

module.exports = { WhiskorCore };
