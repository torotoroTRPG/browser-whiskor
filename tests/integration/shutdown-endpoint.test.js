/**
 * tests/integration/shutdown-endpoint.test.js
 *
 * Spawns the REAL server (server/index.js) as a child process and verifies the
 * POST /api/shutdown contract that `whk stop` / `whk restart` rely on:
 *   - the endpoint answers { ok: true, shuttingDown: true }
 *   - the process then exits with code 0 (clean) — the supervisor contract:
 *     a supervisor must STOP on code 0, not restart (supervisor.js semantics)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, '..', '..', 'server', 'index.js');

// Dedicated ports — outside the fixture's 17891/17892 and the port-pool ranges.
const HTTP_PORT = 17982;
const WS_PORT   = 17981;

function request(method, pathname, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: HTTP_PORT, path: pathname, method, timeout: timeoutMs },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await request('GET', '/health'); return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

describe('POST /api/shutdown (real server process)', () => {
  it('responds ok and exits cleanly with code 0', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whk-shutdown-'));
    const child = spawn(process.execPath, [SERVER_JS], {
      env: {
        ...process.env,
        WHISKOR_SERVER_HTTPPORT: String(HTTP_PORT),
        WHISKOR_SERVER_WSPORT:   String(WS_PORT),
        WHISKOR_CACHE_DIR:       cacheDir,
        // Keep startup light — no model download in tests.
        WHISKOR_INTELLIGENCE_SEARCHCLASSIFIER_MINILM_DOWNLOADONSTART: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    const exited = new Promise(res => child.on('exit', (code, signal) => res({ code, signal })));

    try {
      assert.ok(await waitForHealth(15_000), `server did not come up\n${stderr}`);

      const res = await request('POST', '/api/shutdown');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.shuttingDown, true);

      const { code } = await Promise.race([
        exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error('server did not exit after /api/shutdown')), 10_000)),
      ]);
      assert.strictEqual(code, 0,
        'must exit 0 (clean) so a supervisor stops instead of restarting');
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
