/**
 * tests/unit/state-fingerprint-nd.test.js
 * Non-deterministic value filter — key-aware / aggressive / off modes.
 *
 * Verifies the server-side filterNd mirrors the client (react.js) spec:
 *   - key-aware (default): legitimate numeric IDs survive; volatile values
 *     (temporal keys, UUID, ISO-8601) are normalized away.
 *   - aggressive: blind 13-digit / 32+ random heuristic restored.
 *   - off: no value filtering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fp = require('../../server/state-fingerprint');

describe('filterNd — key-aware (default)', () => {
  it('keeps a legitimate 13-digit numeric id (non-temporal key)', () => {
    const out = fp.filterNd({ orderId: 1748000000000 });
    assert.equal(out.orderId, 1748000000000, '13-digit id under a non-temporal key must survive');
  });

  it('strips a 13-digit value under a temporal key (not in excludeKeys)', () => {
    const out = fp.filterNd({ renderedAt: 1748000000000 });
    assert.equal(out.renderedAt, '__TS__');
  });

  it('drops default excludeKeys entirely', () => {
    const out = fp.filterNd({ createdAt: 123, keep: 'x' });
    assert.ok(!('createdAt' in out));
    assert.equal(out.keep, 'x');
  });

  it('normalizes UUID and ISO-8601 regardless of key', () => {
    const out = fp.filterNd({
      ref: '550e8400-e29b-41d4-a716-446655440000',
      when: '2026-06-01T12:34:56Z',
    });
    assert.equal(out.ref, '__UUID__');
    assert.equal(out.when, '__TS__');
  });

  it('keeps a long random-looking string when the key is NOT temporal', () => {
    const slug = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = fp.filterNd({ productSlug: slug });
    assert.equal(out.productSlug, slug);
  });

  it('honours extra excludeKeys from config', () => {
    const out = fp.filterNd({ sessionToken: 'keep-me', other: 1 }, { excludeKeys: ['sessionToken'] });
    assert.ok(!('sessionToken' in out));
    assert.equal(out.other, 1);
  });

  it('recurses through nested objects with key context', () => {
    const out = fp.filterNd({ meta: { renderedAt: 1748000000000, id: 1748000000000 } });
    assert.equal(out.meta.renderedAt, '__TS__', 'temporal key normalized');
    assert.equal(out.meta.id, 1748000000000, 'id is not a temporal key — survives');
  });
});

describe('filterNd — aggressive', () => {
  it('strips bare 13-digit numbers regardless of key', () => {
    const out = fp.filterNd({ orderId: 1748000000000 }, { mode: 'aggressive' });
    assert.equal(out.orderId, '__TS__');
  });

  it('strips 32+ char random strings regardless of key', () => {
    const slug = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = fp.filterNd({ productSlug: slug }, { mode: 'aggressive' });
    assert.equal(out.productSlug, '__RAND__');
  });
});

describe('filterNd — off', () => {
  it('performs no value filtering', () => {
    const out = fp.filterNd({ updatedAt: 1748000000000, ref: '550e8400-e29b-41d4-a716-446655440000' }, { mode: 'off' });
    assert.equal(out.updatedAt, 1748000000000);
    assert.equal(out.ref, '550e8400-e29b-41d4-a716-446655440000');
  });
});

describe('computeReactHash — stability under volatile props', () => {
  it('ignores a changing temporal prop (key-aware) so the hash is stable', () => {
    const treeA = { n: 'App', p: { lastRenderAt: 1748000000000 }, c: [] };
    const treeB = { n: 'App', p: { lastRenderAt: 1748000099999 }, c: [] };
    const a = fp.computeReactHash(treeA, '/', []);
    const b = fp.computeReactHash(treeB, '/', []);
    assert.equal(a, b, 'a changing timestamp prop must not change the hash');
  });

  it('still distinguishes a meaningful prop change', () => {
    const treeA = { n: 'App', p: { tab: 'home' }, c: [] };
    const treeB = { n: 'App', p: { tab: 'settings' }, c: [] };
    assert.notEqual(fp.computeReactHash(treeA, '/', []), fp.computeReactHash(treeB, '/', []));
  });
});
