/**
 * adapters/alpine.js  –  MAIN world
 * Alpine.js v2 / v3 両対応。
 * - コンポーネント ($data / _x_dataStack)
 * - Alpine.store() グローバルストア (v3)
 * - Alpine 2 グローバルコンポーネント定義
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function safeClone(obj, maxLen) {
    if (obj == null || typeof obj !== 'object' && typeof obj !== 'string') return obj;
    try {
      const s = JSON.stringify(obj);
      if (maxLen && s.length > maxLen) return '[truncated:' + s.length + ']';
      return JSON.parse(s);
    } catch { return '[unserializable]'; }
  }

  registry.register({
    id: 'alpine-js', name: 'Alpine.js Analyzer', version: '2.0.0',
    runAt: 'load', realtime: false, priority: 10,
    emitType: 'ALPINE_SNAPSHOT', cacheTarget: 'alpine/',

    detect() {
      return !!(window.Alpine || document.querySelector('[x-data]'));
    },
    install(api) {},

    collect(api) {
      const Alpine = window.Alpine;
      const version = Alpine?.version || (window.Alpine2?.version) || null;
      const isMajor3 = version ? parseInt(version) >= 3 : !!Alpine?.store;

      // ── コンポーネント収集 ─────────────────────────────────────────────
      const components = [];
      document.querySelectorAll('[x-data]').forEach(el => {
        const entry = {
          tag:   el.tagName.toLowerCase(),
          id:    el.id || null,
          xData: el.getAttribute('x-data') || null,
          data:  null,
        };

        // Alpine v3: el._x_dataStack is an array of merged data objects
        if (el._x_dataStack && Array.isArray(el._x_dataStack)) {
          try {
            // Merge the stack (like Alpine does internally)
            const merged = Object.assign({}, ...el._x_dataStack.map(layer => {
              // Filter out functions and Alpine internals
              const clean = {};
              for (const k of Object.keys(layer)) {
                if (k.startsWith('$') || k.startsWith('_x_')) continue;
                const v = layer[k];
                if (typeof v === 'function') continue;
                try { clean[k] = JSON.parse(JSON.stringify(v).slice(0, 300)); }
                catch { clean[k] = '[fn/circular]'; }
              }
              return clean;
            }));
            entry.data = merged;
          } catch (_) {}
        }

        // Alpine v2: el.__x?.getUnobservedData()
        if (!entry.data && el.__x) {
          try { entry.data = safeClone(el.__x.getUnobservedData(), 1000); } catch (_) {}
        }

        // Fallback: try _x_effects / _x_bindings names
        if (!entry.data) {
          try { entry.data = safeClone(el._x_data, 500); } catch (_) {}
        }

        components.push(entry);
      });

      // ── グローバルストア収集 (v3) ──────────────────────────────────────
      // Alpine.store(name) returns the store proxy for that name.
      // Internal registry is at Alpine._stores (private but accessible).
      const stores = {};
      if (isMajor3 && Alpine) {
        try {
          // Primary: access internal _stores map
          const storeMap = Alpine._stores;
          if (storeMap && typeof storeMap === 'object') {
            for (const k of Object.keys(storeMap)) {
              try { stores[k] = safeClone(Alpine.store(k), 500); } catch { stores[k] = '[unserializable]'; }
            }
          }
        } catch (_) {}
        // If _stores wasn't accessible, try probing via Alpine.store(key) for known patterns
      }

      // Alpine v2: window.Alpine.components (registered components)
      const registeredComponents = {};
      if (!isMajor3 && Alpine?.components) {
        try {
          for (const [name] of Object.entries(Alpine.components)) {
            registeredComponents[name] = true; // just record names; functions aren't serializable
          }
        } catch (_) {}
      }

      return {
        capturedAt: Date.now(),
        framework: 'alpine',
        version,
        components,
        stores,
        registeredComponents: Object.keys(registeredComponents),
      };
    },
  });
})();
