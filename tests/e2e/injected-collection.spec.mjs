/**
 * tests/e2e/injected-collection.spec.mjs
 *
 * Deep coverage for the injected MAIN-world pipeline that the (removed) hollow
 * unit tests only pretended to cover: the text-coords analyzer, the ISOLATED-
 * world bridge, and the action executor — exercised against a real browser.
 *
 * Strategy: serve http pages with KNOWN marker text (content scripts do not run
 * on data: URLs), listen on a dashboard WebSocket for the TEXT_COORDS the server
 * re-broadcasts, and assert markers arrive with absolute coordinates. The data
 * cannot arrive unless analyzer → collector → bridge → SW → server works end to
 * end; the action test additionally drives whiskor's own executor.
 *
 * Efficiency: one browser context + one dashboard WebSocket are launched once
 * (beforeAll) and shared across the suite (serial), and every wait is
 * event-driven (resolve on the matching broadcast / DOM state) — no fixed sleeps.
 * The WebSocket lives on a page that never navigates (window.__e2eWs is per-
 * document) and connects on the /dashboard path (the real server only delivers
 * broadcastToDashboard to dashboard sockets). Each test matches only the
 * TEXT_COORDS carrying its own unique marker, so the dashboard page's own
 * collection and other tests' pages are ignored.
 *
 * Run with: npm run test:e2e -- --grep "Injected pipeline"  (Chromium only).
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  createWS,
  closeAllWS,
  httpPost,
  WS_URL,
  HTTP_URL,
} from './helpers/e2e-helpers.mjs';

// Resolve when a TEXT_COORDS whose words contain `marker` arrives on the WS.
// Event-driven: settles the instant the matching broadcast lands.
function waitForMarkerCoords(page, wsId, marker, timeoutMs = 20000) {
  return page.evaluate(({ id, marker, timeout }) => {
    const ws = window.__e2eWs && window.__e2eWs.get(id);
    if (!ws) throw new Error('No WS found with id: ' + id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.removeEventListener('message', h); reject(new Error('timeout waiting for marker ' + marker)); }, timeout);
      const h = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'TEXT_COORDS' && JSON.stringify(m.payload && m.payload.words || []).includes(marker)) {
          clearTimeout(timer); ws.removeEventListener('message', h); resolve(m);
        }
      };
      ws.addEventListener('message', h);
    });
  }, { id: wsId, marker, timeout: timeoutMs });
}

async function openWsDashboard(context) {
  const wsPage = await context.newPage();
  await wsPage.goto(HTTP_URL + '/', { waitUntil: 'domcontentloaded' });
  await waitForExtensionConnection(wsPage);
  // The real server registers a dashboard socket (→ broadcastToDashboard) only on
  // the /dashboard path; any other path becomes a service-worker socket.
  const { id: wsId } = await createWS(wsPage, WS_URL + '/dashboard');
  return { wsPage, wsId };
}

// Open a fresh tab serving `html` at an http path (content scripts need http(s)).
async function openServedPage(context, routeGlob, urlPath, html) {
  const page = await context.newPage();
  await page.route(routeGlob, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(HTTP_URL + urlPath, { waitUntil: 'domcontentloaded' });
  return page;
}

const markerHtml = (marker) =>
  `<!doctype html><html><body><h1>Whiskor Pipeline Test</h1><p>Unique marker ${marker} here</p></body></html>`;

test.describe('Injected pipeline — real data collection', () => {
  test.describe.configure({ mode: 'serial' });

  let context;
  let wsPage;
  let wsId;

  test.beforeAll(async () => {
    context = await launchWithExtension(chromium);
    ({ wsPage, wsId } = await openWsDashboard(context));
  });

  test.afterAll(async () => {
    if (wsPage) await closeAllWS(wsPage).catch(() => {});
    if (context) await context.close();
  });

  test('text-coords reports the page\'s actual words with absolute coordinates', async () => {
    const testPage = await openServedPage(context, '**/__whiskor_e2e__*', '/__whiskor_e2e__', markerHtml('FOOBAR123'));
    try {
      const msg = await waitForMarkerCoords(wsPage, wsId, 'FOOBAR123');
      const words = msg.payload.words || [];
      expect(words.length).toBeGreaterThan(0);

      const marker = words.find((w) => (w.text || '').includes('FOOBAR123'));
      expect(marker, 'a word carrying the marker must be present').toBeTruthy();
      for (const f of ['left', 'top', 'width', 'height']) {
        expect(typeof marker[f]).toBe('number');
      }
    } finally {
      await testPage.close();
    }
  });

  test('reload re-collects and reports the same text (pipeline is repeatable)', async () => {
    const testPage = await openServedPage(context, '**/__whiskor_e2e__*', '/__whiskor_e2e__', markerHtml('BEACONWORD'));
    try {
      const first = await waitForMarkerCoords(wsPage, wsId, 'BEACONWORD');
      expect(first.payload.words.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);

      await testPage.reload({ waitUntil: 'domcontentloaded' });
      const second = await waitForMarkerCoords(wsPage, wsId, 'BEACONWORD');
      expect(second.payload.words.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);
    } finally {
      await testPage.close();
    }
  });

  test('whiskor executes a click end-to-end (server → SW → executor → DOM)', async () => {
    const html = '<!doctype html><html><body><h1>ACTIONMARK42</h1>'
      + '<button id="wbtn" onclick="this.textContent=\'CLICKED_OK\'">Click Me</button></body></html>';
    const testPage = await openServedPage(context, '**/__whiskor_action__*', '/__whiskor_action__', html);
    try {
      // Identify the tab whiskor assigned by waiting for its collected text-coords.
      const coords = await waitForMarkerCoords(wsPage, wsId, 'ACTIONMARK42');
      const tabId = coords.tabId;
      expect(typeof tabId).toBe('number');

      // Drive whiskor's OWN executor (not Playwright's click) through the action API.
      const res = await httpPost(wsPage, '/api/action', { tabId, action: { type: 'click', selector: '#wbtn' } });
      expect(res.status).toBe(200);

      // The button must reflect the click performed by injected/executor.js.
      await expect(testPage.locator('#wbtn')).toHaveText('CLICKED_OK', { timeout: 10000 });
    } finally {
      await testPage.close();
    }
  });
});
