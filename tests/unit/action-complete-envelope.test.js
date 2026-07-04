/**
 * tests/unit/action-complete-envelope.test.js
 * Anti-drift guard for the ACTION_COMPLETE reply envelope (page → background).
 *
 * Regression this locks (v0.4.0 → v0.12.0, commit 6f386b7,
 * docs/postmortems/2026-07-04-action-timeout.md):
 *
 *   The injected executor posts the action reply as
 *     { __BROWSER_WHISKOR__, type:'ACTION_COMPLETE', payload:{ listenerId, ok, result, error } }
 *   bridge.js (ISOLATED world) relays ONLY `event.data.payload` through
 *   chrome.runtime.sendMessage — every sibling of `payload` is dropped. So the
 *   background executeInPage() listener MUST read listenerId/ok/result/error from
 *   `message.payload`, not the top level.
 *
 *   In v0.4.0 the executor emitted those fields at the TOP LEVEL of the message and
 *   the listener read them from the top level too. Locally the shapes "agreed", but
 *   bridge.js silently stripped them in transit, so ACTION_COMPLETE never matched a
 *   pending listenerId and every page action (click/type/…) timed out. Nothing in CI
 *   failed because no test spans the executor → bridge → background hop.
 *
 * This test statically cross-checks the producer (shared/injected/executor.js) against
 * the consumers (extension/background/sw.js + firefox-mv2/background/background.js) and
 * the relay (bridge.js), so any of these drifting again fails loudly:
 *   - the reply fields must live INSIDE `payload` (not flat on the message),
 *   - bridge.js must forward `payload: event.data.payload`,
 *   - each background listener must read those fields from `<msg>.payload`,
 *   - every field a listener reads must actually be emitted by the producer.
 *
 * The envelope shape lives in ONE place — CONTRACT below — and both ends are checked
 * against it AND against each other, so producer and consumer cannot silently disagree.
 */
// @allow-no-prod-import: static contract checker — reads the production sources
// (injected executor + bridge + background service workers) with fs and cross-checks
// the message envelope. Injected/background files cannot be require()d in node
// (MAIN world / service-worker globals), so there is nothing to import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

// ── The canonical ACTION_COMPLETE envelope (single source of truth) ────────────
const CONTRACT = {
  // Keys allowed at the TOP LEVEL of the ACTION_COMPLETE postMessage. The reply
  // fields must NOT appear here — that was the v0.4.0 bug (bridge drops them).
  outerKeys: ['__BROWSER_WHISKOR__', 'type', 'payload'],
  // Reply fields that MUST live inside `payload` (the only thing bridge relays).
  replyFields: ['listenerId', 'ok', 'result', 'error'],
  // The correlation id: without a match on this the listener never resolves.
  linkField: 'listenerId',
};

const PRODUCERS = [
  'shared/injected/executor.js',   // canonical source
  'extension/injected/executor.js',
  'firefox-mv2/injected/executor.js',
];
const CONSUMERS = [
  'extension/background/sw.js',
  'firefox-mv2/background/background.js',
];
const RELAYS = [
  'extension/injected/bridge.js',
  'firefox-mv2/injected/bridge.js',
];

// ── Tiny brace/paren-aware object parser (strings in these blocks contain no
// braces, so the naive depth scan is sufficient — same pragmatism as the existing
// injected-server-contract test) ──────────────────────────────────────────────
function extractBalanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(openIdx, i + 1);
  }
  throw new Error('unbalanced brace from index ' + openIdx);
}

function splitTopLevel(inner) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  return parts;
}

// Top-level keys of an object literal (as `{ ... }` text). Skips `...spread`
// entries so nested `{ dialogs }` inside a spread is never mistaken for a key.
function objectKeys(objText) {
  const inner = objText.slice(1, -1);
  const keys = [];
  for (let seg of splitTopLevel(inner)) {
    seg = seg.trim();
    if (!seg || seg.startsWith('...')) continue;
    const m = seg.match(/^([A-Za-z_$][\w$]*)\s*:/) || seg.match(/^([A-Za-z_$][\w$]*)\s*$/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Locate the ACTION_COMPLETE postMessage and return { outerKeys, payloadKeys }.
function parseProducer(src) {
  const typeIdx = src.indexOf("type: 'ACTION_COMPLETE'");
  assert.ok(typeIdx !== -1, "producer must emit type: 'ACTION_COMPLETE'");
  // The message object literal opens at the first `{` after `postMessage(`.
  const openIdx = src.indexOf('{', src.lastIndexOf('postMessage(', typeIdx));
  const outer = extractBalanced(src, openIdx);
  const outerKeys = objectKeys(outer);

  const pIdx = outer.indexOf('payload:');
  assert.ok(pIdx !== -1, 'ACTION_COMPLETE must carry a `payload` object');
  const payload = extractBalanced(outer, outer.indexOf('{', pIdx));
  return { outerKeys, payloadKeys: objectKeys(payload) };
}

// Find the executeInPage ACTION_COMPLETE listener and return the fields it reads
// off the payload-or-fallback local (`const r = <msg>.payload || <msg>`).
function parseConsumer(src) {
  const m = src.match(/const\s+(\w+)\s*=\s*(\w+)\.payload\s*\|\|\s*\2\b/);
  assert.ok(m, 'consumer must read the reply via `<msg>.payload || <msg>`');
  const [, local] = m;
  const body = src.slice(m.index, m.index + 400);
  const reads = new Set();
  const re = new RegExp('\\b' + local + '\\.([A-Za-z_$][\\w$]*)', 'g');
  let g;
  while ((g = re.exec(body))) reads.add(g[1]);
  return reads;
}

describe('ACTION_COMPLETE reply envelope contract', () => {
  it('the producer nests every reply field inside `payload` (never flat on the message)', () => {
    for (const rel of PRODUCERS) {
      const { outerKeys, payloadKeys } = parseProducer(read(rel));

      // Top level carries only the envelope meta + payload. If a reply field ever
      // reappears here it is the exact v0.4.0 shape bridge.js silently strips.
      assert.deepStrictEqual(
        [...outerKeys].sort(), [...CONTRACT.outerKeys].sort(),
        `${rel}: ACTION_COMPLETE top-level keys must be exactly ${CONTRACT.outerKeys.join(', ')} ` +
        `(reply fields belong under payload — bridge.js relays only payload)`,
      );
      for (const f of CONTRACT.replyFields) {
        assert.ok(
          payloadKeys.includes(f),
          `${rel}: reply field '${f}' must be inside the ACTION_COMPLETE payload`,
        );
        assert.ok(
          !outerKeys.includes(f),
          `${rel}: reply field '${f}' leaked to the message top level — bridge.js will drop it`,
        );
      }
    }
  });

  it('bridge.js relays only `payload` — which is why the reply must nest there', () => {
    for (const rel of RELAYS) {
      assert.match(
        read(rel), /payload:\s*event\.data\.payload/,
        `${rel}: bridge must forward payload: event.data.payload`,
      );
    }
  });

  it('each background listener reads the reply from payload, and only fields the producer emits', () => {
    const { payloadKeys } = parseProducer(read(PRODUCERS[0]));
    for (const rel of CONSUMERS) {
      const src = read(rel);
      // The `<msg>.payload || <msg>` form (asserted by parseConsumer) guarantees the
      // listener looks in the nested location first — a flat-only read would regress.
      const reads = parseConsumer(src);

      assert.ok(
        reads.has(CONTRACT.linkField),
        `${rel}: listener must correlate on '${CONTRACT.linkField}' or every action hangs to timeout`,
      );
      assert.ok(reads.has('ok'), `${rel}: listener must read 'ok' to decide resolve/reject`);
      assert.ok(
        reads.has('result') || reads.has('error'),
        `${rel}: listener must read 'result' and/or 'error'`,
      );
      // Every field the consumer reads must actually be produced. This catches the
      // opposite drift: the producer renaming/removing a field the listener depends on.
      for (const f of reads) {
        assert.ok(
          payloadKeys.includes(f),
          `${rel}: listener reads '${f}' from the reply, but the executor never puts it in payload ` +
          `(producer emits: ${payloadKeys.join(', ')})`,
        );
      }
    }
  });

  it('all injected executor copies emit an identical ACTION_COMPLETE payload shape', () => {
    const shapes = PRODUCERS.map(rel => parseProducer(read(rel)).payloadKeys.sort().join(','));
    for (let i = 1; i < shapes.length; i++) {
      assert.strictEqual(
        shapes[i], shapes[0],
        `${PRODUCERS[i]} payload shape drifted from ${PRODUCERS[0]} — re-run scripts/sync-shared.ps1`,
      );
    }
  });
});
