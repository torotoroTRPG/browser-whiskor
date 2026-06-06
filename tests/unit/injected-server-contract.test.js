/**
 * tests/unit/injected-server-contract.test.js
 * Anti-drift guard — every injected message type must have a server consumer.
 *
 * This whole class of bug (network reqId mismatch, Vue3/Alpine/Preact/Solid
 * snapshots, Web Vitals) was the same shape: the page-side (injected) producer was
 * changed or added, but the server-side consumer (core.js routing / cache-writer
 * cases) was never updated, so the data was silently dropped. Rather than re-find
 * these by hand, this test statically cross-checks producers against consumers and
 * fails when a new injected emit type has nowhere to land.
 *
 * Scope: MAIN-world injected plugins (adapters + analyzers). Background-SW message
 * types (ACTION_RESULT, SCREENSHOT_RESULT, control/result messages) are produced in
 * sw.js, not here, and are out of scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');

// Realtime delta streams that are intentionally emitted but not (yet) consumed by
// the server. If you wire one up, REMOVE it from here — the test asserts that every
// entry below is genuinely an unconsumed producer, so a stale allowlist also fails.
const INTENTIONALLY_UNCONSUMED = new Set([
  'DOM_SNAPSHOT_DELTA',
  'SHADOW_DOM_DELTA',
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function collectProducers() {
  const roots = ['shared/injected', 'extension/injected', 'firefox-mv2/injected'].map(r => join(ROOT, r));
  const types = new Set();
  const reEmitType = /emitType:\s*'([A-Z0-9_]+)'/g;
  const reEmitCall = /\bemit\(\s*['"]([A-Z0-9_]+)['"]/g;
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      let m;
      while ((m = reEmitType.exec(src))) types.add(m[1]);
      while ((m = reEmitCall.exec(src))) types.add(m[1]);
    }
  }
  return types;
}

function collectConsumers() {
  const types = new Set();
  const reCase = /case\s+'([A-Z0-9_]+)'/g;
  for (const rel of ['server/core.js', 'server/cache-writer.js']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    let m;
    while ((m = reCase.exec(src))) types.add(m[1]);
  }
  return types;
}

describe('injected → server message contract', () => {
  const producers = collectProducers();
  const consumers = collectConsumers();

  it('found a sane set of producers and consumers', () => {
    assert.ok(producers.size > 10, `expected many producer types, got ${producers.size}`);
    assert.ok(consumers.size > 10, `expected many consumer types, got ${consumers.size}`);
    // Spot-check the ones this work fixed, so a regression to the old names is loud.
    for (const t of ['NETWORK_REQUEST', 'VUE3_SNAPSHOT', 'ALPINE_SNAPSHOT', 'PREACT_SNAPSHOT', 'SOLID_SNAPSHOT', 'PERF_METRICS', 'NETWORK_ERROR']) {
      assert.ok(producers.has(t), `${t} should be an injected producer`);
      assert.ok(consumers.has(t), `${t} should have a server consumer`);
    }
  });

  it('every injected emit type has a server consumer (or is explicitly allowlisted)', () => {
    const orphans = [...producers].filter(t => !consumers.has(t) && !INTENTIONALLY_UNCONSUMED.has(t));
    assert.deepStrictEqual(
      orphans, [],
      `These injected types are emitted but never consumed by the server (silent data drop). ` +
      `Add a case in server/core.js routing + server/cache-writer.js, or add to ` +
      `INTENTIONALLY_UNCONSUMED if that's deliberate: ${orphans.join(', ')}`,
    );
  });

  it('the allowlist stays honest — each entry is a real, unconsumed producer', () => {
    for (const t of INTENTIONALLY_UNCONSUMED) {
      assert.ok(producers.has(t), `${t} is allowlisted but no injected code emits it — remove it`);
      assert.ok(!consumers.has(t), `${t} is allowlisted as unconsumed but the server now handles it — remove it from the allowlist`);
    }
  });
});
