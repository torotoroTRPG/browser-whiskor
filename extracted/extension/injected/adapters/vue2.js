/**
 * adapters/vue2.js  –  MAIN world
 * Vue 2 コンポーネントツリー + Vuex + Vue Router v3 対応。
 *
 * 修正内容:
 *   - detect(): #app だけでなく __vue__ を持つ任意の要素を探す
 *   - _findRoot(): 複数の候補セレクタを試みる
 *   - _extractVuex(): getters の値も取得
 *   - _extractRouter(): $router / $route の現在値を取得
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

  const vue2Plugin = {
    id: 'vue2-devtool',
    name: 'Vue 2 Analyzer',
    version: '2.0.0',
    runAt: 'load',
    realtime: false,
    priority: 11,
    emitType: 'VUE2_SNAPSHOT',
    cacheTarget: 'vue2/',

    detect() {
      if (window.Vue?.version?.startsWith('2')) return true;
      // Check common mount points for __vue__ property
      const selectors = ['#app', '#root', '#vue', 'body > div', 'body > main'];
      for (const sel of selectors) {
        try { if (document.querySelector(sel)?.__vue__) return true; } catch (_) {}
      }
      return false;
    },

    install(api) {
      // Hook into Vue DevTools protocol to capture root instance on init
      const existing = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
      if (existing && !existing._SI_patched_v2) {
        existing._SI_patched_v2 = true;
        const origEmit = existing.emit?.bind(existing);
        existing.emit = function (event, ...args) {
          if (event === 'init') window.__SI_VUE2_INSTANCE__ = args[0];
          return origEmit?.(event, ...args);
        };
      }
    },

    collect(api) {
      const vm = this._findRoot();
      if (!vm) return null;

      return {
        capturedAt:    Date.now(),
        framework:     'vue2',
        version:       window.Vue?.version || null,
        componentTree: this._traverseVue2(vm, 0, 60),
        vuex:          this._extractVuex(vm),
        router:        this._extractRouter(vm),
      };
    },

    _findRoot() {
      // 1. DevTools hook captured instance
      if (window.__SI_VUE2_INSTANCE__) return window.__SI_VUE2_INSTANCE__;

      // 2. Scan common selectors for __vue__ property
      const candidates = ['#app', '#root', '#vue', 'body > div', 'body > main', 'div[id]'];
      for (const sel of candidates) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.__vue__) return el.__vue__;
          }
        } catch (_) {}
      }

      // 3. Scan all elements with id attribute
      for (const el of document.querySelectorAll('[id]')) {
        if (el.__vue__) return el.__vue__;
      }

      return null;
    },

    _traverseVue2(vm, depth, maxDepth) {
      if (!vm || depth > maxDepth) return null;

      const name = vm.$options?.name ||
                   vm.$options?._componentTag ||
                   vm.constructor?.options?.name ||
                   'Anonymous';

      const node = {
        name,
        depth,
        _fw: 'vue2',
        data:     safeClone(vm.$data,  500),
        props:    safeClone(vm.$props, 500),
        computed: this._extractComputed(vm),
        attrs:    safeClone(vm.$attrs, 300),
        children: [],
      };

      for (const child of (vm.$children || [])) {
        const c = this._traverseVue2(child, depth + 1, maxDepth);
        if (c) node.children.push(c);
      }
      return node;
    },

    _extractComputed(vm) {
      if (!vm._computedWatchers) return [];
      return Object.keys(vm._computedWatchers).map(key => {
        try { return { key, value: safeClone(vm[key], 200) }; }
        catch { return { key, value: '[error]' }; }
      });
    },

    _extractVuex(vm) {
      try {
        const store = vm.$store;
        if (!store) return null;

        const getters = {};
        for (const k of Object.keys(store.getters || {})) {
          try { getters[k] = safeClone(store.getters[k], 300); } catch { getters[k] = '[err]'; }
        }

        return {
          state:   safeClone(store.state,  2000),
          getters,
          modules: Object.keys(store._modules?.root?._children || {}),
          strict:  store.strict || false,
        };
      } catch { return null; }
    },

    _extractRouter(vm) {
      try {
        const router = vm.$router;
        const route  = vm.$route;
        if (!router && !route) return null;
        return {
          mode:     router?.mode || null,
          name:     route?.name     || null,
          path:     route?.path     || null,
          fullPath: route?.fullPath || null,
          params:   safeClone(route?.params, 300),
          query:    safeClone(route?.query,  300),
          meta:     safeClone(route?.meta,   300),
        };
      } catch { return null; }
    },
  };

  registry.register(vue2Plugin);
})();
