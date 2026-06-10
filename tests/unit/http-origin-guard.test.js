/**
 * tests/unit/http-origin-guard.test.js
 *
 * Exercises the REAL server/http-origin-guard.js.
 *
 * Access-Control-Allow-Origin only stops a browser page from READING a
 * cross-origin response — "simple" requests (e.g. POST with
 * Content-Type: text/plain, mode:'no-cors') skip preflight and are still
 * delivered. Without an explicit reject, any page the instrumented browser
 * visits could drive /api/action (click/navigate/type_text/execute_js) on
 * the user's own tabs. checkOrigin() is the gate that closes this.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkOrigin } = require('../../server/http-origin-guard');

const DEFAULT_OPTS = { host: '127.0.0.1', httpPort: 7892, allowedMcpOrigins: ['localhost', '127.0.0.1'] };

describe('http-origin-guard checkOrigin', () => {
  test('no Origin header (non-browser client / same-origin GET) is trusted', () => {
    const r = checkOrigin('', DEFAULT_OPTS);
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'http://127.0.0.1:7892');
  });

  test('Origin matching the server itself is allowed and echoed back', () => {
    const r = checkOrigin('http://127.0.0.1:7892', DEFAULT_OPTS);
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'http://127.0.0.1:7892');
  });

  test('Origin matching an allowedMcpOrigins host on the http port is allowed', () => {
    const r = checkOrigin('http://localhost:7892', DEFAULT_OPTS);
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'http://localhost:7892');
  });

  test('an unrecognized cross-origin request is rejected (the CSRF gap)', () => {
    const r = checkOrigin('http://evil.com', DEFAULT_OPTS);
    assert.strictEqual(r.allow, false);
    assert.strictEqual(r.acao, 'none');
  });

  test('allowedMcpOrigins=["*"] is an explicit opt-out — never reject', () => {
    const r = checkOrigin('http://evil.com', { ...DEFAULT_OPTS, allowedMcpOrigins: ['*'] });
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'none'); // still can't read the response
  });

  test('non-loopback host (LAN exposure, e.g. 0.0.0.0) never rejects', () => {
    const r = checkOrigin('http://evil.com', { ...DEFAULT_OPTS, host: '0.0.0.0' });
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'none');
  });

  test('a custom allowedMcpOrigins entry is honored on the configured port', () => {
    const r = checkOrigin('http://example.com:7892', { ...DEFAULT_OPTS, allowedMcpOrigins: ['example.com'] });
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.acao, 'http://example.com:7892');
  });
});
