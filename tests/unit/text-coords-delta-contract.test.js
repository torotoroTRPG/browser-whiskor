/**
 * tests/unit/text-coords-delta-contract.test.js
 *
 * Field-level contract: text-coords TEXT_COORD_DELTA producer ↔ delta-engine
 * consumer. The type-level contract test (injected-server-contract.test.js)
 * verifies the message ARRIVES; this one verifies its FIELDS mean something.
 *
 * The original drift: delta-engine consumed {id, dx, dy, appeared, ...} while
 * the producer emitted {beaconId, absoluteX, absoluteY, textChanged, ...} — so
 * contentUpdates and appearances were ALWAYS empty and motion vectors were all
 * {0,0}. get_delta looked alive but carried almost nothing.
 *
 * Scope: Chrome (extension/injected). The Firefox analyzer has no seen-tracker
 * at all (no TEXT_COORD_DELTA emit) — a catch-up item, not a field drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate the pattern registry BEFORE loading delta-engine: test processes run
// in parallel and the shared default dir races clearAll() vs saveIndex().
process.env.WHISKOR_PATTERN_DIR = join(tmpdir(), `whiskor-patterns-${process.pid}`);

const require = createRequire(import.meta.url);
const deltaEngine = require('../../server/delta-engine');

const __dir = dirname(fileURLToPath(import.meta.url));
const producerSrc = readFileSync(
  join(__dir, '../../extension/injected/analyzers/text-coords.js'), 'utf8');

describe('TEXT_COORD_DELTA field contract (producer side, static)', () => {
  it('change deltas carry the movement vector and stable id', () => {
    // The recheck loop's delta push must include the fields delta-engine
    // clusters and filters on.
    for (const field of ['dx:', 'dy:', 'dw:', 'dh:', 'id:']) {
      assert.ok(producerSrc.includes(field),
        `producer must emit ${field.replace(':', '')} on change deltas`);
    }
  });

  it('appeared events are produced (MutationObserver path)', () => {
    assert.ok(producerSrc.includes('appeared: true'),
      'producer must emit appeared:true for elements added while tracking');
    assert.ok(producerSrc.includes('_pendingAppeared'),
      'appeared events queue until the next delta flush');
  });

  it('disappeared deltas carry an absolute position', () => {
    // entry only stores x/y — the disappeared push must translate to absoluteX/Y.
    const disappearBlock = producerSrc.match(/disappeared: true[\s\S]{0,300}/g) || [];
    assert.ok(producerSrc.match(/absoluteX:\s*entry\.x/),
      'disappeared deltas must map entry.x → absoluteX');
    assert.ok(disappearBlock.length >= 1, 'a disappeared emit path exists');
  });
});

describe('TEXT_COORD_DELTA field contract (consumer side, functional)', () => {
  // Frames shaped EXACTLY like the producer now emits them.
  const changeDelta = (over = {}) => ({
    id: 'b1', beaconId: 'b1', xpath: '/div[1]', text: '残り 4 個',
    absoluteX: 300, absoluteY: 120, dx: 0, dy: 0, dw: 0, dh: 0,
    width: 80, height: 20, inView: true, status: 'checking', changeCount: 1,
    textChanged: true, newText: '残り 4 個', ...over,
  });

  it('a pure text change lands in contentUpdates', () => {
    deltaEngine.resetAll();
    const smart = deltaEngine.buildSmartDelta(
      [{ timestamp: Date.now(), deltas: [changeDelta()] }], 'tab1');
    assert.ok(smart.content_updates, 'content_updates must not be null for a text change');
    assert.equal(smart.content_updates[0].id, 'b1');
    assert.equal(smart.content_updates[0].text, '残り 4 個');
  });

  it('an appeared element lands in appearances', () => {
    deltaEngine.resetAll();
    const appearedDelta = {
      id: 'b2', beaconId: 'b2', xpath: '/div[2]', text: '保存しました',
      absoluteX: 100, absoluteY: 50, width: 120, height: 20,
      elementType: 'div', appeared: true,
    };
    const smart = deltaEngine.buildSmartDelta(
      [{ timestamp: Date.now(), deltas: [appearedDelta] }], 'tab1');
    assert.ok(smart.appearances, 'appearances must not be null');
    assert.equal(smart.appearances[0].id, 'b2');
    assert.deepEqual(smart.appearances[0].pos, { x: 100, y: 50 });
  });

  it('a disappeared element keeps its last position', () => {
    deltaEngine.resetAll();
    const disappearedDelta = {
      id: 'b3', beaconId: 'b3', xpath: '/div[3]', text: 'モーダル',
      x: 200, y: 300, w: 100, h: 40, // tracker-entry shape (spread ...entry)
      absoluteX: 200, absoluteY: 300,
      status: 'removed', disappeared: true,
    };
    const smart = deltaEngine.buildSmartDelta(
      [{ timestamp: Date.now(), deltas: [disappearedDelta] }], 'tab1');
    assert.ok(smart.disappearances);
    assert.equal(smart.disappearances[0].id, 'b3');
    assert.deepEqual(smart.disappearances[0].lastPos, { x: 200, y: 300 });
  });

  it('moving elements cluster on the real vector, not {0,0}', () => {
    deltaEngine.resetAll();
    const moving = ['m1', 'm2'].map(id => changeDelta({
      id, beaconId: id, textChanged: false, newText: undefined, dx: 40, dy: 0,
    }));
    const smart = deltaEngine.buildSmartDelta(
      [{ timestamp: Date.now(), deltas: moving }], 'tab1');
    assert.equal(smart.motion_groups.length, 1);
    assert.deepEqual(smart.motion_groups[0].vector, { x: 40, y: 0 });
    assert.deepEqual(smart.motion_groups[0].sampleIds, ['m1', 'm2']);
  });
});
