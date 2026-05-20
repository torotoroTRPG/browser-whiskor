/**
 * injected/collector.js  –  MAIN world, document_start
 * Entry point. Wires all adapters, analyzers, and new modules.
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) { console.error('[whiskor] registry not found'); return; }
  if (window.__SI_COLLECTOR_INIT__) return;
  window.__SI_COLLECTOR_INIT__ = true;

  // ── Emit helper ────────────────────────────────────────────────────────────
  function emit(type, payload) {
    window.postMessage({ __SITE_INSPECTOR__: true, type, payload }, '*');
  }

  // ── Wire console-logger ────────────────────────────────────────────────────
  if (window.__SI_CONSOLE_LOGGER__) {
    window.__SI_CONSOLE_LOGGER__.setEmit(emit);
  }

  // ── 1. Install document_start plugins ─────────────────────────────────────
  registry.installAll();

  // ── 2. DOMContentLoaded ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDOMReady, { once: true });
  } else {
    setTimeout(onDOMReady, 0);
  }

  // ── 3. window load ────────────────────────────────────────────────────────
  window.addEventListener('load', onLoad, { once: true });

  // ── 4. Message router ─────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d?.__SITE_INSPECTOR__) return;

    switch (d.type) {
      case 'CONFIG_UPDATE':
        registry.updateConfig(d.payload);
        try { sessionStorage.setItem('__SI_CONFIG__', JSON.stringify(d.payload)); } catch (_) {}
        if (window.__SI_CONSOLE_LOGGER__) window.__SI_CONSOLE_LOGGER__.setConfig(d.payload);
        break;

      case 'MANUAL_COLLECT': {
        const ids = d.payload?.plugins;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (id === 'storage-reader') { collectStorage(); continue; }
            if (id === 'console-logger') {
              if (window.__SI_CONSOLE_LOGGER__) window.__SI_CONSOLE_LOGGER__.flush(); continue;
            }
            registry.runPlugin(id);
          }
        } else {
          registry.runAt('manual');
          collectStorage();
        }
        break;
      }
    }
  });

  // ── Framework detection ────────────────────────────────────────────────────
  window.addEventListener('load', () => {
    setTimeout(() => {
      const detected = [...(registry._plugins?.values() || [])]
        .filter(p => { try { return p.detect?.(); } catch { return false; } })
        .map(p => ({ id: p.id, name: p.name, frameworkId: p.frameworkId || null }));
      emit('FRAMEWORK_DETECTION', { capturedAt: Date.now(), url: location.href, detected });
    }, 200);
  }, { once: true });

  function onDOMReady() {
    setTimeout(() => registry.runAt('DOMContentLoaded'), 150);
  }

  function onLoad() {
    setTimeout(() => {
      registry.runAt('load');
      collectStorage();
    }, 400);

    // Source catalog
    setTimeout(() => {
      const resources = performance.getEntriesByType('resource').map(r => ({
        url: r.name, type: r.initiatorType,
        duration: Math.round(r.duration), transferSize: r.transferSize,
        startTime: Math.round(r.startTime),
      }));
      emit('SOURCE_CATALOG', { capturedAt: Date.now(), resources });
    }, 600);
  }

  function collectStorage() {
    if (window.__SI_STORAGE_READER__) {
      try { emit('STORAGE_SNAPSHOT', window.__SI_STORAGE_READER__.collect()); } catch (_) {}
    }
  }

})();
