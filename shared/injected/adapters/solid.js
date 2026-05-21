/**
 * adapters/solid.js  –  MAIN world
 * SolidJS 1.x / 2.x 対応。
 *
 * SolidJS の課題:
 *   - 本番ビルドではランタイム所有者 (owner) APIへのアクセス手段がほぼ皆無
 *   - 開発ビルドでは window._$owner (Computation / Root owner) が存在
 *   - SSR: window._$HY に hydration data
 *   - ルーターは @solidjs/router が window.__SolidRouter__ を設定することがある
 *
 * 取得戦略 (インテリジェンス版):
 *   1. Dev mode: _$owner / __SOLID_DEVTOOLS__ owner tree を再帰走査
 *   2. 全モード: DOM上の Solid マーカー (data-hk, <!--!$--> コメント) を収集
 *   3. Stores: DevTools hook → window *solid* キー探査 → Context Provider 探査
 *      → シグナルプロキシ検出 → イベントハンドラクロージャ → 候補名総当たり (6層フェイルオーバー)
 *   4. Signals: owner tree走査で effects/memos/reaktive を分類抽出
 *   5. Router: window 露出 → owner tree内 location シグナル → URLフォールバック (3層)
 *   6. Version: window.solid → DevTools → SSRハイドレーション形式差分 (3層)
 *   7. Hydration: resources/fragments/state/nodes を構造化解析
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function safe(v, max) {
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'string') return v.length > (max || 200) ? v.slice(0, max || 200) + '\u2026' : v;
    try {
      const s = JSON.stringify(v);
      return s.length > (max || 500) ? '[truncated:' + s.length + ']' : JSON.parse(s);
    } catch { return '[circular]'; }
  }

  /**
   * Traverse the SolidJS owner tree (dev mode only).
   * Each Computation/Memo/Effect has: name, value, sources, owned (children)
   */
  function traverseOwner(owner, depth) {
    if (!owner || depth > 40) return null;
    const name = owner.name || owner.componentName || (owner.fn?.name) || null;

    const isComponent = name && !name.startsWith('_') && !['runEffects', 'batch'].includes(name);
    if (!isComponent && depth > 2) {
      const childResults = [];
      for (const child of (owner.owned || [])) {
        const c = traverseOwner(child, depth + 1);
        if (c) childResults.push(c);
      }
      return childResults.length ? { name: '(anon)', depth, children: childResults } : null;
    }

    const node = { name: name || '(root)', depth, children: [] };

    if ('value' in owner) {
      try { node.value = safe(owner.value, 300); } catch (_) {}
    }

    if (owner.sources?.length) {
      node.sourceCount = owner.sources.length;
    }

    if (owner.sources?.length && owner.sources.length <= 20) {
      const signals = [];
      for (const src of owner.sources) {
        if (src && typeof src === 'object') {
          const sigInfo = { name: src.name || src.key || '(anon)' };
          if ('value' in src) sigInfo.value = safe(src.value, 150);
          if ('observers' in src) sigInfo.observerCount = src.observers?.length || 0;
          signals.push(sigInfo);
        }
      }
      if (signals.length) node.signals = signals;
    }

    for (const child of (owner.owned || [])) {
      const c = traverseOwner(child, depth + 1);
      if (c) {
        if (Array.isArray(c)) node.children.push(...c);
        else node.children.push(c);
      }
    }

    return node;
  }

  // ── Stores 検出 (6層フェイルオーバー) ────────────────────────────────────

  function collectStoresViaDevTools() {
    try {
      const dt = window.__SOLID_DEVTOOLS__;
      if (!dt) return null;
      const stores = {};
      const storeReg = dt.stores || dt.storeRegistry || dt._stores;
      if (storeReg) {
        if (storeReg instanceof Map) {
          storeReg.forEach(function(store, key) {
            try { stores[key] = safe(store.state || store, 1000); } catch (_) {}
          });
        } else if (typeof storeReg === 'object') {
          for (const k of Object.keys(storeReg)) {
            try { stores[k] = safe(storeReg[k].state || storeReg[k], 1000); } catch (_) {}
          }
        }
      }
      return Object.keys(stores).length ? { stores, detectedVia: 'devtools-hook' } : null;
    } catch (_) { return null; }
  }

  function collectStoresViaWindowScan() {
    try {
      const stores = {};
      const patterns = [/solid/i, /store/i, /state/i, /app/i];
      const skipKeys = new Set([
        'document', 'navigator', 'history', 'location', 'performance',
        'sessionStorage', 'localStorage', 'console', 'crypto',
        'solidStart', 'solidStartConfig',
      ]);
      const keys = Object.keys(window);
      for (const k of keys) {
        if (k.startsWith('_') || skipKeys.has(k)) continue;
        if (!patterns.some(p => p.test(k))) continue;
        const v = window[k];
        if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Element) continue;
        const isStore = (
          (v.state && typeof v.state === 'object') ||
          (v.getState && typeof v.getState === 'function') ||
          (v.setField && typeof v.setField === 'function') ||
          (v._$owner !== undefined) ||
          (v.$$typeof !== undefined && typeof v.$$typeof === 'symbol')
        );
        if (isStore) {
          try {
            const stateVal = v.state || (v.getState && v.getState()) || v;
            stores[k] = safe(stateVal, 1000);
          } catch (_) { stores[k] = '[unserializable]'; }
        }
      }
      return Object.keys(stores).length ? { stores, detectedVia: 'window-scan' } : null;
    } catch (_) { return null; }
  }

  function collectStoresViaContextProviders() {
    try {
      const stores = {};
      const candidates = document.querySelectorAll('[data-solid-context], [data-store], [data-context]');
      for (const el of candidates) {
        for (const key of Object.keys(el)) {
          if (!key.startsWith('_') && !key.startsWith('on')) continue;
          const v = el[key];
          if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Element)) {
            if (v.state || v.context || v.value) {
              const storeKey = el.getAttribute('data-solid-context') ||
                               el.getAttribute('data-store') ||
                               el.getAttribute('data-context') || key;
              try { stores[storeKey] = safe(v.state || v.context || v.value, 500); } catch (_) {}
            }
          }
        }
      }
      return Object.keys(stores).length ? { stores, detectedVia: 'context-providers' } : null;
    } catch (_) { return null; }
  }

  function collectStoresViaSignalProxies() {
    try {
      const owner = window._$owner;
      if (!owner) return null;
      const stores = {};
      function scanForProxies(node, depth) {
        if (!node || depth > 15) return;
        const val = node.value;
        const name = node.name || '';
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const keyCount = Object.keys(val).length;
          if (keyCount >= 2 && keyCount <= 50) {
            const storeName = name || ('store_' + Object.keys(stores).length);
            if (!stores[storeName]) {
              stores[storeName] = safe(val, 800);
            }
          }
        }
        for (const child of (node.owned || [])) {
          scanForProxies(child, depth + 1);
        }
      }
      scanForProxies(owner, 0);
      return Object.keys(stores).length ? { stores, detectedVia: 'signal-proxies' } : null;
    } catch (_) { return null; }
  }

  function collectStoresViaEventHandlers() {
    try {
      const stores = {};
      const elements = document.querySelectorAll('[onclick], [onchange], [onsubmit], [oninput]');
      for (const el of elements) {
        for (const key of Object.keys(el)) {
          if (!key.startsWith('on') || key === 'onclick' || key === 'onchange') continue;
          const handler = el[key];
          if (typeof handler !== 'function') continue;
          try {
            const src = handler.toString();
            const storeMatches = src.match(/(\w+)\.state\b/g);
            if (storeMatches) {
              for (const m of storeMatches) {
                const storeName = m.replace('.state', '');
                if (!stores[storeName]) {
                  stores[storeName] = '[store reference in closure]';
                }
              }
            }
          } catch (_) {}
        }
      }
      return Object.keys(stores).length ? { stores, detectedVia: 'event-closures' } : null;
    } catch (_) { return null; }
  }

  function collectStoresViaCandidates() {
    try {
      const stores = {};
      const candidates = [
        '__SOLID_STORE__', '__store__', 'store', '__app__',
        '__solidStore__', 'solidStore', 'appStore', '__STATE__',
        '__INITIAL_STATE__', 'initialState', 'preloadedState',
      ];
      for (const k of candidates) {
        try {
          const v = window[k];
          if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Element)) {
            stores[k] = safe(v, 1000);
          }
        } catch (_) {}
      }
      return Object.keys(stores).length ? { stores, detectedVia: 'candidate-names' } : null;
    } catch (_) { return null; }
  }

  function collectStores() {
    const layers = [
      collectStoresViaDevTools,
      collectStoresViaWindowScan,
      collectStoresViaContextProviders,
      collectStoresViaSignalProxies,
      collectStoresViaEventHandlers,
      collectStoresViaCandidates,
    ];
    for (const layer of layers) {
      try {
        const result = layer();
        if (result) return result;
      } catch (_) {}
    }
    return null;
  }

  // ── Router 検出 (3層フェイルオーバー) ────────────────────────────────────

  function collectRouterViaWindow() {
    try {
      const r = window.__SolidRouter__ || window.__solid_router__ ||
                window.__SOLID_ROUTER__ || window.solidRouter;
      if (r) {
        const loc = r.location || r.current || r.state?.location;
        if (loc) {
          return {
            detectedVia: 'window-exposed',
            pathname: loc.pathname || null,
            search: loc.search || null,
            hash: loc.hash || null,
            state: safe(loc.state, 300),
          };
        }
      }
    } catch (_) {}
    return null;
  }

  function collectRouterViaOwnerTree() {
    try {
      const owner = window._$owner;
      if (!owner) return null;
      function findLocationSignal(node, depth) {
        if (!node || depth > 20) return null;
        const name = node.name || '';
        if (name.includes('location') || name.includes('Location') || name.includes('route') || name.includes('Route')) {
          const val = node.value;
          if (val && typeof val === 'object') {
            return {
              detectedVia: 'owner-tree',
              componentName: name,
              pathname: val.pathname || null,
              search: val.search || null,
              hash: val.hash || null,
              state: safe(val.state, 300),
            };
          }
        }
        for (const child of (node.owned || [])) {
          const found = findLocationSignal(child, depth + 1);
          if (found) return found;
        }
        return null;
      }
      return findLocationSignal(owner, 0);
    } catch (_) { return null; }
  }

  function collectRouterFallback() {
    try {
      return {
        detectedVia: 'url-fallback',
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
        note: 'Router instance not found; using current URL as fallback.',
      };
    } catch (_) { return null; }
  }

  function collectRouter() {
    return collectRouterViaWindow() || collectRouterViaOwnerTree() || collectRouterFallback();
  }

  // ── Version 検出 (3層フェイルオーバー) ───────────────────────────────────

  function detectVersion() {
    try { if (window.solid?.version) return window.solid.version; } catch (_) {}
    try { if (window.__SOLID_DEVTOOLS__?.version) return window.__SOLID_DEVTOOLS__.version; } catch (_) {}
    try {
      if (window._$HY) {
        if (window._$HY.r !== undefined) return '1.x (SSR inferred)';
        if (window._$HY.s !== undefined) return '2.x (SSR inferred)';
        return '1.x/2.x (SSR inferred)';
      }
    } catch (_) {}
    return null;
  }

  // ── Signal 検出 (owner tree走査で effects/memos/reactive を分類) ─────────

  function collectSignals() {
    const signals = { reactive: [], effects: 0, memos: 0 };
    try {
      const owner = window._$owner;
      if (owner) {
        function scanSignals(node, depth) {
          if (!node || depth > 20) return;
          const name = node.name || '';
          if ('value' in node && 'sources' in node) {
            if (typeof node.value === 'function' || node.fn) {
              signals.effects++;
            } else {
              signals.memos++;
              if (name && !name.startsWith('_')) {
                signals.reactive.push({
                  name,
                  value: safe(node.value, 200),
                  sources: node.sources?.length || 0,
                });
              }
            }
          }
          for (const child of (node.owned || [])) {
            scanSignals(child, depth + 1);
          }
        }
        scanSignals(owner, 0);
      }
    } catch (_) {}
    if (signals.reactive.length > 50) {
      signals.reactive = signals.reactive.slice(0, 50);
      signals.reactiveTruncated = true;
    }
    return (signals.effects || signals.memos || signals.reactive.length) ? signals : null;
  }

  // ── Hydration comment analysis (enhanced) ────────────────────────────────

  function analyzeHydrationComments() {
    const result = { start: 0, end: 0, dynamic: 0, components: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      if (v === '!$') result.start++;
      else if (v === '/$') result.end++;
      else if (v === '!') result.dynamic++;
      else if (v === '/') result.dynamic++;
      else if (v.startsWith('!$') || v.startsWith('/$')) {
        result.components.push(v);
      }
    }
    if (result.components.length > 100) result.components = result.components.slice(0, 100);
    return result;
  }

  // ── SSR hydration data (構造化解析) ──────────────────────────────────────

  function collectHydrationData() {
    if (!window._$HY) return null;
    const hy = window._$HY;
    const result = {};
    if (hy.r && typeof hy.r === 'object') {
      try { result.resources = safe(hy.r, 2000); } catch (_) {}
    }
    if (hy.f && typeof hy.f === 'object') {
      try { result.fragments = safe(hy.f, 1000); } catch (_) {}
    }
    if (hy.s && typeof hy.s === 'object') {
      try { result.state = safe(hy.s, 2000); } catch (_) {}
    }
    if (hy.nodes && typeof hy.nodes === 'object') {
      try { result.nodes = safe(hy.nodes, 1000); } catch (_) {}
    }
    return Object.keys(result).length ? result : null;
  }

  // ── Plugin registration ──────────────────────────────────────────────────

  registry.register({
    id: 'solid-js', name: 'SolidJS Analyzer', version: '2.0.0',
    runAt: 'load', realtime: false, priority: 10,
    emitType: 'SOLID_SNAPSHOT', cacheTarget: 'solid/',

    detect() {
      return !!(
        window._$HY ||
        window._$owner ||
        window.__SOLID_DEVTOOLS__ ||
        window.solid ||
        document.querySelector('[data-hk]') ||
        (() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
          const n = walker.nextNode();
          return n?.nodeValue === '!$';
        })()
      );
    },

    install(api) {
      try {
        if (window.__SOLID_DEVTOOLS__) {
          window.__SOLID_DEVTOOLS__.register?.('browser-whiskor');
        }
      } catch (_) {}
    },

    collect(api) {
      let ownerTree = null;
      const devMode = !!(window._$owner);
      if (devMode) {
        try { ownerTree = traverseOwner(window._$owner, 0); } catch (_) {}
      }

      const hyData = collectHydrationData();
      const hydrationKeys = [...document.querySelectorAll('[data-hk]')]
        .map(el => el.getAttribute('data-hk')).slice(0, 200);
      const hydrationComments = analyzeHydrationComments();
      const stores = collectStores();
      const router = collectRouter();
      const signals = collectSignals();
      const version = detectVersion();

      return {
        capturedAt: Date.now(),
        framework: 'solid',
        version,
        devMode,
        ownerTree,
        hyData,
        hydrationKeys,
        hydrationComments,
        stores,
        router,
        signals,
        note: devMode
          ? null
          : 'SolidJS production build: owner tree not available. Only SSR markers, stores, and signals collected.',
      };
    },
  });
})();
