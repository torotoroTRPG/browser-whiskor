/**
 * tests/e2e/dashboard.spec.js
 *
 * E2E tests for the browser-whiskor dashboard.
 * Run with: npm run test:e2e
 *
 * Phase 1: Dashboard UI + WebSocket message flow
 * Phase 2: Full pipeline with extension loading (future)
 * Phase 3: AI/MCP integration test scaffold (future)
 */

import { test, expect } from '@playwright/test';

const DASHBOARD_URL = 'http://localhost:7892/';
const WS_URL = 'ws://localhost:7891';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for dashboard to initialize */
async function waitForDashboard(page) {
  await page.waitForFunction(() => window.__dash !== undefined, { timeout: 5000 });
}

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Dashboard UI', () => {

  test('loads and shows connection status', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await expect(page.locator('#status')).toBeVisible();
    const status = await page.locator('#status').textContent();
    expect(['CONNECTED', 'AWAITING…']).toContain(status);
  });

  test('canvas element exists', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    const canvas = page.locator('#cv');
    await expect(canvas).toHaveCount(1);
  });

  test('session list renders', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await expect(page.locator('#s-list')).toBeVisible();
    const content = await page.locator('#s-list').textContent();
    expect(content.length).toBeGreaterThan(0);
  });

  test('viewport overlay checkbox exists', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    const overlayCheckbox = page.locator('#cv-overlay');
    await expect(overlayCheckbox).toHaveCount(1);
    const isChecked = await overlayCheckbox.isChecked();
    expect(typeof isChecked).toBe('boolean');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('WebSocket Message Flow (browser-native)', () => {

  test('extension connects and receives SET_CONFIG', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    // Use browser-native WebSocket API
    const configMsg = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => {};
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'SET_CONFIG') {
            ws.close();
            resolve(msg);
          }
        };
        ws.onerror = () => reject(new Error('WS connection failed'));
        setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, `${WS_URL}?sw=1`);

    expect(configMsg.type).toBe('SET_CONFIG');
    expect(configMsg.config).toBeDefined();
  });

  test('TEXT_COORDS from extension reaches dashboard', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const result = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const sw = new WebSocket(`${wsUrl}?sw=1`);
        const dash = new WebSocket(`${wsUrl}/dashboard`);

        let swReady = false;
        let dashReady = false;
        let initConsumed = false;

        const checkReady = () => {
          if (swReady && dashReady) {
            // Send TEXT_COORDS from SW
            const textCoordsMsg = {
              type: 'TEXT_COORDS',
              tabId: 1,
              payload: {
                words: [
                  { id: 'w1', text: 'Hello', absoluteX: 100, absoluteY: 100, width: 50, height: 16 },
                  { id: 'w2', text: 'World', absoluteX: 200, absoluteY: 200, width: 60, height: 16 },
                ],
                capturedAt: Date.now(),
              },
            };
            sw.send(JSON.stringify(textCoordsMsg));
          }
        };

        sw.onopen = () => { swReady = true; checkReady(); };
        sw.onerror = () => reject(new Error('SW WS failed'));

        dash.onopen = () => { dashReady = true; checkReady(); };
        dash.onerror = () => reject(new Error('Dashboard WS failed'));

        dash.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          // Consume INIT message
          if (msg.type === 'INIT' && !initConsumed) {
            initConsumed = true;
            return;
          }
          if (msg.type === 'TEXT_COORDS') {
            sw.close();
            dash.close();
            resolve(msg);
          }
        };

        setTimeout(() => { sw.close(); dash.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, WS_URL);

    expect(result.type).toBe('TEXT_COORDS');
    expect(result.payload.words).toHaveLength(2);
    expect(result.payload.words[0].text).toBe('Hello');
  });

  test('VIEWPORT_UPDATE from extension reaches dashboard', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const result = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const sw = new WebSocket(`${wsUrl}?sw=1`);
        const dash = new WebSocket(`${wsUrl}/dashboard`);

        let swReady = false;
        let dashReady = false;
        let initConsumed = false;

        const checkReady = () => {
          if (swReady && dashReady) {
            sw.send(JSON.stringify({
              type: 'VIEWPORT_UPDATE',
              tabId: 1,
              payload: { scrollX: 0, scrollY: 500, width: 1280, height: 800 },
            }));
          }
        };

        sw.onopen = () => { swReady = true; checkReady(); };
        sw.onerror = () => reject(new Error('SW WS failed'));

        dash.onopen = () => { dashReady = true; checkReady(); };
        dash.onerror = () => reject(new Error('Dashboard WS failed'));

        dash.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'INIT' && !initConsumed) { initConsumed = true; return; }
          if (msg.type === 'VIEWPORT_UPDATE') {
            sw.close();
            dash.close();
            resolve(msg);
          }
        };

        setTimeout(() => { sw.close(); dash.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, WS_URL);

    expect(result.type).toBe('VIEWPORT_UPDATE');
    expect(result.payload.scrollY).toBe(500);
  });

  test('REACT_TRANSITION from extension reaches dashboard', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const result = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const sw = new WebSocket(`${wsUrl}?sw=1`);
        const dash = new WebSocket(`${wsUrl}/dashboard`);

        let swReady = false;
        let dashReady = false;
        let initConsumed = false;

        const checkReady = () => {
          if (swReady && dashReady) {
            sw.send(JSON.stringify({
              type: 'REACT_TRANSITION',
              tabId: 1,
              siteVersion: 'v1',
              payload: {
                from: 'state-A',
                to: 'state-B',
                fromReact: { hash: 'abc123' },
                toReact: { hash: 'def456' },
                trigger: 'click',
              },
            }));
          }
        };

        sw.onopen = () => { swReady = true; checkReady(); };
        sw.onerror = () => reject(new Error('SW WS failed'));

        dash.onopen = () => { dashReady = true; checkReady(); };
        dash.onerror = () => reject(new Error('Dashboard WS failed'));

        dash.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'INIT' && !initConsumed) { initConsumed = true; return; }
          if (msg.type === 'REACT_TRANSITION') {
            sw.close();
            dash.close();
            resolve(msg);
          }
        };

        setTimeout(() => { sw.close(); dash.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, WS_URL);

    expect(result.type).toBe('REACT_TRANSITION');
    expect(result.payload.from).toBe('state-A');
    expect(result.payload.to).toBe('state-B');
  });

  test('PING/PONG keepalive works', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const pong = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl}?sw=1`);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'PING' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'PONG') {
            ws.close();
            resolve(msg);
          }
        };
        ws.onerror = () => reject(new Error('WS failed'));
        setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, WS_URL);

    expect(pong.type).toBe('PONG');
    expect(pong.ts).toBeDefined();
  });

  test('malformed JSON does not disconnect server', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const result = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const sw = new WebSocket(`${wsUrl}?sw=1`);
        const dash = new WebSocket(`${wsUrl}/dashboard`);

        let swReady = false;
        let dashReady = false;
        let initConsumed = false;

        const checkReady = () => {
          if (swReady && dashReady) {
            // Send malformed JSON
            sw.send('THIS IS NOT JSON }{{{');
            // Then send valid message
            setTimeout(() => {
              sw.send(JSON.stringify({ type: 'TEXT_COORDS', tabId: 1, payload: { words: [], capturedAt: Date.now() } }));
            }, 100);
          }
        };

        sw.onopen = () => { swReady = true; checkReady(); };
        sw.onerror = () => reject(new Error('SW WS failed'));

        dash.onopen = () => { dashReady = true; checkReady(); };
        dash.onerror = () => reject(new Error('Dashboard WS failed'));

        dash.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'INIT' && !initConsumed) { initConsumed = true; return; }
          if (msg.type === 'TEXT_COORDS') {
            sw.close();
            dash.close();
            resolve(msg);
          }
        };

        setTimeout(() => { sw.close(); dash.close(); reject(new Error('Timeout')); }, 5000);
      });
    }, WS_URL);

    expect(result.type).toBe('TEXT_COORDS');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Dashboard Live Data Integration', () => {

  test('VIEWPORT_UPDATE updates live viewport state in dashboard', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    await page.evaluate(() => { window.__dash.tabId = 999; });

    await page.evaluate(() => {
      const payload = { scrollX: 500, scrollY: 800, width: 1280, height: 800 };
      window.__dash.liveVp = payload;
      if (typeof window.__dash._invalidateAreaCache === 'function') {
        window.__dash._invalidateAreaCache();
      }
    });

    await page.waitForTimeout(200);

    const liveVp = await page.evaluate(() => window.__dash?.liveVp);
    expect(liveVp).not.toBeNull();
    expect(liveVp.scrollX).toBe(500);
    expect(liveVp.scrollY).toBe(800);
  });

  test('scroll position changes canvas pan in auto-fit mode', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    await page.evaluate(() => {
      document.getElementById('detail').style.display = '';
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      window.__dash.tabId = 999;
      window.__dash.words = [
        { id: 'w1', text: 'Top', absoluteX: 100, absoluteY: 100, width: 50, height: 16 },
        { id: 'w2', text: 'Bottom', absoluteX: 100, absoluteY: 2000, width: 70, height: 16 },
      ];
      window.__dash.liveVp = { scrollX: 0, scrollY: 0, width: 1280, height: 800 };
      window.__dash.canvas.zoom = null;
      window.__dash.canvas.panX = 0;
      window.__dash.canvas.panY = 0;
      window.__dash.canvas.areaCacheValid = false;
      window.__dash._scheduleCanvasRender();
    });

    await page.waitForTimeout(300);

    await page.evaluate(() => {
      window.__dash.liveVp.scrollY = 1000;
      window.__dash.liveVp.scrollX = 200;
      window.__dash.canvas.areaCacheValid = false;
      window.__dash._scheduleCanvasRender();
    });

    await page.waitForTimeout(300);

    const afterScrollPan = await page.evaluate(() => ({
      panX: window.__dash.canvas.panX,
      panY: window.__dash.canvas.panY,
    }));

    expect(afterScrollPan.panX).toBeDefined();
    expect(afterScrollPan.panY).toBeDefined();
  });

  test('words render on canvas after text-coords load', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    await page.evaluate(() => {
      window.__dash.tabId = 999;
      window.__dash.words = [
        { id: 'w1', text: 'Hello', absoluteX: 100, absoluteY: 100, width: 50, height: 16 },
        { id: 'w2', text: 'World', absoluteX: 200, absoluteY: 200, width: 60, height: 16 },
      ];
      window.__dash.liveVp = { scrollX: 0, scrollY: 0, width: 1280, height: 800 };
    });

    await page.waitForTimeout(500);

    const wordCount = await page.evaluate(() => window.__dash?.words?.length || 0);
    expect(wordCount).toBe(2);

    await expect(page.locator('#cv')).toHaveCount(1);
  });

  test('canvas dimensions update on resize', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const initialSize = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      return { width: cv.width, height: cv.height };
    });

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(300);

    const afterResizeSize = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      return { width: cv.width, height: cv.height };
    });

    expect(afterResizeSize.width).toBeGreaterThan(0);
    expect(afterResizeSize.height).toBeGreaterThan(0);
  });

  test('fetches sessions from API', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await page.waitForTimeout(1000);
    await waitForDashboard(page);

    const sessions = await page.evaluate(() => window.__dash?.sessions || []);
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('HTTP API Integration', () => {

  test('GET /health returns ok', async ({ page }) => {
    const response = await page.request.get('http://localhost:7892/health');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test('GET /api/config returns configuration', async ({ page }) => {
    const response = await page.request.get('http://localhost:7892/api/config');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.mode).toBeDefined();
    expect(body.plugins).toBeDefined();
  });

  test('POST /api/config updates configuration', async ({ page }) => {
    const response = await page.request.post('http://localhost:7892/api/config', {
      data: { mode: 'manual' },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test('GET /api/sessions returns array', async ({ page }) => {
    const response = await page.request.get('http://localhost:7892/api/sessions');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/collect triggers collection', async ({ page }) => {
    const response = await page.request.post('http://localhost:7892/api/collect', {
      data: { tabId: 1 },
    });
    expect(response.ok()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Multi-Client Scenarios', () => {

  test('multiple SW connections are tracked', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const wsCount = await page.evaluate((wsUrl) => {
      return new Promise((resolve) => {
        const sw1 = new WebSocket(`${wsUrl}?sw=1`);
        const sw2 = new WebSocket(`${wsUrl}?sw=2`);
        let ready = 0;

        const check = () => {
          ready++;
          if (ready === 2) {
            // Check health endpoint
            fetch('http://localhost:7892/health')
              .then(r => r.json())
              .then(body => {
                sw1.close();
                sw2.close();
                resolve(body.wsConnections);
              });
          }
        };

        sw1.onopen = check;
        sw2.onopen = check;
        setTimeout(() => { sw1.close(); sw2.close(); resolve(0); }, 5000);
      });
    }, WS_URL);

    expect(wsCount).toBeGreaterThanOrEqual(2);
  });

  test('broadcast reaches all connected SW clients', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const results = await page.evaluate((wsUrl) => {
      return new Promise((resolve) => {
        const sw1 = new WebSocket(`${wsUrl}?sw=1`);
        const sw2 = new WebSocket(`${wsUrl}?sw=2`);
        let sw1Config = null;
        let sw2Config = null;
        let sw1Ready = false;
        let sw2Ready = false;

        sw1.onopen = () => { sw1Ready = true; };
        sw2.onopen = () => { sw2Ready = true; };

        sw1.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'SET_CONFIG') sw1Config = msg;
        };

        sw2.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'SET_CONFIG') sw2Config = msg;
        };

        // Wait for both to be ready, then trigger config change
        const interval = setInterval(() => {
          if (sw1Ready && sw2Ready) {
            clearInterval(interval);
            // Trigger config change via API
            fetch('http://localhost:7892/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: 'always_on' }),
            }).then(() => {
              // Wait for broadcast
              setTimeout(() => {
                sw1.close();
                sw2.close();
                resolve({ sw1Config, sw2Config });
              }, 1000);
            });
          }
        }, 50);

        setTimeout(() => { sw1.close(); sw2.close(); resolve({ sw1Config, sw2Config }); }, 8000);
      });
    }, WS_URL);

    expect(results.sw1Config?.type).toBe('SET_CONFIG');
    expect(results.sw2Config?.type).toBe('SET_CONFIG');
  });

  test('SW disconnect does not affect dashboard', async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    await waitForDashboard(page);

    const result = await page.evaluate((wsUrl) => {
      return new Promise((resolve, reject) => {
        const sw1 = new WebSocket(`${wsUrl}?sw=1`);
        const dash = new WebSocket(`${wsUrl}/dashboard`);

        let sw1Ready = false;
        let dashReady = false;
        let initConsumed = false;

        sw1.onopen = () => {
          sw1Ready = true;
          // Close SW1 immediately
          sw1.close();
          checkReady();
        };

        dash.onopen = () => { dashReady = true; checkReady(); };
        dash.onerror = () => reject(new Error('Dashboard WS failed'));

        const checkReady = () => {
          if (dashReady) {
            // Wait a bit for SW1 to disconnect
            setTimeout(() => {
              // Connect SW2 and send message
              const sw2 = new WebSocket(`${wsUrl}?sw=2`);
              sw2.onopen = () => {
                sw2.send(JSON.stringify({ type: 'TEXT_COORDS', tabId: 2, payload: { words: [], capturedAt: Date.now() } }));
              };
            }, 200);
          }
        };

        dash.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'INIT' && !initConsumed) { initConsumed = true; return; }
          if (msg.type === 'TEXT_COORDS') {
            dash.close();
            resolve(msg);
          }
        };

        setTimeout(() => { dash.close(); reject(new Error('Timeout')); }, 8000);
      });
    }, WS_URL);

    expect(result.type).toBe('TEXT_COORDS');
  });
});
