/**
 * tests/unit/delta-flush-sink.test.js
 *
 * Exercises the REAL server/delta-engine.js flush sink. The bug this guards
 * against: timer-driven flushes (the common case — quiet pages never fill the
 * 5-frame buffer within 1.5s) computed an aggregate and then DROPPED it,
 * leaving get_delta / raw/delta/smart.json empty forever. The sink is how a
 * timer flush reaches cache.storeSmartDelta (wired in index.js).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate the pattern registry BEFORE loading delta-engine: test processes run
// in parallel and the shared default dir races clearAll() vs saveIndex().
process.env.WHISKOR_PATTERN_DIR = join(tmpdir(), `whiskor-patterns-${process.pid}`);

const require = createRequire(import.meta.url);
const engine = require('../../server/delta-engine');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const frame = () => ({ timestamp: Date.now(), viewport: null, deltas: [] });

beforeEach(() => engine.resetAll());
afterEach(() => { engine.setFlushSink(null); engine.resetAll(); });

describe('delta-engine flush sink', () => {
  it('delivers a timer-driven flush to the sink (the silent-drop bug)', async () => {
    const received = [];
    engine.setFlushSink((tabId, delta) => received.push({ tabId, delta }));

    // One frame: well under MAX_BUFFER_SIZE, so only the AGGREGATE_INTERVAL
    // timer can ever flush it.
    assert.strictEqual(engine.addFrame(42, frame()), null);

    await sleep(engine.AGGREGATE_INTERVAL + 300);
    assert.strictEqual(received.length, 1, 'timer flush must reach the sink');
    assert.strictEqual(received[0].tabId, 42);
    assert.strictEqual(received[0].delta.frame_count, 1);
  });

  it('full-buffer flush still returns synchronously through addFrame (and only once)', async () => {
    const received = [];
    engine.setFlushSink((tabId, delta) => received.push({ tabId, delta }));

    let returned = null;
    for (let i = 0; i < engine.MAX_BUFFER_SIZE; i++) {
      returned = engine.addFrame(7, frame());
    }
    assert.ok(returned, 'filling the buffer must return the aggregate to the caller');
    assert.strictEqual(returned.frame_count, engine.MAX_BUFFER_SIZE);

    // The buffer is now empty — the pending timer must not double-deliver.
    await sleep(engine.AGGREGATE_INTERVAL + 300);
    assert.strictEqual(received.length, 0, 'a full-buffer flush must not also hit the sink');
  });

  it('without a sink the timer flush is still safe (no throw, buffer cleared)', async () => {
    engine.addFrame(9, frame());
    await sleep(engine.AGGREGATE_INTERVAL + 300);
    assert.strictEqual(engine.getBufferState(9).frames, 0);
  });
});
