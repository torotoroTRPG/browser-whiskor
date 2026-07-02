/**
 * tests/unit/state-store-origin.test.js
 * Graph origin binding — the server-side guard against cross-site state-graph
 * poisoning (security review 2-4).
 *
 * siteVersion is a client-computed fingerprint carried in the page-influenced
 * message envelope, so a hostile page can CLAIM another site's siteVersion in a
 * forged EXPLORER_* / REACT_TRANSITION message. The one thing it cannot forge
 * is its own URL (the bridge stamps tabUrl in the ISOLATED world). state-store
 * therefore binds each graph to the origin that first wrote to it and rejects
 * writes claiming the same siteVersion from a different origin.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const store = require('../../server/state-store');

const SV = '__unit_origin_binding__';
const GRAPH_FILE = path.join(
  process.env.WHISKOR_GRAPH_DIR || fileURLToPath(new URL('../../cache/graphs/', import.meta.url)),
  `${SV}.json.gz`,
);

after(() => {
  try { fs.rmSync(GRAPH_FILE, { force: true }); } catch (_) {}
});

describe('state-graph origin binding', () => {
  it('first origin-carrying write claims the graph', () => {
    const node = store.addNode(SV, { hash: 'own1', url: 'https://good.example/a', origin: 'https://good.example' });
    assert.ok(node, 'owner write must succeed');
    assert.strictEqual(node.hash, 'own1');
  });

  it('a write claiming the same siteVersion from another origin is rejected', () => {
    const forged = store.addNode(SV, {
      hash: 'evil1',
      url: 'https://evil.example/pwn',
      origin: 'https://evil.example',
    });
    assert.strictEqual(forged, null, 'cross-origin node write must be rejected');
    assert.strictEqual(store.getNodeByHash(SV, 'evil1'), null, 'forged node must not exist');
  });

  it('cross-origin edge writes (forged replayAction) are rejected too', () => {
    const forged = store.addEdge(SV, {
      from: 'own1', to: 'evil1', action: 'click', trigger: 'Steal',
      replayAction: { type: 'click', selector: '#evil' },
      origin: 'https://evil.example',
    });
    assert.strictEqual(forged, null, 'cross-origin edge write must be rejected');
  });

  it('the owning origin can keep writing', () => {
    const node = store.addNode(SV, { hash: 'own2', url: 'https://good.example/b', origin: 'https://good.example' });
    assert.ok(node);
    const edge = store.addEdge(SV, { from: 'own1', to: 'own2', action: 'click', trigger: 'Next', origin: 'https://good.example' });
    assert.ok(edge, 'owner edge write must succeed');
  });

  it('origin-less writers (tests, direct WS clients) bypass the check and never claim ownership', () => {
    // Nothing page-forged arrives without a bridge tabUrl, so no-origin means a
    // trusted local writer: allowed, and must not steal the binding.
    const node = store.addNode(SV, { hash: 'own3', url: 'https://good.example/c' });
    assert.ok(node, 'origin-less write allowed');
    const stillOwner = store.addNode(SV, { hash: 'own4', url: 'https://good.example/d', origin: 'https://good.example' });
    assert.ok(stillOwner, 'original owner still accepted after an origin-less write');
    const stillForged = store.addNode(SV, { hash: 'evil2', origin: 'https://evil.example' });
    assert.strictEqual(stillForged, null, 'attacker still rejected after an origin-less write');
  });
});
