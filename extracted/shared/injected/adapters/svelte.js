/**
 * adapters/svelte.js  –  MAIN world
 * Svelte 4 / Svelte 5 対応。
 *
 * Svelte の課題:
 *   - Svelte 4 本番ビルド: コンポーネントインスタンスが DOM に保持されない
 *     ($$target / $$anchor を持つ内部クラスのみ)
 *   - Svelte 5 (runes): 完全に新しい内部構造 (_$owner / Effect graph)
 *   - DevTools hook: Svelte 4 は window.__svelte_devtools_injection__ を設定
 *
 * 取得戦略:
 *   1. Svelte 4:
 *      - DOM ノードの $$component / __svelte_meta / _svelte マップを走査
 *      - window.__svelte (DevTools から注入される場合) を使用
 *      - data-svelte-h 属性でハッシュからコンポーネントを推定
 *   2. Svelte 5:
 *      - window.__svelte (SvelteKit が設定) の component registry
 *      - _$owner / effects チェーン (dev mode)
 *   3. Stores:
 *      - window のエクスポートで { subscribe, set, update } の形を持つものを収集
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function safe(v, max) {
    if (v == null) return v;
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'symbol') return v;
    try {
      const s = JSON.stringify(v);
      return s.length > max ? '[truncated:' + s.length + ']' : JSON.parse(s);
    } catch { return '[circular]'; }
  }

  /** Detect Svelte version from various signals */
  function detectVersion() {
    // Svelte 5 sets window.__svelte with {version} in SvelteKit
    if (window.__svelte?.version) return window.__svelte.version;
    // svelte/internal has VERSION export in some bundles
    if (window.svelte?.VERSION) return window.svelte.VERSION;
    // Heuristic: Svelte 5 uses data-svelte-h differently and has <!--[]--> comments
    const hasRuneMarkers = !!document.querySelector('svelte-fragment') ||
      (() => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
        let n; while ((n = w.nextNode())) { if (n.nodeValue === '[' || n.nodeValue === ']') return true; }
        return false;
      })();
    return hasRuneMarkers ? '5.x (inferred)' : '4.x (inferred)';
  }

  /**
   * Svelte 4: Walk DOM looking for internal Svelte component maps.
   * Each component instance sets properties on its root DOM element.
   * Known patterns: $$component, __svelte_*, _svelte_XXX maps
   */
  function collectSvelte4Components() {
    const components = [];
    const seen = new WeakSet();

    function checkElement(el) {
      // Pattern 1: $$component (set by some Svelte configs)
      let inst = el.$$component || null;
      // Pattern 2: _svelte property map (Svelte 4 stores instance by component ID)
      if (!inst) {
        for (const key of Object.keys(el)) {
          if (key.startsWith('_svelte') || key.startsWith('__svelte')) {
            const v = el[key];
            if (v && typeof v === 'object' && ('$$' in v || 'ctx' in v || '$$.ctx' in v)) {
              inst = v;
              break;
            }
          }
        }
      }
      if (!inst || seen.has(inst)) return;
      seen.add(inst);

      const entry = {
        tag:   el.tagName.toLowerCase(),
        id:    el.id || null,
        name:  inst.constructor?.name || inst.$$.ctx?.constructor?.name || 'Unknown',
        props: null,
        state: null,
      };

      // Svelte 4 internal: inst.$$ = { ctx, props, bound, before_update, ... }
      const internal = inst.$$;
      if (internal) {
        try {
          // ctx holds the component's reactive variables
          const ctx = internal.ctx;
          if (Array.isArray(ctx)) {
            // ctx is an indexed array; prop_names maps indices to names
            const propDef = internal.props || {};
            const state = {};
            for (const [name, idx] of Object.entries(propDef)) {
              state[name] = safe(ctx[idx], 300);
            }
            if (Object.keys(state).length) entry.props = state;
          }
        } catch (_) {}
      }

      components.push(entry);
    }

    document.querySelectorAll('*').forEach(el => {
      try { checkElement(el); } catch (_) {}
    });

    return components;
  }

  /**
   * Svelte 5: Walk the effect/signal owner tree from window.__svelte_devtools
   * or from window._$owner (if dev mode).
   */
  function collectSvelte5Tree() {
    const root = window.__svelte_devtools?.root || window._$owner;
    if (!root) return null;

    function walk(node, depth) {
      if (!node || depth > 30) return null;
      const name = node.label || node.name || node.componentName || null;
      const out = { name: name || '(effect)', depth, children: [] };
      if ('v' in node) { try { out.value = safe(node.v, 200); } catch (_) {} }
      for (const child of (node.deps || node.children || node.effects || [])) {
        const c = walk(child, depth + 1);
        if (c) out.children.push(c);
      }
      return out;
    }

    try { return walk(root, 0); } catch { return null; }
  }

  /**
   * Scan window exports for Svelte writable/readable stores.
   * Svelte stores implement { subscribe(fn): fn, set?(v): void, update?(fn): void }
   */
  function collectStores() {
    const stores = {};
    const isSvelteStore = (v) =>
      v && typeof v === 'object' && typeof v.subscribe === 'function' &&
      !Array.isArray(v) && !(v instanceof Element);

    // Try window-level exports first
    const windowKeys = Object.keys(window).filter(k =>
      !k.startsWith('_') && !['document','navigator','history','location','performance'].includes(k)
    );
    for (const key of windowKeys.slice(0, 200)) {
      try {
        const val = window[key];
        if (!isSvelteStore(val)) continue;
        let currentValue = '[subscribe-only]';
        // Read current value by subscribing and immediately unsubscribing
        try {
          val.subscribe(v => { currentValue = v; })(); // subscriber returns unsubscribe fn
        } catch (_) {}
        stores[key] = { value: safe(currentValue, 300), writable: typeof val.set === 'function' };
      } catch (_) {}
    }
    return Object.keys(stores).length ? stores : null;
  }

  /** Collect all unique svelte-XXXXXX scoped class hashes */
  function collectScopedHashes() {
    const hashes = new Set();
    document.querySelectorAll('[class]').forEach(el => {
      for (const cls of el.classList) {
        if (/^svelte-[a-z0-9]{6,8}$/.test(cls)) hashes.add(cls);
      }
    });
    return [...hashes];
  }

  /** Collect data-svelte-h hydration hashes */
  function collectHydrationHashes() {
    return [...document.querySelectorAll('[data-svelte-h]')]
      .map(el => el.getAttribute('data-svelte-h')).slice(0, 100);
  }

  registry.register({
    id: 'svelte-meta', name: 'Svelte Analyzer', version: '2.0.0',
    runAt: 'load', realtime: false, priority: 10,
    emitType: 'SVELTE_SNAPSHOT', cacheTarget: 'svelte/',

    detect() {
      return !!(
        window.__svelte ||
        window.svelte ||
        document.querySelector('[data-svelte]') ||
        document.querySelector('[data-svelte-h]') ||
        document.querySelector('[class*="svelte-"]') ||
        (() => {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
          const n = w.nextNode();
          return n?.nodeValue === '[' || n?.nodeValue === ']';
        })()
      );
    },

    install(api) {
      // Register ourselves as a devtools consumer if Svelte 5 devtools exist
      if (window.__svelte_devtools) {
        try { window.__svelte_devtools.register?.('browser-whiskor'); } catch (_) {}
      }
    },

    collect(api) {
      const version = detectVersion();
      const isSvelte5 = typeof version === 'string' && version.startsWith('5');

      const scopedHashes    = collectScopedHashes();
      const hydrationHashes = collectHydrationHashes();
      const stores          = collectStores();

      let components = [];
      let ownerTree  = null;

      if (isSvelte5) {
        ownerTree = collectSvelte5Tree();
      } else {
        components = collectSvelte4Components();
      }

      // DevTools global registry (SvelteKit / devtools plugin)
      const devtoolsComponents = [];
      try {
        const devComp = window.__svelte?.components;
        if (Array.isArray(devComp)) {
          for (const c of devComp.slice(0, 100)) {
            devtoolsComponents.push({
              name: c.tagName || c.name || 'Unknown',
              source: c.options?.filename || null,
            });
          }
        }
      } catch (_) {}

      return {
        capturedAt: Date.now(),
        framework: 'svelte',
        version,
        scopedHashes,           // CSS scoping hashes → unique component fingerprints
        hydrationHashes,        // data-svelte-h SSR markers
        components,             // Svelte 4 instance data
        ownerTree,              // Svelte 5 dev mode signal/effect tree
        devtoolsComponents,     // from window.__svelte.components (if available)
        stores,
      };
    },
  });
})();
