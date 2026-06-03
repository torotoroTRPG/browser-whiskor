/**
 * tests/e2e/injected-collection.spec.mjs
 *
 * Deep coverage for the injected MAIN-world pipeline that the (removed) hollow
 * unit tests only pretended to cover: the text-coords analyzer and the
 * ISOLATED-world bridge that relays page data to the service worker and on to
 * the server.
 *
 * Strategy: load an http page with KNOWN marker text (content scripts do not run
 * on data: URLs, so we serve real http via route fulfillment), listen on a
 * dashboard WebSocket for the TEXT_COORDS the server re-broadcasts, and assert
 * the marker arrives with absolute pixel coordinates. The data could not arrive
 * at all unless analyzer → collector → bridge → SW → server works end to end.
 *
 * The WebSocket lives on its own page that never navigates (window.__e2eWs is
 * per-document and would be lost on navigation), and we match only the
 * TEXT_COORDS that actually contains our marker — so the dashboard page's own
 * collection is ignored.
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
// Ignores unrelated broadcasts (e.g. the dashboard page's own text-coords).
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

const markerPage = (marker) =>
  `<!doctype html><html><body><h1>Whiskor Pipeline Test</h1><p>Unique marker ${marker} here</p></body></html>`;

async function openWsDashboard(context) {
  // Stable page that holds the dashboard WebSocket (never navigates).
  const wsPage = await context.newPage();
  await wsPage.goto(HTTP_URL + '/', { waitUntil: 'domcontentloaded' });
  await waitForExtensionConnection(wsPage);
  // The real server only registers a socket as a dashboard (→ receives
  // broadcastToDashboard) when it connects to the /dashboard path; any other
  // path is treated as a service-worker socket. (index.js wss 'connection'.)
  const { id: wsId } = await createWS(wsPage, WS_URL + '/dashboard');
  return { wsPage, wsId };
}

async function openMarkerPage(context, marker) {
  const testPage = await context.newPage();
  // Content scripts need http(s); serve known HTML via route fulfillment.
  await testPage.route('**/__whiskor_e2e__*', (route) =>
    route.fulfill({ contentType: 'text/html', body: markerPage(marker) }));
  await testPage.goto(HTTP_URL + '/__whiskor_e2e__', { waitUntil: 'domcontentloaded' });
  return testPage;
}

test.describe('Injected pipeline — real data collection', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension loading requires Chromium');

  test('text-coords reports the page\'s actual words with absolute coordinates', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const { wsPage, wsId } = await openWsDashboard(context);
      await openMarkerPage(context, 'FOOBAR123');

      const msg = await waitForMarkerCoords(wsPage, wsId, 'FOOBAR123');
      const words = msg.payload.words || [];
      expect(words.length).toBeGreaterThan(0);

      const marker = words.find((w) => (w.text || '').includes('FOOBAR123'));
      expect(marker, 'a word carrying the marker must be present').toBeTruthy();
      for (const f of ['left', 'top', 'width', 'height']) {
        expect(typeof marker[f]).toBe('number');
      }

      await closeAllWS(wsPage);
    } finally {
      await context.close();
    }
  });

  test('reload re-collects and reports the same text (pipeline is repeatable)', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const { wsPage, wsId } = await openWsDashboard(context);
      const testPage = await openMarkerPage(context, 'BEACONWORD');

      const first = await waitForMarkerCoords(wsPage, wsId, 'BEACONWORD');
      expect(first.payload.words.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);

      // A full reload re-injects the content scripts and re-collects.
      await testPage.reload({ waitUntil: 'domcontentloaded' });
      const second = await waitForMarkerCoords(wsPage, wsId, 'BEACONWORD');
      expect(second.payload.words.some((w) => (w.text || '').includes('BEACONWORD'))).toBe(true);

      await closeAllWS(wsPage);
    } finally {
      await context.close();
    }
  });

  test('whiskor executes a click end-to-end (server → SW → executor → DOM)', async () => {
    const context = await launchWithExtension(chromium);
    try {
      const { wsPage, wsId } = await openWsDashboard(context);

      const testPage = await context.newPage();
      const html = '<!doctype html><html><body><h1>ACTIONMARK42</h1>'
        + '<button id="wbtn" onclick="this.textContent=\'CLICKED_OK\'">Click Me</button></body></html>';
      await testPage.route('**/__whiskor_action__*', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }));
      await testPage.goto(HTTP_URL + '/__whiskor_action__', { waitUntil: 'domcontentloaded' });

      // Identify the tab whiskor assigned by waiting for its collected text-coords.
      const coords = await waitForMarkerCoords(wsPage, wsId, 'ACTIONMARK42');
      const tabId = coords.tabId;
      expect(typeof tabId).toBe('number');

      // Drive whiskor's OWN executor (not Playwright's click) through the action API.
      const res = await httpPost(wsPage, '/api/action', { tabId, action: { type: 'click', selector: '#wbtn' } });
      expect(res.status).toBe(200);

      // The button must reflect the click performed by injected/executor.js.
      await expect(testPage.locator('#wbtn')).toHaveText('CLICKED_OK', { timeout: 10000 });

      await closeAllWS(wsPage);
    } finally {
      await context.close();
    }
  });
});
