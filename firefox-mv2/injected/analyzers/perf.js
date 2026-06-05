/**
 * analyzers/perf.js  –  MAIN world
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  registry.register({
    id: 'perf-observer', name: 'Performance Observer', version: '1.0.0',
    runAt: 'document_start', realtime: true, priority: 3,
    // collect() returns the aggregate metrics; the plugin runner emits them under
    // this type. The server writes raw/perf/metrics.json on PERF_METRICS (it does
    // not handle the granular PERF_LCP/CLS/FCP/LONG_TASK realtime emits), so this
    // MUST be PERF_METRICS or the Perf data never lands. (Was 'PERF_LCP' → dropped.)
    emitType: 'PERF_METRICS', cacheTarget: 'perf/',

    install(api) {
      // LCP
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            api.emit('PERF_LCP', { value: e.startTime, element: e.element?.tagName || null, ts: Date.now() }, true);
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {}

      // CLS
      try {
        let clsValue = 0;
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) clsValue += e.value;
          }
          api.emit('PERF_CLS', { value: clsValue, ts: Date.now() }, true);
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (_) {}

      // Long Tasks
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            api.emit('PERF_LONG_TASK', { duration: e.duration, startTime: e.startTime, ts: Date.now() }, true);
          }
        }).observe({ type: 'longtask' });
      } catch (_) {}

      // FCP
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint')
              api.emit('PERF_FCP', { value: e.startTime, ts: Date.now() }, true);
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    },

    collect(api) {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const resources = performance.getEntriesByType('resource').map(r => ({
        name: r.name, type: r.initiatorType,
        duration: Math.round(r.duration), transferSize: r.transferSize,
        startTime: Math.round(r.startTime),
      }));
      const memory = performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize }
        : null;

      return {
        capturedAt: Date.now(),
        navigation: {
          ttfb:           Math.round(nav.responseStart || 0),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
          load:           Math.round(nav.loadEventEnd || 0),
          transferSize:   nav.transferSize || 0,
        },
        resources: resources.slice(0, 200),
        memory,
      };
    },
  });
})();
