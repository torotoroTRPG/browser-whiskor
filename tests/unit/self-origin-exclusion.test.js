/**
 * tests/unit/self-origin-exclusion.test.js
 * Section 18.x — don't capture whiskor's own dashboard / API (review #6, #7)
 *
 * The dashboard (localhost:<httpPort>) and the /export download share whiskor's
 * own origin; collecting them is self-monitoring noise (and /export spawned a
 * fresh session each time). The worker drops any message whose tabUrl is its own
 * loopback origin.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cw = require('../../server/cache-writer');

describe('18.x self-origin exclusion', () => {
  it('matches the whiskor port on loopback hosts only', () => {
    cw.setSelfOrigin(7892);
    assert.ok(cw.isSelfOrigin('http://localhost:7892/'),            'dashboard root');
    assert.ok(cw.isSelfOrigin('http://127.0.0.1:7892/export'),      '/export download');
    assert.ok(cw.isSelfOrigin('http://[::1]:7892/api/sessions'),    'ipv6 loopback + api');
    assert.ok(!cw.isSelfOrigin('http://localhost:3000/'),           'different port');
    assert.ok(!cw.isSelfOrigin('https://claude.ai/'),               'real site');
    assert.ok(!cw.isSelfOrigin('https://example.com:7892/'),        'same port, not loopback');
    assert.ok(!cw.isSelfOrigin('not a url'),                        'garbage');
  });

  it('drops a message for whiskor’s own dashboard (no session created)', async () => {
    cw.setSelfOrigin(7892);
    await cw.handleMessage({ type: 'FRAMEWORK_DETECTION', tabId: 99887766, tabUrl: 'http://localhost:7892/', payload: { detected: [] } });
    assert.ok(!cw.getSessionData(99887766), 'self-origin tab must not become a session');
  });

  it('is disabled when no self port is set', () => {
    cw.setSelfOrigin(null);
    assert.ok(!cw.isSelfOrigin('http://localhost:7892/'));
  });
});
