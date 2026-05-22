/**
 * tests/e2e/helpers/e2e-helpers.mjs
 *
 * Reusable utilities for E2E tests:
 *   - Extension sandbox management
 *   - WebSocket message helpers (browser-native)
 *   - HTTP API helpers
 *   - Page fixtures and test data
 *   - Assertion helpers
 *
 * All helpers are pure functions or factories — no global state.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

// ── Constants ─────────────────────────────────────────────────────────────────

export const EXTENSION_PATH = path.join(ROOT, 'tests', 'tmp', 'e2e-extension');
export const WS_URL = 'ws://localhost:7891';
export const HTTP_URL = 'http://localhost:7892';

// ── Extension Launch ──────────────────────────────────────────────────────────

/**
 * Launch Chromium with the extension loaded in a sandboxed profile.
 * @param {import('@playwright/test').BrowserType} browserType - Playwright chromium
 * @param {object} opts
 * @param {boolean} [opts.headless] - Run in headless mode (default: true)
 * @param {string} [opts.userDataDir] - Custom profile directory
 * @returns {Promise<import('@playwright/test').BrowserContext>}
 */
export async function launchWithExtension(browserType, opts = {}) {
  const headless = opts.headless ?? process.env.E2E_GUI !== '1';
  const userDataDir = opts.userDataDir || path.join(ROOT, 'tests', 'tmp', 'e2e-profile');

  return browserType.launchPersistentContext(userDataDir, {
    headless,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-default-apps',
    ],
  });
}

/**
 * Wait for the extension's service worker to connect to the server.
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs] - Max wait time (default: 15000)
 * @returns {Promise<object>} Health response body
 */
export async function waitForExtensionConnection(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await page.request.get(`${HTTP_URL}/health`);
      const body = await res.json();
      if (body.wsConnections > 0) return body;
    } catch {
      // Server might not be ready
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Extension did not connect within ${timeoutMs}ms`);
}

// ── WebSocket Helpers (browser-native) ────────────────────────────────────────

/**
 * Create a WebSocket connection inside the browser context.
 * Automatically consumes the first message (SET_CONFIG or INIT) and returns it.
 * @param {import('@playwright/test').Page} page
 * @param {string} url - WebSocket URL
 * @param {object} opts
 * @param {boolean} [opts.consumeInit] - Consume the first message (default: true)
 * @returns {Promise<{id: string, initMsg: object}>} Connection ID and initial message
 */
export async function createWS(page, url, opts = {}) {
  const consumeInit = opts.consumeInit !== false;
  return page.evaluate(({ wsUrl, consume }) => {
    if (!window.__e2eWs) window.__e2eWs = new Map();
    const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let initMsg = null;

      ws.onmessage = (e) => {
        if (!initMsg) {
          try {
            initMsg = JSON.parse(e.data);
          } catch { /* ignore */ }
        }
      };

      ws.onopen = () => {
        window.__e2eWs.set(id, ws);
        if (consume) {
          // Wait a bit for the initial message (SET_CONFIG or INIT)
          setTimeout(() => {
            resolve({ id, initMsg });
          }, 200);
        } else {
          resolve({ id, initMsg: null });
        }
      };
      ws.onerror = () => reject(new Error(`Failed to connect to ${wsUrl}`));
      setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connection timeout: ${wsUrl}`));
      }, 5000);
    });
  }, { wsUrl: url, consume: consumeInit });
}

/**
 * Wait for a specific message type on a WS connection.
 * Sets up listener BEFORE waiting to avoid race conditions.
 * @param {import('@playwright/test').Page} page
 * @param {string} wsId - Connection ID from createWS
 * @param {string} type - Message type to wait for
 * @param {number} [timeoutMs] - Max wait time (default: 8000)
 * @returns {Promise<object>} Parsed message
 */
export async function waitForMessage(page, wsId, type, timeoutMs = 8000) {
  return page.evaluate(({ id, msgType, timeout }) => {
    const ws = window.__e2eWs?.get(id);
    if (!ws) throw new Error(`No WS found with id: ${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${msgType} (${timeout}ms)`)), timeout);
      const handler = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === msgType) {
            clearTimeout(timer);
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        } catch { /* ignore parse errors */ }
      };
      ws.addEventListener('message', handler);
    });
  }, { id: wsId, msgType: type, timeout: timeoutMs });
}

/**
 * Send a message through a WS connection.
 * @param {import('@playwright/test').Page} page
 * @param {string} wsId - Connection ID
 * @param {object} msg - Message object (will be JSON stringified)
 */
export async function sendMessage(page, wsId, msg) {
  return page.evaluate(({ id, message }) => {
    const ws = window.__e2eWs?.get(id);
    if (!ws || ws.readyState !== 1) throw new Error(`WS ${id} not open`);
    ws.send(JSON.stringify(message));
    return true;
  }, { id: wsId, message: msg });
}

/**
 * Close a WS connection.
 * @param {import('@playwright/test').Page} page
 * @param {string} wsId - Connection ID
 */
export async function closeWS(page, wsId) {
  return page.evaluate((id) => {
    const ws = window.__e2eWs?.get(id);
    if (ws) { ws.close(); window.__e2eWs.delete(id); }
  }, wsId);
}

/**
 * Close all WS connections.
 * @param {import('@playwright/test').Page} page
 */
export async function closeAllWS(page) {
  return page.evaluate(() => {
    window.__e2eWs?.forEach(ws => ws.close());
    window.__e2eWs?.clear();
  });
}

// ── HTTP API Helpers ──────────────────────────────────────────────────────────

/**
 * Make an HTTP request to the server.
 * @param {import('@playwright/test').Page} page
 * @param {string} method - HTTP method
 * @param {string} path - URL path (e.g., '/health')
 * @param {object} [opts] - Request options
 * @returns {Promise<{status: number, body: object}>}
 */
export async function httpReq(page, method, path, opts = {}) {
  const url = `${HTTP_URL}${path}`;
  const requestOpts = { method };
  if (opts.data) requestOpts.data = opts.data;
  if (opts.headers) requestOpts.headers = opts.headers;

  const response = await page.request.fetch(url, requestOpts);
  const body = await response.json().catch(() => null);
  return { status: response.status(), body };
}

export const httpGet = (page, path) => httpReq(page, 'GET', path);
export const httpPost = (page, path, data) => httpReq(page, 'POST', path, { data });

// ── Test Page Fixtures ────────────────────────────────────────────────────────

/**
 * Generate test pages with known content for assertions.
 */
export const TestPages = {
  /** Simple page with text elements */
  simpleText: 'data:text/html,<html><body><h1 id="title">Test Page</h1><p id="para">Hello World</p><button id="btn">Click Me</button></body></html>',

  /** Page with multiple text elements for collection testing */
  multiText: `data:text/html,<html><body>
    <h1>Header</h1>
    <p>First paragraph with some text.</p>
    <p>Second paragraph with different text.</p>
    <a href="#">Navigation Link</a>
    <span>Inline span text</span>
    <button>Action Button</button>
    <input type="text" placeholder="Enter name" />
    <label>Form Label</label>
  </body></html>`,

  /** Page with interactive elements for action testing */
  interactive: `data:text/html,<html><body>
    <h1>Interactive Page</h1>
    <button id="btn1" onclick="this.textContent='Clicked!'">Button 1</button>
    <button id="btn2">Button 2</button>
    <input id="input1" type="text" />
    <a id="link1" href="#section">Go to Section</a>
    <div id="section"><p>Section content</p></div>
    <select id="select1"><option value="a">A</option><option value="b">B</option></select>
  </body></html>`,

  /** Page with nested structure for DOM snapshot testing */
  nested: `data:text/html,<html><body>
    <div id="app">
      <header><nav><ul><li>Home</li><li>About</li><li>Contact</li></ul></nav></header>
      <main>
        <section id="sec1"><h2>Section 1</h2><p>Content 1</p></section>
        <section id="sec2"><h2>Section 2</h2><p>Content 2</p></section>
      </main>
      <footer><p>Footer</p></footer>
    </div>
  </body></html>`,

  /** Page with React-like structure for framework detection */
  reactLike: `data:text/html,<html><body>
    <div id="root">
      <div data-reactroot="">
        <h1>React App</h1>
        <div class="App"><p>Content</p></div>
      </div>
    </div>
    <script>window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map() };</script>
  </body></html>`,
};

// ── Message Payload Factories ─────────────────────────────────────────────────

/**
 * Create a valid TEXT_COORDS message payload.
 */
export function textCoordsPayload(words = []) {
  return {
    type: 'TEXT_COORDS',
    tabId: 1,
    payload: {
      words,
      capturedAt: Date.now(),
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
    },
  };
}

/**
 * Create a valid VIEWPORT_UPDATE message payload.
 */
export function viewportPayload(scrollX = 0, scrollY = 0, width = 1280, height = 800) {
  return {
    type: 'VIEWPORT_UPDATE',
    tabId: 1,
    payload: { scrollX, scrollY, width, height },
  };
}

/**
 * Create a valid EXPLORER_STATE_UPDATE message payload.
 */
export function explorerStatePayload(siteVersion, hash, uiCatalog = null) {
  return {
    type: 'EXPLORER_STATE_UPDATE',
    tabId: 1,
    siteVersion,
    payload: {
      siteVersion,
      currentHash: hash,
      reactHash: null,
      domHash: hash,
      url: 'http://example.com',
      title: 'Test Page',
      uiCatalog,
    },
  };
}

// ── Assertion Helpers ─────────────────────────────────────────────────────────

/**
 * Assert that a message has the expected structure.
 * @param {object} msg - Received message
 * @param {string} type - Expected message type
 * @param {string[]} [requiredFields] - Fields that must exist
 */
export function assertMessageShape(msg, type, requiredFields = []) {
  if (msg.type !== type) {
    throw new Error(`Expected message type "${type}", got "${msg.type}"`);
  }
  for (const field of requiredFields) {
    if (!(field in msg)) {
      throw new Error(`Message "${type}" missing required field: "${field}"`);
    }
  }
}

/**
 * Assert that a health response is valid.
 * @param {object} body - Health response body
 */
export function assertHealthOk(body) {
  if (body.ok !== true) throw new Error('Health check failed: ok !== true');
  if (typeof body.wsConnections !== 'number') throw new Error('Health check failed: wsConnections missing');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Clean up browser profile directory.
 * @param {string} profileDir - Path to profile directory
 */
export async function cleanupProfile(profileDir) {
  try {
    if (fs.existsSync(profileDir)) {
      const files = fs.readdirSync(profileDir);
      for (const file of files) {
        const filePath = path.join(profileDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}
