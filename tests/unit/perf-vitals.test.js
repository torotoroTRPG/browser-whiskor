/**
 * tests/unit/perf-vitals.test.js
 * Design-drift fix — Core Web Vitals were observed but never persisted.
 *
 * perf.js installs PerformanceObservers for LCP/CLS/FCP/long-tasks, but it used to
 * realtime-emit them under PERF_LCP/CLS/FCP/LONG_TASK — types the server drops — so
 * the vitals reached nothing, and collect() (the working PERF_METRICS path) omitted
 * them. This loads the REAL shared/injected/analyzers/perf.js in a vm with fake
 * PerformanceObserver/performance, drives install() then collect(), and asserts the
 * vitals are folded into the collected payload.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '../../shared/injected/analyzers/perf.js');

let plugin;       // the registered perf plugin object
let observers;    // observe type -> callback
let collected;    // collect() result

function fire(type, entries) {
  const cb = observers[type];
  assert.ok(cb, `an observer should be registered for ${type}`);
  cb({ getEntries: () => entries });
}

before(() => {
  observers = {};
  function FakePO(cb) { this._cb = cb; }
  FakePO.prototype.observe = function (opts) { observers[opts.type] = this._cb; };

  const performance = {
    getEntriesByType: (t) => t === 'navigation'
      ? [{ responseStart: 50, domContentLoadedEventEnd: 120, loadEventEnd: 300, transferSize: 1000 }]
      : [],
    memory: { usedJSHeapSize: 11, totalJSHeapSize: 22 },
  };

  const win = { __SI_REGISTRY__: { register: (p) => { plugin = p; } }, console };
  win.window = win;
  const sandbox = { window: win, console, PerformanceObserver: FakePO, performance };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox);

  assert.ok(plugin && typeof plugin.install === 'function', 'perf plugin registered');
  assert.strictEqual(plugin.emitType, 'PERF_METRICS', 'collect output must land under the consumed type');

  const api = {};
  plugin.install(api);
  // Drive each observer with representative entries.
  fire('largest-contentful-paint', [{ startTime: 100, element: { tagName: 'IMG' } }, { startTime: 250, element: { tagName: 'H1' } }]);
  fire('layout-shift', [{ value: 0.05, hadRecentInput: false }, { value: 0.10, hadRecentInput: true }]);
  fire('longtask', [{ duration: 60 }, { duration: 80 }]);
  fire('paint', [{ name: 'first-contentful-paint', startTime: 90 }]);

  collected = plugin.collect(api);
});

describe('perf collect() folds in Core Web Vitals', () => {
  it('still returns navigation timing + memory (unchanged)', () => {
    assert.strictEqual(collected.navigation.ttfb, 50);
    assert.strictEqual(collected.navigation.load, 300);
    // cross-realm object → compare fields, not deepStrictEqual
    assert.strictEqual(collected.memory.usedJSHeapSize, 11);
    assert.strictEqual(collected.memory.totalJSHeapSize, 22);
  });

  it('LCP keeps the last (largest) entry + its element', () => {
    assert.strictEqual(collected.vitals.lcp, 250);
    assert.strictEqual(collected.vitals.lcpElement, 'H1');
  });

  it('CLS sums only shifts without recent input', () => {
    assert.strictEqual(collected.vitals.cls, 0.05);
  });

  it('FCP is the first-contentful-paint start time', () => {
    assert.strictEqual(collected.vitals.fcp, 90);
  });

  it('long tasks are counted with total blocking time', () => {
    assert.strictEqual(collected.vitals.longTasks, 2);
    assert.strictEqual(collected.vitals.longTaskTotalMs, 140);
  });
});
