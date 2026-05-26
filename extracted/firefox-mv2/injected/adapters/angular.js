/**
 * adapters/angular.js  –  MAIN world
 * AngularJS (1.x) と Angular (2+) を完全に分離して対応。
 *
 * Angular 2+:
 *   - window.ng.getComponent / ng.getInjector / ng.getContext (Ivy API)
 *   - NgRx: store.select() / window.__NGRX_DEVTOOLS__ またはRedux DevTools
 *   - Angular Signals (v16+): ng.getComponent(el)?.[signal key]
 *   - Standalone components (v15+): bootstrapApplication パターン
 *
 * AngularJS 1.x:
 *   - window.angular.element(el).scope()
 *   - window.angular.element(el).controller()
 *   - $injector からサービス取得
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  function safe(v, max) {
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'string') return v.length > (max || 200) ? v.slice(0, max) + '…' : v;
    try {
      const s = JSON.stringify(v);
      return s.length > (max || 500) ? '[truncated:' + s.length + ']' : JSON.parse(s);
    } catch { return '[circular]'; }
  }

  function safeEntries(obj, limit) {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    let n = 0;
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_') || k.startsWith('ng') || k.startsWith('ɵ')) continue;
      if (typeof obj[k] === 'function') continue;
      try { out[k] = safe(obj[k], 300); }
      catch { out[k] = '[err]'; }
      if (++n >= (limit || 20)) break;
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Angular 2+ (Ivy)
  // ─────────────────────────────────────────────────────────────────────────

  const angularPlugin = {
    id: 'angular-ng',
    name: 'Angular Analyzer',
    version: '2.0.0',
    runAt: 'load',
    realtime: false,
    priority: 10,
    emitType: 'ANGULAR_SNAPSHOT',
    cacheTarget: 'angular/',

    detect() {
      // Angular 2+
      if (window.getAllAngularRootElements || window.ng?.getComponent) return true;
      // AngularJS 1.x
      if (window.angular?.module) return true;
      // ng-version attribute (Angular 2+)
      if (document.querySelector('[ng-version]')) return true;
      return false;
    },

    install(api) {},

    collect(api) {
      const ng = window.ng;
      const isAngularJS = !!(window.angular?.module && !ng?.getComponent);
      const isAngular2Plus = !!(ng?.getComponent || window.getAllAngularRootElements);

      if (isAngularJS) {
        return this._collectAngularJS();
      }
      if (isAngular2Plus) {
        return this._collectAngular2Plus(ng);
      }
      return null;
    },

    // ── AngularJS 1.x ──────────────────────────────────────────────────────
    _collectAngularJS() {
      const angular = window.angular;
      if (!angular) return null;

      const components = [];
      const traversed = new WeakSet();

      function traverseScope(scope, depth) {
        if (!scope || depth > 20 || traversed.has(scope)) return null;
        traversed.add(scope);

        const entry = {
          depth,
          controllerId: scope.$id,
          // Collect non-Angular, non-function properties from scope
          data: (() => {
            const out = {};
            for (const k of Object.keys(scope)) {
              if (k.startsWith('$') || typeof scope[k] === 'function') continue;
              try { out[k] = safe(scope[k], 300); } catch { out[k] = '[err]'; }
            }
            return Object.keys(out).length ? out : null;
          })(),
          children: [],
        };

        let child = scope.$$childHead;
        while (child) {
          const c = traverseScope(child, depth + 1);
          if (c) entry.children.push(c);
          child = child.$$nextSibling;
        }
        return entry;
      }

      // Walk all ng-app elements
      document.querySelectorAll('[ng-app], [data-ng-app]').forEach(appEl => {
        try {
          const scope = angular.element(appEl).scope();
          if (scope) {
            const tree = traverseScope(scope.$root || scope, 0);
            if (tree) components.push(tree);
          }
        } catch (_) {}
      });

      // Services via $injector
      const services = {};
      try {
        const rootEl = document.querySelector('[ng-app]') || document.querySelector('[data-ng-app]');
        if (rootEl) {
          const $injector = angular.element(rootEl).injector();
          if ($injector) {
            const serviceNames = ['$route', '$router', '$state', '$location', '$http', '$rootScope'];
            for (const name of serviceNames) {
              if ($injector.has(name)) {
                try {
                  const svc = $injector.get(name);
                  services[name] = safeEntries(svc, 10);
                } catch (_) {}
              }
            }
          }
        }
      } catch (_) {}

      return {
        capturedAt: Date.now(),
        framework: 'angularjs',
        version: angular.version?.full || '1.x',
        scopeTree: components.length === 1 ? components[0] : components,
        services,
      };
    },

    // ── Angular 2+ (Ivy) ───────────────────────────────────────────────────
    _collectAngular2Plus(ng) {
      const version = this._detectVersion();
      const roots = window.getAllAngularRootElements?.() || [];
      if (!roots.length) {
        const r = document.querySelector('app-root') || document.querySelector('[ng-version]');
        if (r) roots.push(r);
      }

      const trees = roots.slice(0, 3).map(root => this._traverseElement(ng, root, 0)).filter(Boolean);

      return {
        capturedAt: Date.now(),
        framework: 'angular',
        version,
        componentTree: trees.length === 1 ? trees[0] : trees,
        ngrx:         this._detectNgRx(ng, roots[0]),
        signals:      this._detectSignals(ng, roots[0]),
        router:       this._detectRouter(ng, roots[0]),
      };
    },

    _traverseElement(ng, el, depth) {
      if (!el || depth > 40) return null;

      let component = null;
      try { component = ng?.getComponent?.(el); } catch (_) {}

      // Skip pure host elements with no component
      if (!component && depth > 0 && !el.children?.length) return null;

      const name = component?.constructor?.name ||
                   el.getAttribute?.('ng-version') ? 'AppRoot' : el.tagName?.toLowerCase() || 'unknown';

      const node = {
        name,
        depth,
        _fw: 'angular',
        inputs: null,
        outputs: null,
        directives: [],
        injectedServices: [],
        children: [],
      };

      if (component) {
        // Inputs (public properties that don't start with _/ng)
        node.inputs = safeEntries(component, 20);

        // Directives on this element
        try {
          const dirs = ng?.getDirectives?.(el) || [];
          node.directives = dirs.map(d => d?.constructor?.name).filter(Boolean);
        } catch (_) {}

        // Context / injector tokens (Angular 14+ getContext)
        try {
          const ctx = ng?.getContext?.(el);
          if (ctx && ctx !== component) node.context = safeEntries(ctx, 10);
        } catch (_) {}
      }

      // Recurse into DOM children
      for (const child of (el.children || [])) {
        const c = this._traverseElement(ng, child, depth + 1);
        if (c) node.children.push(c);
      }

      return node;
    },

    _detectVersion() {
      try {
        return window.ng?.getVersion?.()?.full ||
               document.querySelector('[ng-version]')?.getAttribute('ng-version') ||
               null;
      } catch { return null; }
    },

    _detectNgRx(ng, rootEl) {
      // NgRx injects its store into the Angular DI tree.
      // It also hooks into Redux DevTools with a specific store name.
      const result = { detected: false, state: null };

      // Method 1: Redux DevTools (NgRx always uses this when devtools extension is present)
      try {
        const hook = window.__REDUX_DEVTOOLS_EXTENSION__?._stores ||
                     window.__NGRX_DEVTOOLS__?._stores;
        if (hook) {
          result.detected = true;
          // NgRx stores usually have 'NgRx' in their name
          for (const [name, store] of Object.entries(hook)) {
            if (String(name).toLowerCase().includes('ngrx') || String(name).includes('Store')) {
              try { result.state = safe(store.getState?.(), 2000); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // Method 2: Try to get NgRx Store from Angular injector
      if (!result.detected && rootEl && ng) {
        try {
          const injector = ng?.getInjector?.(rootEl);
          if (injector) {
            // NgRx Store class token — check by duck-typing injected values
            // (We can't import Store class directly, so we look for dispatch/select)
            const storeToken = [...(injector._records?.keys() || [])].find(token => {
              try {
                const val = injector.get(token, null);
                return val && typeof val.dispatch === 'function' && typeof val.select === 'function';
              } catch { return false; }
            });
            if (storeToken) {
              result.detected = true;
              const store = injector.get(storeToken);
              try {
                let stateSnapshot;
                store.select(s => s).subscribe(s => { stateSnapshot = s; }).unsubscribe?.();
                result.state = safe(stateSnapshot, 2000);
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      return result.detected ? result : null;
    },

    _detectSignals(ng, rootEl) {
      // Angular Signals (v16+): components expose signal getters
      if (!rootEl || !ng) return null;
      try {
        const comp = ng?.getComponent?.(rootEl);
        if (!comp) return null;
        const signals = {};
        for (const k of Object.keys(comp)) {
          if (k.startsWith('_') || k.startsWith('ng')) continue;
          const v = comp[k];
          // Angular signals are functions with .set/.update (WritableSignal) or just callable
          if (typeof v === 'function' && typeof v.set === 'function') {
            try { signals[k] = safe(v(), 300); } catch (_) {}
          }
        }
        return Object.keys(signals).length ? signals : null;
      } catch { return null; }
    },

    _detectRouter(ng, rootEl) {
      if (!rootEl || !ng) return null;
      try {
        const injector = ng?.getInjector?.(rootEl);
        if (!injector) return null;
        // Try to get Router by duck-typing (has navigate + url)
        const routerToken = [...(injector._records?.keys() || [])].find(token => {
          try {
            const val = injector.get(token, null);
            return val && typeof val.navigate === 'function' && typeof val.url === 'string';
          } catch { return false; }
        });
        if (!routerToken) return null;
        const router = injector.get(routerToken);
        return {
          url: router.url,
          isActive: typeof router.isActive === 'function',
        };
      } catch { return null; }
    },
  };

  registry.register(angularPlugin);
})();
