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

  // ── 名前導出 (Unknown 根治) ────────────────────────────────────────────────
  // fiber.tag → 人間が読める「種別」ラベル。実コンポーネント名が無いノード
  // (Fragment / Provider / memo ラッパ 等) を "Unknown" でなく種別で示す。
  function reactKindLabel(tag) {
    switch (tag) {
      case 7:  return 'Fragment';
      case 8:  return 'Mode';
      case 9:  return 'Context.Consumer';
      case 10: return 'Context.Provider';
      case 11: return 'ForwardRef';
      case 12: return 'Profiler';
      case 13: return 'Suspense';
      case 14: return 'Memo';
      case 15: return 'Memo';
      case 16: return 'Lazy';
      case 18: return 'SuspenseList';
      case 22: return 'Offscreen';
      default: return null;
    }
  }

  // fiber.type から最善の名前。memo/forwardRef/context を剥がし、最後は関数/クラス
  // 名にフォールバック (displayName 欠落でも minified 名くらいは残る)。
  function typeName(type, depth) {
    depth = depth || 0;
    if (!type || depth > 4) return null;
    if (typeof type === 'string')   return type;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (typeof type.render === 'function') return type.render.displayName || type.render.name || null; // forwardRef
      if (type._context && type._context.displayName) return type._context.displayName;                  // context
      if (type.type)     return typeName(type.type, depth + 1);     // memo
      if (type._payload) return typeName(type._payload, depth + 1); // lazy
    }
    return null;
  }

  // { name, weak } を返す。weak=導出/種別フォールバック (実 displayName でない) →
  // パネルが控えめ表示にできる。
  function deriveReactName(fiber) {
    var dn = B.getDisplayName(fiber.type);
    if (dn && dn !== 'Unknown') return { name: dn, weak: false };
    if (B.isHostFiber(fiber) && typeof fiber.type === 'string') return { name: fiber.type, weak: false };
    var tn = typeName(fiber.type, 0);
    if (tn) return { name: tn, weak: false };
    var ds = fiber._debugSource || (fiber.type && fiber.type._debugSource);
    if (ds && ds.fileName) {
      var base = String(ds.fileName).split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]+$/, '');
      if (base) return { name: base, weak: true };
    }
    var kind = reactKindLabel(fiber.tag);
    if (kind) return { name: kind, weak: true };
    return { name: 'Anonymous', weak: true };
  }

  // Exposed for unit tests (and any tooling that wants name resolution).
  window.__SI_REACT_NAME__ = { reactKindLabel: reactKindLabel, typeName: typeName, deriveReactName: deriveReactName };
  window.__SI_REACT_SERIALIZE__ = function (fiber, maxNodes) {
    var cap = maxNodes == null ? 5000 : maxNodes;
    var budget = { nodes: cap, truncated: false };
    var tree = serializeFiber(fiber, 0, 80, 30, budget);
    return { tree: tree, nodes: cap - budget.nodes, truncated: budget.truncated };
  };

  // ── Fiber シリアライズ ────────────────────────────────────────────────────
  function serializeFiber(fiber, depth, maxDepth, maxProps, budget) {
    depth    = depth    == null ? 0  : depth;
    maxDepth = maxDepth == null ? 80 : maxDepth;
    maxProps = maxProps == null ? 30 : maxProps;
    // Node budget: a production app's fiber tree can serialize to tens of MB. Cap
    // the total node count so the snapshot stays bounded; mark it truncated when hit.
    budget   = budget || { nodes: 5000, truncated: false };

    if (!fiber || depth > maxDepth) return null;
    if (budget.nodes <= 0) { budget.truncated = true; return null; }

    var nm   = deriveReactName(fiber);
    var name = nm.name;
    var tag  = fiber.tag;

    // DOMルートノードをスキップ
    if (B.isHostFiber(fiber) && ['html','head','body','script'].includes(name)) return null;

    budget.nodes--; // committing to a node
    var node = { n: name, t: tag, d: depth };
    if (nm.weak) node.w = 1; // 導出/種別フォールバック名 (実 displayName でない)

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
      var c = serializeFiber(child, depth + 1, maxDepth, maxProps, budget);
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

    // ── Non-deterministic value filter (mirrors server/state-fingerprint.js) ──
    // 揮発値(タイムスタンプ/UUID/nonce 等)で状態ハッシュが無駄に変わるのを防ぐ。
    // observe/explorer が「幻の遷移」を検出しないようハッシュを安定させる。
    // Default mode 'key-aware': strips a value only when its KEY looks volatile
    // (timeAt/timestamp/nonce…) or the value is an unambiguous format (UUID /
    // ISO-8601) — so a legitimate numeric id (even a 13-digit one) survives.
    // 'aggressive' restores the old blind 13-digit / 32+ random heuristic.
    // 'off' disables filtering entirely (legacy behaviour).
    _ND_UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    _ND_ISO:  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
    _ND_TS13: /^\d{13}$/,
    _ND_RAND: /^[A-Za-z0-9_-]{32,}$/,
    _ND_DEFAULT_EXCLUDE: ['createdAt', 'updatedAt', 'timestamp', 'lastSeen', 'capturedAt', 'requestId', 'nonce', 'csrf', 'expiresAt', 'lastModified', '_id', 'firstSeen', 'visitCount'],

    _ndIsTemporalKey: function(k) {
      return /At$/.test(k) || /(?:time|date|stamp|epoch|expires|lastseen|firstseen|nonce|_ts$|^ts$)/i.test(k);
    },

    // Returns the normalized value, or undefined to signal "drop this key".
    _ndNormalize: function(key, v, nd) {
      if (nd.mode === 'off') return v;
      if (nd.exclude.has(key)) return undefined;
      const temporal = this._ndIsTemporalKey(key);
      if (typeof v === 'number') {
        if (this._ND_TS13.test(String(v)) && (nd.mode === 'aggressive' || temporal)) return '__TS__';
        return v;
      }
      if (typeof v === 'string') {
        if (this._ND_UUID.test(v)) return '__UUID__';
        if (this._ND_ISO.test(v)) return '__TS__';
        if (this._ND_TS13.test(v) && (nd.mode === 'aggressive' || temporal)) return '__TS__';
        if (nd.mode === 'aggressive' && this._ND_RAND.test(v)) return '__RAND__';
        return v;
      }
      return v;
    },

    // Build the filter context once per hash from the injected react config.
    // 設定は server/index.js が config.json の `react` を options.react に spread。
    _ndContext: function(api) {
      let opt = {};
      try {
        const cfg = api && api.getConfig && api.getConfig();
        opt = (cfg && cfg.options && cfg.options.react && cfg.options.react.hashFilter) || {};
      } catch (_) { /* fall through to defaults */ }
      const extra = Array.isArray(opt.excludeKeys) ? opt.excludeKeys : [];
      return {
        mode: opt.mode || 'key-aware',   // 'off' | 'key-aware' | 'aggressive'
        exclude: new Set(this._ND_DEFAULT_EXCLUDE.concat(extra)),
      };
    },

    _getStateHash: function(snapshot, nd) {
      nd = nd || { mode: 'key-aware', exclude: new Set(this._ND_DEFAULT_EXCLUDE) };
      // Robust hashing: combine tree structure with key props (volatile ones filtered)
      const slim = {
        tree: snapshot.componentTree ? this._getTreeShape(snapshot.componentTree, nd) : null,
        router: snapshot.router?.location?.pathname || '/',
        reduxKeys: snapshot.redux ? Object.keys(snapshot.redux).sort() : []
      };
      return this._hash(JSON.stringify(slim));
    },

    _getTreeShape: function(node, nd) {
      if (!node) return null;
      nd = nd || { mode: 'key-aware', exclude: new Set(this._ND_DEFAULT_EXCLUDE) };
      // Capture name and non-function props to differentiate states
      const props = {};
      if (node.p) {
        for (const k in node.p) {
          const v = node.p[k];
          if (typeof v === 'object' || typeof v === 'function') continue;
          const nv = this._ndNormalize(k, v, nd);
          if (nv === undefined) continue; // excluded volatile key
          props[k] = nv;
        }
      }
      return {
        n: node.n,
        p: props,
        c: node.c ? node.c.map(child => this._getTreeShape(child, nd)) : []
      };
    },

    detect: function() {
      // This flag drives summary.detectedFrameworks. It MUST mean "real React is
      // on this page", not "React tooling could exist", because agents use it to
      // decide whether get_framework_state / REACT_SNAPSHOT data will be there.
      //
      // Signals that are NOT evidence of React (removed — they caused false
      // positives on plain webpack / MediaWiki / challenge pages):
      //   - B.hasRDTHook(): bippy installs its OWN __REACT_DEVTOOLS_GLOBAL_HOOK__
      //     (so it can catch a React that loads later), so this is true on EVERY
      //     page once the adapter installs — it says nothing about React.
      //   - window.__webpack_require__: a webpack signal, not a React one.
      //
      // React only truly registers by injecting a renderer into the hook (which
      // is exactly what our data path, onCommitFiberRoot, depends on) or by
      // tagging host DOM nodes with __reactFiber$…/__reactContainer$… . Those
      // keep the flag aligned with whether a snapshot will actually be produced.
      try {
        var hook = B.getRDTHook && B.getRDTHook();
        if (hook && hook.renderers && hook.renderers.size > 0) return true;
      } catch (_) {}
      if (window.React && window.React.version) return true;
      try {
        var nodes = document.querySelectorAll('body *');
        var lim = Math.min(nodes.length, 300);
        for (var i = 0; i < lim; i++) {
          var keys = Object.keys(nodes[i]);
          for (var j = 0; j < keys.length; j++) {
            var k = keys[j];
            if (k.charCodeAt(0) === 95 && (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0)) return true;
          }
        }
      } catch (_) {}
      return false;
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

            const nd = self._ndContext(api);
            const currentHash = self._getStateHash(data, nd);
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
      var maxNodes = cfg.maxNodes || 5000;

      // NOTE: use `this` (not `self` — `self` only exists in install()'s closure)
      if (!this._lastRoot || !this._lastRoot.current) return null;

      var componentTree = null;
      var budget = { nodes: maxNodes, truncated: false };
      try {
        componentTree = serializeFiber(this._lastRoot.current, 0, maxDepth, maxProps, budget);
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
        treeNodes:   maxNodes - budget.nodes,   // how many fiber nodes were serialized
        treeTruncated: budget.truncated,        // true when the node cap was hit
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
