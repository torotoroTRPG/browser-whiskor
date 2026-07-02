/**
 * server-fixture.js
 * Starts and stops a real server instance for integration/unit tests.
 * Uses test ports: WS=17891, HTTP=17892
 *
 * Now wraps the real WhiskorCore (server/core.js) for accurate coverage.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import { WhiskorCore } from '../../server/core.js';

const TEST_WS_PORT   = 17891;
const TEST_HTTP_PORT = 17892;
const TEST_CACHE_DIR = 'tests/tmp/cache';

/**
 * Minimal in-process server fixture that wraps WhiskorCore.
 * Exposes the internal socket sets and event emitter so tests
 * can assert on server-side state without extra HTTP round-trips.
 */
export class ServerFixture extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.wsPort   = opts.wsPort   ?? TEST_WS_PORT;
    this.httpPort = opts.httpPort ?? TEST_HTTP_PORT;
    this.cacheDir = opts.cacheDir ?? TEST_CACHE_DIR;

    /** @type {Set<import('ws').WebSocket>} */
    this.swSockets        = new Set();
    /** @type {Set<import('ws').WebSocket>} */
    this.dashboardSockets = new Set();

    this._wss  = null;
    this._http = null;
    this._pendingActions = new Map();

    // Create core with test-compatible stubs
    const fixture = this; // capture for closures
    this._core = new WhiskorCore({
      cache: {
        handleMessage() {},
        getSessionList() { return []; },
        getSessionData() { return null; },
        getSessionDir() { return null; },
        readSessionFile() { return null; },
        storeSmartDelta() {},
      },
      actions: {
        handleResult(msg) {
          const pending = fixture._pendingActions.get(msg.id);
          if (pending) {
            pending.resolve(msg.result);
            fixture._pendingActions.delete(msg.id);
          }
        },
        execute() { return { ok: false, error: 'No browser connected' }; },
        pendingCount() { return 0; },
        setBroadcast() {},
      },
      screenshots: {
        handleResult() {},
        capture() { return { ok: false, error: 'No screenshots' }; },
        setBroadcast() {},
      },
      stateMachine: {
        // Recording stub: tests assert the state-graph write path actually ran
        // (multi-tab.test.js previously sent a payload shape the real handler
        // ignored, so addNode was never exercised and nobody noticed).
        calls: [],
        addNode(siteVersion, data) { this.calls.push({ fn: 'addNode', siteVersion, data }); return data; },
        addEdge(siteVersion, data) { this.calls.push({ fn: 'addEdge', siteVersion, data }); return data; },
        getUnvisitedActions() { return []; },
        getAllGraphs() { return []; },
      },
      stateNavigator: {
        handleHashReport() {},
      },
      deltaEngine: {
        addFrame() { return null; },
      },
    });

    // Wire up fixture's socket sets to core's sets
    this._core.swSockets = this.swSockets;
    this._core.dashboardSockets = this.dashboardSockets;

    // Forward core events
    this._core.on('sw:connect', (ws) => this.emit('sw:connect', ws));
    this._core.on('sw:disconnect', () => this.emit('sw:disconnect'));
    this._core.on('dashboard:connect', (ws) => this.emit('dashboard:connect', ws));
    this._core.on('dashboard:disconnect', () => this.emit('dashboard:disconnect'));
    this._core.on('message', (msg, ws) => this.emit('message', msg, ws));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    await this._startHttp();
    await this._startWs();
  }

  async stop() {
    await Promise.all([
      new Promise(r => this._wss?.close(r)  ?? r()),
      new Promise(r => this._http?.close(r) ?? r()),
    ]);
    this.swSockets.clear();
    this.dashboardSockets.clear();
  }

  // ── WebSocket server ───────────────────────────────────────────────────────

  _startWs() {
    return new Promise((resolve, reject) => {
      this._wss = new WebSocketServer({ port: this.wsPort });
      this._wss.on('connection', (ws, req) => this._onConnect(ws, req));
      this._wss.once('listening', resolve);
      this._wss.once('error', reject);
    });
  }

  _onConnect(ws, req) {
    const isSW = req.url?.includes('sw=1');
    if (isSW) {
      this._core.handleSWConnect(ws, this._core.globalConfig);
    } else {
      this._core.handleDashboardConnect(ws, [], this._core.globalConfig);
    }
  }

  broadcastToDashboard(msg) {
    this._core.broadcastToDashboard(msg);
  }

  broadcastToSW(msg) {
    this._core.broadcast(msg);
  }

  /** Test-only: direct message routing (wraps core.routeMessage) */
  _route(msg, ws, _isFromSW) {
    this._core.routeMessage(msg, ws);
  }

  // ── HTTP server ────────────────────────────────────────────────────────────

  _startHttp() {
    return new Promise((resolve, reject) => {
      this._http = createServer((req, res) => this._handleHttp(req, res));
      this._http.listen(this.httpPort, resolve);
      this._http.once('error', reject);
    });
  }

  _handleHttp(req, res) {
    const url    = new URL(req.url, `http://localhost:${this.httpPort}`);
    const method = req.method.toUpperCase();

    // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const readBody = () => new Promise(r => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => r(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
    });

    const path = url.pathname;

    if (path === '/health' && method === 'GET') {
      json(200, { ok: true, wsConnections: this.swSockets.size + this.dashboardSockets.size, sessions: [] });
    } else if (path === '/api/config' && method === 'GET') {
      json(200, { mode: 'auto', plugins: {} });
    } else if (path === '/api/config' && method === 'POST') {
      readBody().then(body => {
        this._core.pushConfig(body);
        json(200, { ok: true });
      });
    } else if (path === '/api/sessions' && method === 'GET') {
      json(200, []);
    } else if (path === '/api/collect' && method === 'POST') {
      readBody().then(body => {
        this._core.triggerCollect(body.tabId);
        json(200, { ok: true });
      });
    } else if (path === '/api/action' && method === 'POST') {
      readBody().then(body => {
        const id = `act_${Date.now()}`;
        const timeout = setTimeout(() => {
          const p = this._pendingActions.get(id);
          p?.reject(new Error('Action timeout'));
          this._pendingActions.delete(id);
        }, 15_000);
        this._pendingActions.set(id, {
          resolve: result => { clearTimeout(timeout); json(200, { ok: true, result }); },
          reject:  err    => { clearTimeout(timeout); json(500, { ok: false, error: err.message }); },
        });
        this._core.broadcast({ type: 'EXECUTE_ACTION', id, tabId: body.tabId, action: body.action });
      });
    } else {
      json(404, { ok: false, error: 'Not found' });
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** State-graph writes recorded by the stateMachine stub (addNode/addEdge). */
  get stateGraphCalls() { return this._core.stateMachine.calls; }

  get wsUrl()   { return `ws://localhost:${this.wsPort}`; }
  get httpUrl() { return `http://localhost:${this.httpPort}`; }

  fetch(path, opts = {}) {
    return globalThis.fetch(`${this.httpUrl}${path}`, opts);
  }
}

/** Convenience factory: starts a server and returns { server, teardown }. */
export async function withServer(opts = {}) {
  const server = new ServerFixture(opts);
  await server.start();
  const teardown = () => server.stop();
  return { server, teardown };
}
