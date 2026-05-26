/**
 * adapters/preact.js  –  MAIN world
 * Preact 8 / 10 / 11 対応。
 *
 * 課題: 本番ビルドでは内部プロパティ名がマングルされる。
 * 対策: 既知のプロパティ名候補を総当たりし、vnode 構造の特徴
 *       (type/props/key) で正規化してからツリーを構築する。
 *
 * Preact 10 の主要内部プロパティ (unminified → minified):
 *   __k → children (kid vnodes)
 *   __  → parent vnode (or DOM node for host fibers)
 *   __c → component instance
 *   __e → DOM element
 *   __P → parentElement
 *   __H → hooks state
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // Candidate child-list property names across Preact versions
  const CHILD_KEYS = ['__k', '_children', '__', '_component', '__v'];

  function safeStr(v, max) {
    try { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + '…' : s; }
    catch { return '[err]'; }
  }

  function safeProps(props, max) {
    if (!props || typeof props !== 'object') return null;
    const out = {};
    let n = 0;
    for (const k of Object.keys(props)) {
      if (k === 'children') continue;
      const v = props[k];
      if (typeof v === 'function') continue;
      try { out[k] = JSON.parse(JSON.stringify(v).slice(0, 200)); }
      catch { out[k] = '[err]'; }
      if (++n >= 20) break;
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Recursively walk a Preact vnode.
   * We probe multiple candidate property names for children.
   */
  function traverse(vnode, depth) {
    if (!vnode || depth > 50) return null;
    if (typeof vnode !== 'object') return null;

    // type: function → component, string → host element, null → fragment/text
    const t = vnode.type;
    let name;
    if (typeof t === 'function') {
      name = t.displayName || t.name || 'Anonymous';
    } else if (typeof t === 'string') {
      name = t;
    } else if (t == null) {
      name = 'Fragment';
    } else {
      return null; // not a vnode
    }

    // Skip internal Preact artifacts
    if (name === 'Fragment' && !vnode.props) return null;

    const node = {
      name,
      depth,
      _fw: 'preact',
      props: typeof t === 'function' ? safeProps(vnode.props) : null,
      children: [],
    };

    // Collect children via candidate keys
    let kids = null;
    for (const key of CHILD_KEYS) {
      const v = vnode[key];
      if (Array.isArray(v) && v.length) { kids = v; break; }
      // Sometimes it's a single child vnode, not an array
      if (v && typeof v === 'object' && 'type' in v) { kids = [v]; break; }
    }

    // Also check vnode.__c (component instance) for hooks / state
    const comp = vnode.__c || vnode._component;
    if (comp && typeof comp === 'object') {
      try {
        const st = comp.state;
        if (st && typeof st === 'object' && Object.keys(st).length) {
          node.state = JSON.parse(safeStr(st, 500));
        }
      } catch (_) {}
      // Hooks: comp.__H in Preact 10
      try {
        const hooks = comp.__H?._list || comp.__hooks?._list || [];
        if (hooks.length) {
          node.hooks = hooks.slice(0, 10).map(h => {
            if (Array.isArray(h._args)) return { type: 'effect/memo', deps: h._args.length };
            if ('_value' in h)           return { type: 'state', value: safeStr(h._value, 100) };
            return { type: 'unknown' };
          });
        }
      } catch (_) {}
    }

    if (kids) {
      for (const child of kids) {
        if (!child) continue;
        const c = traverse(child, depth + 1);
        if (c) node.children.push(c);
      }
    }

    return node;
  }

  /**
   * Find the root vnode from a DOM container.
   * Preact 10 attaches it as __k or _children on the container element.
   */
  function findRoots() {
    const rootContainers = [];

    // Check common selectors
    for (const sel of ['#app', '#root', '#preact', 'body']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      for (const key of ['__k', '_children', '__v']) {
        if (el[key] != null) {
          rootContainers.push(el[key]);
          break;
        }
      }
    }

    // Preact 8: window.preact rendered instances can be found via __preactattr_
    document.querySelectorAll('[data-preact]').forEach(el => {
      for (const key of ['__k', '_children', '__v']) {
        if (el[key] != null) rootContainers.push(el[key]);
      }
    });

    return rootContainers;
  }

  registry.register({
    id: 'preact-fiber', name: 'Preact Analyzer', version: '2.0.0',
    runAt: 'load', realtime: false, priority: 10,
    emitType: 'PREACT_SNAPSHOT', cacheTarget: 'preact/',

    detect() {
      return !!(
        window.preact ||
        window.__PREACT_DEVTOOLS__ ||
        document.body?.__k ||
        document.body?._children ||
        document.querySelector('#app')?.__k ||
        document.querySelector('#app')?._children
      );
    },

    install(api) {},

    collect(api) {
      const version = window.preact?.version || null;
      const roots = findRoots();

      // Each root may be a vnode or an array of vnodes
      const trees = [];
      for (const root of roots) {
        if (Array.isArray(root)) {
          for (const v of root) {
            const t = traverse(v, 0);
            if (t) trees.push(t);
          }
        } else {
          const t = traverse(root, 0);
          if (t) trees.push(t);
        }
      }

      if (!trees.length && !version) return null;

      return {
        capturedAt: Date.now(),
        framework: 'preact',
        version,
        componentTree: trees.length === 1 ? trees[0] : trees.length > 1 ? trees : null,
        detectionNote: roots.length === 0
          ? 'Root vnode not found — production build may mangle internal property names.'
          : null,
      };
    },
  });
})();
