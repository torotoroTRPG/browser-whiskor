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

class WhiskorCore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.swSockets = new Set();
    this.dashboardSockets = new Set();
    this._pendingActions = new Map();
    this._wsToTabs = new Map();       // WebSocket → Set<tabId>
    this._tabDisconnectedAt = new Map(); // tabId → timestamp

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

  broadcastToDashboard(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
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
  handleSWConnect(ws, config) {
    this.swSockets.add(ws);
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
    this.emit('message', msg, fromWs);
    // Track which tabIds belong to this WebSocket for cleanup
    if (msg.tabId && fromWs) {
      if (!this._wsToTabs.has(fromWs)) this._wsToTabs.set(fromWs, new Set());
      this._wsToTabs.get(fromWs).add(msg.tabId);
      this._tabDisconnectedAt.delete(msg.tabId); // reconnected
    }

    switch (msg.type) {
      // Data collection → cache + dashboard
      case 'FRAMEWORK_DETECTION':
      case 'REACT_SNAPSHOT':
      case 'VUE_SNAPSHOT':
      case 'VUE2_SNAPSHOT':
      case 'ANGULAR_SNAPSHOT':
      case 'SVELTE_SNAPSHOT':
      case 'DOM_GENERIC_SNAPSHOT':
      case 'SHADOW_DOM_SNAPSHOT':
      case 'DOM_SNAPSHOT':
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
        await this.cache.handleMessage(msg);
        this.broadcastToDashboard(msg);
        break;

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

    if (method === 'GET' && p === '/health') {
      return { status: 200, body: { ok: true, wsConnections: this.swSockets.size, sessions: this.cache.getSessionList().length, pendingActions: this.actions.pendingCount() } };
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
      return { status: 200, body: this.cache.getSessionList() };
    }

    const sessionM = p.match(/^\/api\/sessions\/(\d+)$/);
    if (method === 'GET' && sessionM) {
      const d = this.cache.getSessionData(parseInt(sessionM[1]));
      return d ? { status: 200, body: d } : { status: 404, body: { error: 'Not found' } };
    }

    const fileM = p.match(/^\/api\/sessions\/(\d+)\/(.+)$/);
    if (method === 'GET' && fileM) {
      const tabId = parseInt(fileM[1]);
      const dir = this.cache.getSessionDir(tabId);
      if (!dir) return { status: 404, body: { error: 'Session not found' } };
      // File reading is handled by the real server
      return { status: 200, file: `${dir}/${fileM[2]}` };
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
