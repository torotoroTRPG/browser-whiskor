/**
 * tests/unit/core-cross-app-authz.test.js
 *
 * Exercises the REAL server/core.js app-isolation gate.
 *
 * appIsolation exists so two agents driving the same browser cannot read or
 * mutate each other's tabs. The check used to be hand-written inline, and only
 * GET /api/sessions/:tabId ever got one — every sibling route that resolves the
 * same tabId (/states, /states/:hash, /map, /changes/:tabId, the smart-delta
 * blob, the raw file passthrough, /pin and the DELETE) answered for tabs owned
 * by another app. routeHttp is a ~240-line if-chain with no routing table, so
 * "remember to add the check" is not a workable rule; _denyCrossApp() is called
 * at each site instead, and this test is what keeps a newly added tabId route
 * from quietly skipping it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhiskorCore } = require('../../server/core');

const OWNER = 'app-owner';
const OTHER = 'app-other';
const TAB = 42;

function makeCore() {
  const core = new WhiskorCore({
    appRegistry: {
      enabled: true,
      // Only the owning app may touch the tab.
      canAccess: (callerAppId, tabAppId) => tabAppId === null || callerAppId === tabAppId,
    },
    cache: {
      getSessionData: () => ({ tabId: TAB, siteVersion: 'default' }),
      getSessionDir: () => '/tmp/whiskor-test',
      getSmartDelta: () => ({ elapsed_ms: 1, frame_count: 1, motion_groups: [] }),
      setSessionKeep: () => {},
      removeSession: () => {},
      getSessionList: () => [],
    },
    changeFeed: { peek: () => [{ kind: 'scroll' }], drain: () => [{ kind: 'scroll' }] },
  });
  core._tabToApp.set(TAB, OWNER);
  return core;
}

// Every route below resolves a tabId from the path and must be gated.
const ROUTES = [
  ['GET',    `/api/sessions/${TAB}`],
  ['GET',    `/api/sessions/${TAB}/states`],
  ['GET',    `/api/sessions/${TAB}/states/abc123`],
  ['GET',    `/api/sessions/${TAB}/map`],
  ['GET',    `/api/changes/${TAB}`],
  ['GET',    `/api/sessions/${TAB}/raw/delta/smart.json`],
  ['GET',    `/api/sessions/${TAB}/raw/anything.json`],
  ['POST',   `/api/sessions/${TAB}/pin`],
  ['DELETE', `/api/sessions/${TAB}/pin`],
  ['DELETE', `/api/sessions/${TAB}`],
];

function call(core, method, path, appId) {
  const url = new URL(`http://127.0.0.1:7892${path}`);
  return core.handleHttpRequest({ method, url, body: null, callerAppId: appId });
}

describe('core.js cross-app authorization', () => {
  for (const [method, path] of ROUTES) {
    test(`${method} ${path} is 403 for a caller that does not own the tab`, async () => {
      const res = await call(makeCore(), method, path, OTHER);
      assert.strictEqual(
        res.status, 403,
        `${method} ${path} leaked to a foreign app (got ${res.status})`,
      );
    });

    test(`${method} ${path} is not 403 for the owning app`, async () => {
      const res = await call(makeCore(), method, path, OWNER);
      assert.notStrictEqual(
        res.status, 403,
        `${method} ${path} denied the owning app`,
      );
    });
  }

  test('the gate is inert while appIsolation is disabled', async () => {
    const core = new WhiskorCore({
      appRegistry: { enabled: false, canAccess: () => false },
      cache: { getSessionData: () => ({ tabId: TAB }) },
    });
    core._tabToApp.set(TAB, OWNER);
    const res = await call(core, 'GET', `/api/sessions/${TAB}`, OTHER);
    assert.notStrictEqual(res.status, 403);
  });

  test('_denyCrossApp returns null (not a response) when access is allowed', () => {
    const core = makeCore();
    assert.strictEqual(core._denyCrossApp(OWNER, TAB), null);
    assert.strictEqual(core._denyCrossApp(OTHER, TAB).status, 403);
  });
});
