/**
 * adapters/vue3.js  –  MAIN world
 * Vue 3 + Pinia + Vue Router v4 対応。
 *
 * 修正内容:
 *   - _traverseVue3: subTree.component 以外の兄弟 vnode も再帰する
 *   - _extractPinia: Symbol.toString() 依存を廃止 → App._context.provides を直接検索
 *   - _findApp: window全スキャンを廃止 (遅い/危険) → 確実なセレクタ群のみ
 *   - _detectRouter: Vue Router v4 の router インスタンスを Provide から取得
 *   - Vuex v4 (Vue 3 向け) の検出を追加
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function safeClone(obj, max) {
    if (obj == null) return obj;
    if (typeof obj === 'function') return '[fn]';
    if (typeof obj !== 'object') return obj;
    try {
      const s = JSON.stringify(obj);
      if (!max || s.length <= max) return JSON.parse(s);
      return '[truncated:' + s.length + ']';
    } catch { return '[circular]'; }
  }

  const vue3Plugin = {
    id: 'vue3-devtool',
    name: 'Vue 3 Analyzer',
    version: '2.0.0',
    runAt: 'load',
    realtime: false,
    priority: 10,
    emitType: 'VUE3_SNAPSHOT',
    cacheTarget: 'vue/',

    _app: null,

    detect() {
      return !!(
        window.__VUE__ ||
        document.querySelector('[data-v-app]')?.__vue_app__ ||
        document.querySelector('#app')?.__vue_app__ ||
        document.querySelector('#root')?.__vue_app__
      );
    },

    install(api) {
      const self = this;
      const hook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && !hook._SI_patched_v3) {
        hook._SI_patched_v3 = true;
        const orig = hook.emit?.bind(hook);
        hook.emit = function (event, ...args) {
          if (event === 'app:init') self._app = args[0];
          return orig?.(event, ...args);
        };
      }
    },

    collect(api) {
      const app = this._findApp();
      if (!app) return null;

      let componentTree = null;
      try { componentTree = this._traverseVue3(app._instance, 0, 40); } catch (_) {}

      return {
        capturedAt:       Date.now(),
        framework:        'vue3',
        version:          app.version || null,
        componentTree,
        globalProperties: Object.keys(app.config?.globalProperties || {}),
        providedKeys:     this._listProvides(app),
        pinia:            this._extractPinia(app),
        vuex:             this._extractVuex(app),
        router:           this._extractRouter(app),
      };
    },

    _findApp() {
      if (this._app) return this._app;
      // Deterministic selector list — no window key scan
      const selectors = [
        '[data-v-app]', '#app', '#root', '#vue-app',
        'body > div', 'body > main', 'body > #__nuxt',
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el?.__vue_app__) return (this._app = el.__vue_app__);
        } catch (_) {}
      }
      return null;
    },

    /**
     * Traverse Vue 3 component instance tree.
     * Unlike the old version, we walk ALL vnode children (not just subTree.component),
     * and handle Fragment / KeepAlive / Teleport correctly.
     */
    _traverseVue3(instance, depth, maxDepth) {
      if (!instance || depth > maxDepth) return null;

      const name = instance.type?.name ||
                   instance.type?.__name ||
                   instance.type?.displayName ||
                   (typeof instance.type === 'string' ? instance.type : 'Anonymous');

      const node = {
        name, depth,
        props:      safeClone(instance.props, 500),
        setupState: this._extractSetupState(instance),
        data:       safeClone(instance.data, 500),
        _fw:        'vue3',
        children:   [],
      };

      // Expose emits list
      if (instance.type?.emits) {
        node.emits = Array.isArray(instance.type.emits)
          ? instance.type.emits
          : Object.keys(instance.type.emits);
      }

      // Walk vnode subtree collecting child component instances
      this._collectChildInstances(instance.subTree, depth, maxDepth, node.children);

      return node;
    },

    /**
     * Recursively walk a vnode (not an instance!) collecting child instances.
     * This correctly handles Fragment arrays, KeepAlive, Teleport, etc.
     */
    _collectChildInstances(vnode, parentDepth, maxDepth, out) {
      if (!vnode || parentDepth >= maxDepth) return;

      // This vnode IS a component — recurse into its instance
      if (vnode.component) {
        const c = this._traverseVue3(vnode.component, parentDepth + 1, maxDepth);
        if (c) out.push(c);
        return; // component's own subTree is handled in its own _traverseVue3 call
      }

      // Fragment / slot vnodes have children array
      const children = vnode.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && typeof child === 'object') {
            this._collectChildInstances(child, parentDepth, maxDepth, out);
          }
        }
      }

      // dynamicChildren (compiled optimized vnodes)
      if (vnode.dynamicChildren) {
        for (const child of vnode.dynamicChildren) {
          if (child?.component) {
            const c = this._traverseVue3(child.component, parentDepth + 1, maxDepth);
            if (c) out.push(c);
          }
        }
      }
    },

    /**
     * Extract setup() return values (reactive state) from component instance.
     * Handles both Options API and Composition API.
     */
    _extractSetupState(instance) {
      try {
        const ss = instance.setupState;
        if (!ss || typeof ss !== 'object') return null;
        const out = {};
        for (const k of Object.keys(ss)) {
          if (k.startsWith('__')) continue;
          const v = ss[k];
          if (typeof v === 'function') continue;
          // Vue 3 refs: { value: ... }
          out[k] = safeClone(v?.__v_isRef ? v.value : v, 300);
        }
        return Object.keys(out).length ? out : null;
      } catch { return null; }
    },

    /** List all injected provide keys (plugin tokens, router, pinia, etc.) */
    _listProvides(app) {
      try {
        const provides = app._context?.provides || {};
        return [
          ...Object.keys(provides).slice(0, 30),
          ...Object.getOwnPropertySymbols(provides).map(s => s.toString()).slice(0, 20),
        ];
      } catch { return []; }
    },

    /**
     * Extract Pinia store state.
     * Pinia registers itself with Symbol('pinia') — we find it by checking
     * each Symbol provide for duck-type { _s: Map, state: { value: {} } }
     */
    _extractPinia(app) {
      try {
        const provides = app._context?.provides || {};
        let pinia = null;

        // Check Symbol-keyed provides
        for (const sym of Object.getOwnPropertySymbols(provides)) {
          const val = provides[sym];
          if (val && val._s instanceof Map && val.state?.value != null) {
            pinia = val;
            break;
          }
        }
        // Also check string-keyed provides (some setups)
        if (!pinia) {
          for (const key of Object.keys(provides)) {
            const val = provides[key];
            if (val && val._s instanceof Map && val.state?.value != null) {
              pinia = val;
              break;
            }
          }
        }
        if (!pinia) {
          // Last resort: window.pinia or window.__pinia
          pinia = window.pinia || window.__pinia;
          if (!(pinia?._s instanceof Map)) pinia = null;
        }
        if (!pinia) return null;

        const storeIds = [...pinia._s.keys()];
        const state = {};
        for (const [id] of pinia._s) {
          try { state[id] = safeClone(pinia.state.value?.[id], 1000); }
          catch { state[id] = '[unserializable]'; }
        }
        return { stores: storeIds, state };
      } catch { return null; }
    },

    /** Extract Vuex v4 state (also used with Vue 3) */
    _extractVuex(app) {
      try {
        const provides = app._context?.provides || {};
        // Vuex 4 uses Symbol('vuex key') or string 'store'
        let store = provides['store'] || window.__VUEX_STORE__ || null;
        if (!store) {
          for (const sym of Object.getOwnPropertySymbols(provides)) {
            const val = provides[sym];
            if (val && typeof val.getState === 'function' && typeof val.dispatch === 'function') {
              store = val;
              break;
            }
          }
        }
        if (!store) return null;
        return {
          state:   safeClone(store.state, 2000),
          getters: Object.keys(store.getters || {}),
          modules: Object.keys(store._modules?.root?._children || {}),
        };
      } catch { return null; }
    },

    /** Extract Vue Router v4 current route */
    _extractRouter(app) {
      try {
        const provides = app._context?.provides || {};
        let router = null;

        // Vue Router 4 registers as Symbol('router')
        for (const sym of Object.getOwnPropertySymbols(provides)) {
          const val = provides[sym];
          if (val && typeof val.push === 'function' && val.currentRoute != null) {
            router = val;
            break;
          }
        }
        if (!router) {
          for (const key of Object.keys(provides)) {
            const val = provides[key];
            if (val && typeof val.push === 'function' && val.currentRoute != null) {
              router = val;
              break;
            }
          }
        }
        if (!router) return null;

        const route = router.currentRoute?.value || router.currentRoute;
        return {
          name:     route?.name   || null,
          path:     route?.path   || null,
          fullPath: route?.fullPath || null,
          params:   safeClone(route?.params,  300),
          query:    safeClone(route?.query,   300),
          meta:     safeClone(route?.meta,    300),
        };
      } catch { return null; }
    },
  };

  registry.register(vue3Plugin);
})();
