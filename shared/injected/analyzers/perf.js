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
      // The PerformanceObserver callbacks accumulate Core Web Vitals into instance
      // state that collect() folds into the PERF_METRICS payload. (They used to be
      // realtime-emitted under PERF_LCP/CLS/FCP/LONG_TASK, which the server drops —
      // so the vitals never reached the cache at all.)
      this._vitals = { lcp: null, lcpElement: null, cls: 0, fcp: null, longTasks: 0, longTaskTotalMs: 0 };
      const v = this._vitals;

      // LCP — fires repeatedly; the last reported entry is the real LCP.
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            v.lcp = Math.round(e.startTime);
            v.lcpElement = e.element?.tagName || null;
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {}

      // CLS — cumulative layout shift (ignoring shifts within 500ms of input).
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) v.cls += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (_) {}

      // Long Tasks — count + total blocking time.
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            v.longTasks++;
            v.longTaskTotalMs += e.duration;
          }
        }).observe({ type: 'longtask' });
      } catch (_) {}

      // FCP
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint') v.fcp = Math.round(e.startTime);
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

      const v = this._vitals || {};
      return {
        capturedAt: Date.now(),
        navigation: {
          ttfb:           Math.round(nav.responseStart || 0),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
          load:           Math.round(nav.loadEventEnd || 0),
          transferSize:   nav.transferSize || 0,
        },
        vitals: {
          lcp:             v.lcp ?? null,            // Largest Contentful Paint (ms)
          lcpElement:      v.lcpElement ?? null,
          cls:             v.cls != null ? Math.round(v.cls * 1000) / 1000 : null, // Cumulative Layout Shift
          fcp:             v.fcp ?? null,            // First Contentful Paint (ms)
          longTasks:       v.longTasks || 0,
          longTaskTotalMs: Math.round(v.longTaskTotalMs || 0),
        },
        resources: resources.slice(0, 200),
        memory,
      };
    },
  });
})();
