/**
 * server-fixture.js
 * Starts and stops a real server instance for integration/unit tests.
 * Uses test ports: WS=17891, HTTP=17892
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';

const TEST_WS_PORT   = 17891;
const TEST_HTTP_PORT = 17892;
const TEST_CACHE_DIR = 'tests/tmp/cache';

/**
 * Minimal in-process server fixture that mirrors server/index.js structure.
 * In a real project, import the actual server factory here:
 *   import { createWhiskorServer } from '../../server/index.js';
 *
 * This fixture exposes the internal socket sets and event emitter so tests
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
    this._pendingActions = new Map();  // id → { resolve, reject }
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
      this.swSockets.add(ws);
      this.emit('sw:connect', ws);
      ws.send(JSON.stringify({ type: 'SET_CONFIG', config: {} }));
    } else {
      this.dashboardSockets.add(ws);
      this.emit('dashboard:connect', ws);
      ws.send(JSON.stringify({ type: 'INIT', sessions: [] }));
    }

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        this._route(msg, ws, isSW);
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (isSW) {
        this.swSockets.delete(ws);
        this.emit('sw:disconnect');
      } else {
        this.dashboardSockets.delete(ws);
        this.emit('dashboard:disconnect');
      }
    });
  }

  _route(msg, fromWs, fromSW) {
    this.emit('message', msg, fromWs, fromSW);

    const broadcastable = [
      'TEXT_COORDS', 'VIEWPORT_UPDATE', 'TEXT_COORD_DELTA',
      'EXPLORER_STATE_UPDATE', 'REACT_TRANSITION', 'STATE_HASH_REPORT',
    ];

    if (broadcastable.includes(msg.type)) {
      this.broadcastToDashboard(msg);
    }

    if (msg.type === 'ACTION_RESULT') {
      const pending = this._pendingActions.get(msg.id);
      pending?.resolve(msg.result);
      this._pendingActions.delete(msg.id);
    }
  }

  broadcastToDashboard(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === 1 /* OPEN */) ws.send(raw);
    }
  }

  broadcastToSW(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.swSockets) {
      if (ws.readyState === 1) ws.send(raw);
    }
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

    // Route table
    const path = url.pathname;

    if (path === '/health' && method === 'GET') {
      json(200, { ok: true, wsConnections: this.swSockets.size + this.dashboardSockets.size, sessions: [] });
    } else if (path === '/api/config' && method === 'GET') {
      json(200, { mode: 'auto', plugins: {} });
    } else if (path === '/api/config' && method === 'POST') {
      readBody().then(body => {
        this.broadcastToSW({ type: 'SET_CONFIG', config: body });
        json(200, { ok: true });
      });
    } else if (path === '/api/sessions' && method === 'GET') {
      json(200, []);
    } else if (path === '/api/collect' && method === 'POST') {
      readBody().then(body => {
        this.broadcastToSW({ type: 'MANUAL_COLLECT', tabId: body.tabId });
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
        this.broadcastToSW({ type: 'EXECUTE_ACTION', id, tabId: body.tabId, action: body.action });
      });
    } else {
      json(404, { ok: false, error: 'Not found' });
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

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
