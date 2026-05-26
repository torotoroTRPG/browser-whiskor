/**
 * helpers/mock-extension.js
 * Simulates an extension Service Worker for integration tests.
 *
 * MockExtensionSW connects to the test server as an SW client and
 * automatically handles EXECUTE_ACTION, CAPTURE_SCREENSHOT, MANUAL_COLLECT,
 * and SET_CONFIG messages — mirroring what the real sw.js does.
 */

import { WSClient } from './ws-client.js';

export class MockExtensionSW {
  /**
   * @param {{ wsUrl: string }} server
   * @param {object} [opts]
   * @param {number}  [opts.tabId=1]           - Simulated active tab ID
   * @param {boolean} [opts.autoAck=true]       - Auto-reply ACTION_RESULT
   * @param {boolean} [opts.verbose=false]
   */
  constructor(server, opts = {}) {
    this._wsUrl    = server.wsUrl;
    this._tabId    = opts.tabId    ?? 1;
    this._autoAck  = opts.autoAck  ?? true;
    this._verbose  = opts.verbose  ?? false;
    this._client   = null;
    this._config   = {};
    this._msgQueue = [];    // messages seen (for assertions)
    this._collectCount = 0; // how many times collect was triggered
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect() {
    this._client = new WSClient(`${this._wsUrl}?sw=1`);
    await this._client.connect();
    // Consume handshake SET_CONFIG
    const cfg = await this._client.nextMessage(m => m.type === 'SET_CONFIG');
    this._config = cfg.config ?? {};
    // Start processing incoming messages
    this._client.ws.on('message', raw => this._handle(JSON.parse(raw.toString())));
    return this;
  }

  async close() {
    await this._client?.close();
  }

  // ── Incoming message handler ───────────────────────────────────────────────

  _handle(msg) {
    if (this._verbose) console.log('[MockSW ←]', msg.type);
    this._msgQueue.push(msg);

    switch (msg.type) {
      case 'SET_CONFIG':
        this._config = msg.config ?? {};
        break;

      case 'MANUAL_COLLECT':
        this._collectCount++;
        this._sendCollectData(msg.tabId ?? this._tabId);
        break;

      case 'EXECUTE_ACTION':
        if (this._autoAck) this._ackAction(msg);
        break;

      case 'CAPTURE_SCREENSHOT':
        if (this._autoAck) this._ackScreenshot(msg);
        break;
    }
  }

  // ── Outgoing helpers ───────────────────────────────────────────────────────

  /** Push a TEXT_COORDS update from the simulated page. */
  sendTextCoords(tabId = this._tabId, words = []) {
    this._send({
      type: 'TEXT_COORDS',
      tabId,
      url:      'http://localhost:17893/test-page.html',
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
      words:    words.length ? words : this._defaultWords(),
      timestamp: Date.now(),
    });
  }

  /** Push a VIEWPORT_UPDATE. */
  sendViewportUpdate(scrollX = 0, scrollY = 0, tabId = this._tabId) {
    this._send({ type: 'VIEWPORT_UPDATE', tabId, scrollX, scrollY, width: 1280, height: 800 });
  }

  /** Push a TEXT_COORD_DELTA (beacon change). */
  sendDelta(deltas = [], tabId = this._tabId) {
    this._send({ type: 'TEXT_COORD_DELTA', tabId, deltas, timestamp: Date.now() });
  }

  /** Push EXPLORER_STATE_UPDATE. */
  sendExplorerState(hash, label = 'Page', tabId = this._tabId) {
    this._send({ type: 'EXPLORER_STATE_UPDATE', tabId, hash, label, url: 'http://localhost/', timestamp: Date.now() });
  }

  /** Push REACT_TRANSITION. */
  sendReactTransition(fromHash, toHash, action = null) {
    this._send({ type: 'REACT_TRANSITION', fromHash, toHash, action, timestamp: Date.now() });
  }

  /** Push STATE_HASH_REPORT. */
  sendStateHashReport(hash, tabId = this._tabId) {
    this._send({ type: 'STATE_HASH_REPORT', tabId, hash, timestamp: Date.now() });
  }

  // ── Auto-reply helpers ─────────────────────────────────────────────────────

  _ackAction(msg) {
    this._send({ type: 'ACTION_RESULT', id: msg.id, result: { ok: true, tabId: msg.tabId } });
  }

  _ackScreenshot(msg) {
    this._send({
      type:     'SCREENSHOT_RESULT',
      id:       msg.id,
      dataUrl:  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      filePath: `/tmp/screenshot_${Date.now()}.png`,
    });
  }

  _sendCollectData(tabId) {
    this.sendTextCoords(tabId);
    this.sendViewportUpdate(0, 0, tabId);
  }

  _send(msg) {
    if (this._verbose) console.log('[MockSW →]', msg.type);
    this._client.send(msg);
  }

  _defaultWords() {
    return Array.from({ length: 20 }, (_, i) => ({
      id: 'w' + i, text: 'word' + i, x: 10 + i * 60, y: 100,
      width: 50, height: 16, fontSize: 14, color: '#333',
      xpath: `/html/body/p/span[${i+1}]`, inView: true,
    }));
  }

  // ── Assertions helpers ─────────────────────────────────────────────────────

  /** Messages of a given type seen by this SW. */
  received(type) { return this._msgQueue.filter(m => m.type === type); }

  /** Wait until at least one message of `type` has been received. */
  waitFor(type, timeoutMs = 2000) {
    return this._client.nextMessage(m => m.type === type, timeoutMs);
  }

  get config()       { return this._config; }
  get collectCount() { return this._collectCount; }
}

/**
 * Convenience: create and connect a MockExtensionSW.
 */
export async function createMockSW(server, opts = {}) {
  const sw = new MockExtensionSW(server, opts);
  await sw.connect();
  return sw;
}
