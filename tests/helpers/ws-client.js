/**
 * ws-client.js
 * Promise-based WebSocket test client.
 * Provides a message queue so tests can await specific message types
 * without racing against earlier messages.
 */

import WebSocket from 'ws';

export class WSClient {
  /** @param {string} url */
  constructor(url) {
    this.url    = url;
    this.ws     = null;
    /** @type {object[]} */
    this._queue   = [];
    /** @type {Array<{ resolve: Function, reject: Function, filter: Function|null, timer: any }>} */
    this._waiters = [];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connect(timeoutMs = 3_000) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error(`WSClient: connect timeout (${this.url})`)), timeoutMs);

      this.ws.once('open', () => {
        clearTimeout(timer);
        this.ws.on('message', raw => this._dispatch(JSON.parse(raw.toString())));
        this.ws.on('error', () => {/* swallow post-connect errors */});
        resolve(this);
      });
      this.ws.once('error', err => { clearTimeout(timer); reject(err); });
    });
  }

  close() {
    return new Promise(resolve => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  send(msg) {
    this.ws.send(JSON.stringify(msg));
    return this;
  }

  /**
   * Returns the next message matching `filter` (or any message if omitted).
   * Checks the existing queue before waiting for a new one.
   *
   * @param {((msg: object) => boolean) | null} filter
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  nextMessage(filter = null, timeoutMs = 2_000) {
    // Drain from queue first
    const idx = filter
      ? this._queue.findIndex(filter)
      : (this._queue.length > 0 ? 0 : -1);

    if (idx !== -1) {
      return Promise.resolve(this._queue.splice(idx, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w.resolve !== resolve);
        reject(new Error(`WSClient: nextMessage timeout${filter ? ' (filtered)' : ''}`));
      }, timeoutMs);

      this._waiters.push({ resolve, reject, filter, timer });
    });
  }

  /** Consume and discard the next N messages (useful for clearing handshakes). */
  async flush(n = 1, timeoutMs = 1_000) {
    for (let i = 0; i < n; i++) {
      await this.nextMessage(null, timeoutMs).catch(() => {});
    }
    return this;
  }

  /** Collect all messages received within `durationMs`. */
  collect(durationMs = 200) {
    const msgs = [];
    const handler = raw => msgs.push(JSON.parse(raw.toString()));
    this.ws.on('message', handler);
    return new Promise(resolve =>
      setTimeout(() => { this.ws.off('message', handler); resolve(msgs); }, durationMs)
    );
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _dispatch(msg) {
    for (let i = 0; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      if (!w.filter || w.filter(msg)) {
        clearTimeout(w.timer);
        this._waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    this._queue.push(msg);
  }
}

// ── Convenience factories ───────────────────────────────────────────────────

/**
 * Connects as an extension Service Worker and waits for the SET_CONFIG handshake.
 * @param {{ wsUrl: string }} server
 * @returns {Promise<WSClient>}
 */
export async function createSWClient(server) {
  const client = new WSClient(`${server.wsUrl}?sw=1`);
  await client.connect();
  await client.nextMessage(m => m.type === 'SET_CONFIG');
  return client;
}

/**
 * Connects as a Dashboard and waits for the INIT handshake.
 * @param {{ wsUrl: string }} server
 * @returns {Promise<WSClient>}
 */
export async function createDashboardClient(server) {
  const client = new WSClient(server.wsUrl);
  await client.connect();
  await client.nextMessage(m => m.type === 'INIT');
  return client;
}

/** Waits for a specific event on an EventEmitter. */
export function waitEvent(emitter, event, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`waitEvent: '${event}' timeout`)),
      timeoutMs
    );
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
  });
}

/** Sleeps for `ms` milliseconds. */
export const sleep = ms => new Promise(r => setTimeout(r, ms));
