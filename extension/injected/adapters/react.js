/**
 * adapters/react.js  –  MAIN world
 *
 * Bippy (window.Bippy) ベースの React Fiber アナライザー。
 * bippy.iife.js が先に読み込まれている前提。
 *
 * 取得データ:
 *   - コンポーネントツリー (名前・props・hooks・深度)
 *   - useState / useReducer / useRef / useEffect / useMemo / useCallback / useContext
 *   - Redux / Zustand / Jotai / MobX / Recoil / React Query 状態
 *   - React Router / TanStack Router ルート情報
 *   - レンダリング統計 (selfTime / totalTime)
 *   - React バージョン・ビルド種別 (dev/prod)
 */
'use strict';

(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  if (typeof window.Bippy === 'undefined') {
    console.warn('[SI] bippy not loaded — React adapter disabled');
    return;
  }

  const B = window.Bippy;

  const { classifyHook, getHooks } = window.__SI_REACT_HOOKS__;
  const { detectStateManagers } = window.__SI_REACT_STATE_MANAGERS__;

  // ── Safe serializer ──────────────────────────────────────────────────────
  function safeVal(v, depth, seen) {
    depth = depth == null ? 0 : depth;
    seen  = seen  || new WeakSet();
    if (v === null || v === undefined) return v;
    if (typeof v === 'function')  return '[fn]';
    if (typeof v === 'symbol')    return String(v);
    if (typeof v !== 'object')    return v;
    if (depth > 3)                return '[deep]';
    if (seen.has(v))              return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      return v.slice(0, 20).map(function(i) { return safeVal(i, depth + 1, seen); });
    }
    var keys = Object.keys(v).slice(0, 30);
    var out  = {};
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      try { out[k] = safeVal(v[k], depth + 1, seen); }
      catch (_) { out[k] = '[err]'; }
    }
    return out;
  }

  window.__SI_REACT_SAFE_VAL__ = safeVal;

  // ── Fiber シリアライズ ────────────────────────────────────────────────────
  function serializeFiber(fiber, depth, maxDepth, maxProps) {
    depth    = depth    == null ? 0  : depth;
    maxDepth = maxDepth == null ? 80 : maxDepth;
    maxProps = maxProps == null ? 30 : maxProps;

    if (!fiber || depth > maxDepth) return null;

    var name = B.getDisplayName(fiber.type) ||
               (B.isHostFiber(fiber) ? fiber.type : null) ||
               'Unknown';
    var tag  = fiber.tag;

    // DOMルートノードをスキップ
    if (B.isHostFiber(fiber) && ['html','head','body','script'].includes(name)) return null;

    var node = { n: name, t: tag, d: depth };

    // タイミング (Profiler)
    var timings = B.getTimings(fiber);
    if (timings.totalTime > 0) {
      node.ms = {
        self:  parseFloat(timings.selfTime.toFixed(2)),
        total: parseFloat(timings.totalTime.toFixed(2)),
      };
    }

    // Props (コンポーネントのみ)
    if (B.isCompositeFiber(fiber) && fiber.memoizedProps) {
      var props = {};
      var count = 0;
      var pkeys = Object.keys(fiber.memoizedProps);
      for (var pi = 0; pi < pkeys.length && count < maxProps; pi++) {
        var pk = pkeys[pi];
        if (pk === 'children') continue;
        try {
          var pv = fiber.memoizedProps[pk];
          if (typeof pv !== 'function') { props[pk] = safeVal(pv); count++; }
        } catch (_) {}
      }
      if (count > 0) node.p = props;
    }

    // Hooks (FunctionComponent=0, SimpleMemo=15)
    if (tag === 0 || tag === 15) {
      var hooks = getHooks(fiber);
      if (hooks.length > 0) node.h = hooks;
    }

    // ContextProvider の value
    if (tag === 10) {
      try { node.ctx = safeVal(fiber.memoizedProps && fiber.memoizedProps.value, 1); } catch (_) {}
    }

    // 子ノード
    var children = [];
    var child = fiber.child;
    while (child) {
      var c = serializeFiber(child, depth + 1, maxDepth, maxProps);
      if (c) children.push(c);
      child = child.sibling;
    }
    if (children.length) node.c = children;

    return node;
  }

  // ── Plugin 登録 ─────────────────────────────────────────────────────────
  var reactPlugin = {
    id:          'react-fiber',
    name:        'React Fiber Analyzer (bippy)',
    version:     '2.0.0',
    runAt:       'document_start',
    realtime:    false,
    priority:    1,
    requires:    [],
    emitType:    'REACT_SNAPSHOT',
    cacheTarget: 'react/',

    _debounceTimer: null,
    _reactVersion:  null,
    _buildType:     null,
    _lastStateHash: null,
    _lastRoot:      null,

    _hash: function(str) {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
      }
      return h.toString(36);
    },

    _getStateHash: function(snapshot) {
      // Robust hashing: combine tree structure with key props (excluding volatile ones)
      const slim = {
        tree: snapshot.componentTree ? this._getTreeShape(snapshot.componentTree) : null,
        router: snapshot.router?.location?.pathname || '/',
        reduxKeys: snapshot.redux ? Object.keys(snapshot.redux).sort() : []
      };
      return this._hash(JSON.stringify(slim));
    },

    _getTreeShape: function(node) {
      if (!node) return null;
      // Capture name and non-function props to differentiate states
      const props = {};
      if (node.p) {
        for (const k in node.p) {
          const v = node.p[k];
          if (typeof v !== 'object' && typeof v !== 'function') {
            props[k] = v;
          }
        }
      }
      return {
        n: node.n,
        p: props,
        c: node.c ? node.c.map(child => this._getTreeShape(child)) : []
      };
    },

    detect: function() {
      return B.hasRDTHook() || !!window.React || !!window.__webpack_require__;
    },

    install: function(api) {
      var self = this;

      B.instrument({
        name: 'browser-whiskor',

        onActive: function() {
          try {
            var hook = B.getRDTHook();
            if (hook && hook.renderers) {
              for (var renderer of hook.renderers.values()) {
                self._reactVersion = renderer.version || null;
                self._buildType    = B.detectReactBuildType(renderer);
                break;
              }
            }
          } catch (_) {}
        },

        onCommitFiberRoot: function(_rid, _root, _priority) {
          self._lastRoot = _root;
          clearTimeout(self._debounceTimer);
          self._debounceTimer = setTimeout(function() {
            if (!registry._isEnabled('react-fiber')) return;
            var data = self.collect(api);
            if (!data) return;

            const currentHash = self._getStateHash(data);
            // Write to global for explorer.js compositeHash calculation
            window.__SI_REACT_HASH__ = currentHash;

            if (self._lastStateHash && self._lastStateHash !== currentHash) {
              api.emit('REACT_TRANSITION', {
                from: self._lastStateHash,
                to: currentHash,
                fromReact: self._lastStateHash,
                toReact: currentHash,
                trigger: api.getLastInteraction(),
                capturedAt: Date.now()
              }, true);
            }

            self._lastStateHash = currentHash;
            data.currentHash = currentHash;
            api.emit(self.emitType, data, false);
          }, 200);
        },
      });
    },

    collect: function(api) {
      var cfg      = (api.getConfig().options && api.getConfig().options.react) || {};
      var maxDepth = cfg.maxDepth || 80;
      var maxProps = cfg.maxProps || 30;

      // NOTE: use `this` (not `self` — `self` only exists in install()'s closure)
      if (!this._lastRoot || !this._lastRoot.current) return null;

      var componentTree = null;
      try {
        componentTree = serializeFiber(this._lastRoot.current, 0, maxDepth, maxProps);
      } catch (err) {
        api.log('warn', 'react-fiber: serialize failed: ' + err.message);
      }

      var sm = {};
      try { sm = detectStateManagers(this._lastRoot); } catch (_) {}

      return {
        capturedAt:  Date.now(),
        version:     this._reactVersion,
        buildType:   this._buildType,
        componentTree: componentTree,
        redux:       sm.redux      || null,
        zustand:     sm.zustand    || null,
        reactQuery:  sm.reactQuery || null,
        router:      sm.router     || null,
        jotai:       sm.jotai      || null,
        mobx:        sm.mobx       || null,
        recoil:      sm.recoil     || null,
      };
    },
  };

  registry.register(reactPlugin);
})();
