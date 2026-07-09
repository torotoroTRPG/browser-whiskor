/**
 * adapters/react-state-managers.js  –  MAIN world
 *
 * State management library detection for React Fiber trees.
 * Depends on: window.__SI_REACT_SAFE_VAL__, window.Bippy
 */
'use strict';

function safeVal(v, depth, seen, maxDepth) {
  return window.__SI_REACT_SAFE_VAL__(v, depth, seen, maxDepth);
}
const B = window.Bippy;

// Serialize a Redux store's state. The serializer stubs OBJECTS nested past
// maxDepth with '[deep]' while primitives pass at any depth; Redux Toolkit
// entity adapters keep spatial state five levels down
// (entities.<slice>.entities.<id>.x), so start deep (maxDepth 5) and back off
// stage by stage when the capture explodes (2MB guard), keeping snapshots
// bounded on pathological stores.
function captureReduxState(store) {
  var snap = null;
  for (var md = 5; md >= 3; md--) {
    try {
      snap = safeVal(store.getState(), 0, null, md);
      if (JSON.stringify(snap).length <= 2000000) return snap;
    } catch (_) { /* stringify/getState failure → try shallower */ }
  }
  return snap;
}

function detectStateManagers(fiberRoot) {
  var result = {
    redux:      null,
    zustand:    [],
    jotai:      null,
    reactQuery: null,
    router:     null,
    mobx:       null,
    recoil:     null,
  };

  // Redux — DevTools extension hook (最優先, Provider props より確実)
  try {
    var devToolsHook = window.__REDUX_DEVTOOLS_EXTENSION__;
    if (devToolsHook && typeof devToolsHook.connect === 'function') {
      var dtStore = window.__REDUX_STORE__ || window.store || null;
      if (dtStore && typeof dtStore.getState === 'function') {
        try { result.redux = captureReduxState(dtStore); } catch (_) {}
      }
    }
    if (!result.redux) {
      for (var gk of ['__REDUX_STORE__', '__store__', 'reduxStore', '__APP_STORE__']) {
        var gs = window[gk];
        if (gs && typeof gs.getState === 'function' && typeof gs.dispatch === 'function') {
          try { result.redux = captureReduxState(gs); break; } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // React Query: window に QueryClient が露出している場合
  try {
    var rqc = window.__reactQueryClient || window.__tanstackQueryClient;
    if (rqc && typeof rqc.getQueryCache === 'function') {
      result.reactQuery = safeVal(
        rqc.getQueryCache().getAll().slice(0, 20).map(function(q) {
          return { key: q.queryKey, status: q.state.status, data: safeVal(q.state.data, 1) };
        })
      );
    }
  } catch (_) {}

  // ── MobX 検出 (5層フェイルオーバー) ─────────────────────────────────
  // Layer 1: DevTools global hook
  try {
    var mobxHook = window.__MOBX_DEVTOOLS_GLOBAL_HOOK__;
    if (mobxHook && mobxHook.mobxStores) {
      var stores = mobxHook.mobxStores;
      if (stores.size || stores.length || Object.keys(stores).length) {
        var mobxData = { stores: {}, detectedVia: 'devtools-hook' };
        if (stores instanceof Map) {
          stores.forEach(function(store, key) {
            try {
              var state = store.state || store.target || store;
              mobxData.stores[key] = safeVal(state, 2);
            } catch (_) { mobxData.stores[key] = '[unserializable]'; }
          });
        } else if (Array.isArray(stores)) {
          stores.forEach(function(store, i) {
            try {
              var state = store.state || store.target || store;
              mobxData.stores['store_' + i] = safeVal(state, 2);
            } catch (_) { mobxData.stores['store_' + i] = '[unserializable]'; }
          });
        } else {
          for (var mk of Object.keys(stores)) {
            try {
              var state = stores[mk].state || stores[mk].target || stores[mk];
              mobxData.stores[mk] = safeVal(state, 2);
            } catch (_) { mobxData.stores[mk] = '[unserializable]'; }
          }
        }
        result.mobx = Object.keys(mobxData.stores).length ? mobxData : null;
      }
    }
  } catch (_) {}

  // Layer 2: window.mobx global (toJS + isObservable)
  if (!result.mobx && window.mobx && typeof window.mobx.toJS === 'function') {
    try {
      var mobxData2 = { stores: {}, detectedVia: 'window.mobx' };
      var mobxCandidates = ['__mobxInstanceCount', '__mobxGlobals', '__mobxStores'];
      for (var mgk of Object.keys(window)) {
        if (mgk.indexOf('mobx') === -1 && mgk.indexOf('Mobx') === -1 && mgk.indexOf('MOBX') === -1) continue;
        var mVal = window[mgk];
        if (mVal && typeof mVal === 'object' && !Array.isArray(mVal) && !(mVal instanceof Element)) {
          try {
            var mState = window.mobx.toJS(mVal);
            if (mState && typeof mState === 'object') mobxData2.stores[mgk] = safeVal(mState, 2);
          } catch (_) {}
        }
      }
      if (Object.keys(mobxData2.stores).length) result.mobx = mobxData2;
    } catch (_) {}
  }

  // Layer 3: Recoil 検出 (4層フェイルオーバー) ────────────────────────
  // Layer 1: RecoilRoot Fiber → 内部 Store を duck-typing で特定
  try {
    var recoilStore = null;
    var recoilRootFiber = null;
    var recoilAtoms = [];

    B.traverseFiberSync(fiberRoot.current, function(fiber) {
      if (recoilRootFiber) return; // found
      if (!B.isCompositeFiber(fiber)) return;
      var name = B.getDisplayName(fiber.type) || '';
      if (name !== 'RecoilRoot') return;

      recoilRootFiber = fiber;

      // RecoilRoot内部のStoreオブジェクトを探索
      // dev mode: props.store / memoizedStateチェーン
      // prod mode: マングルされたプロパティ名を総当たり
      var candidates = [];

      // props.store (dev mode)
      if (fiber.memoizedProps && fiber.memoizedProps.store) {
        candidates.push(fiber.memoizedProps.store);
      }

      // memoizedStateチェーンからStoreを探す
      var hNode = fiber.memoizedState;
      var hCount = 0;
      while (hNode && hCount < 20) {
        var ms = hNode.memoizedState;
        if (ms) candidates.push(ms);
        // useRef.current patterns
        if (ms && typeof ms === 'object' && 'current' in ms && ms.current) {
          candidates.push(ms.current);
        }
        hNode = hNode.next;
        hCount++;
      }

      // Fiber instance properties (mangled names in prod)
      for (var fp of Object.keys(fiber)) {
        if (fp.startsWith('_') || fp === 'type' || fp === 'tag' || fp === 'key') continue;
        var fv = fiber[fp];
        if (fv && typeof fv === 'object') candidates.push(fv);
      }

      // Duck-typing for Recoil Store
      for (var cand of candidates) {
        if (!cand || typeof cand !== 'object') continue;
        var isStore = false;
        // Check for known Recoil Store methods (dev + prod patterns)
        var methods = ['getState', 'replaceState', 'getGraph', 'getTreeSnapshot',
                       'subscribeToTransactions', 'executeBatcher'];
        var mangledPatterns = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; // common mangled names

        var allPatterns = methods.concat(mangledPatterns);
        var matchCount = 0;
        for (var mp of allPatterns) {
          if (typeof cand[mp] === 'function') matchCount++;
        }
        // Also check for atomMap / stateTree / graph properties
        var hasAtomMap = false;
        for (var ak of Object.keys(cand)) {
          var av = cand[ak];
          if (av && typeof av === 'object') {
            // atomMap is usually a Map or object with atom keys
            if (av instanceof Map || (av.constructor && av.constructor.name === 'Map')) {
              hasAtomMap = true;
            }
            // stateTree has nodeId keys
            if (av.nodeId !== undefined || av.id !== undefined) {
              hasAtomMap = true;
            }
          }
        }

        if (matchCount >= 2 || hasAtomMap) {
          isStore = true;
          recoilStore = cand;
          break;
        }
      }
    });

    if (recoilStore) {
      var recoilData = { detectedVia: 'RecoilRoot-fiber', store: {}, atoms: [] };

      // Extract state via getState
      try {
        if (typeof recoilStore.getState === 'function') {
          var rawState = recoilStore.getState();
          if (rawState && typeof rawState === 'object') {
            recoilData.store = safeVal(rawState, 2);
          }
        }
      } catch (_) {}

      // Extract atomMap / nodeMap
      try {
        for (var sk of Object.keys(recoilStore)) {
          var sv = recoilStore[sk];
          if (sv instanceof Map) {
            var atomEntries = {};
            var count = 0;
            sv.forEach(function(val, key) {
              if (count >= 50) return;
              try {
                var keyStr = (typeof key === 'object' && key.key) ? key.key : String(key);
                atomEntries[keyStr] = {
                  type: val.nodeType || val.type || 'unknown',
                  key: keyStr,
                };
                if (val.default !== undefined) {
                  atomEntries[keyStr].default = safeVal(val.default, 1);
                }
              } catch (_) {}
              count++;
            });
            if (Object.keys(atomEntries).length) {
              recoilData.atoms.push(atomEntries);
            }
          }
        }
      } catch (_) {}

      // Tree snapshot (Recoil 0.5+)
      try {
        if (typeof recoilStore.getTreeSnapshot === 'function') {
          var tree = recoilStore.getTreeSnapshot();
          if (tree && tree.nodes) {
            recoilData.treeSnapshot = safeVal(tree.nodes, 2);
          }
        }
      } catch (_) {}

      result.recoil = Object.keys(recoilData.store).length || recoilData.atoms.length ? recoilData : { detectedVia: 'RecoilRoot-fiber', note: 'Store found but state extraction limited' };
    }
  } catch (_) {}

  // Recoil Layer 2: DevTools hook
  if (!result.recoil) {
    try {
      var recoilDT = window.__RECOIL_DEVTOOLS__ || window.__RECOIL_DEBUG__;
      if (recoilDT) {
        var recoilData2 = { detectedVia: 'devtools-hook' };
        if (recoilDT.getStoreState && typeof recoilDT.getStoreState === 'function') {
          try { recoilData2.store = safeVal(recoilDT.getStoreState(), 2); } catch (_) {}
        }
        if (recoilDT.atomValues) {
          try { recoilData2.atomValues = safeVal(recoilDT.atomValues, 2); } catch (_) {}
        }
        result.recoil = Object.keys(recoilData2).length > 1 ? recoilData2 : { detectedVia: 'devtools-hook', note: 'Hook present but state inaccessible' };
      }
    } catch (_) {}
  }

  // Recoil Layer 3: window.recoil global
  if (!result.recoil && window.recoil) {
    try {
      var wr = window.recoil;
      if (wr.getState || wr.atomValues || wr.store) {
        var recoilData3 = { detectedVia: 'window.recoil' };
        if (wr.getState && typeof wr.getState === 'function') {
          try { recoilData3.store = safeVal(wr.getState(), 2); } catch (_) {}
        }
        result.recoil = recoilData3;
      }
    } catch (_) {}
  }

  // ── Fiber走査 (Redux / Zustand / Jotai / Router / MobX Provider / Recoil hooks) ──
  try {
    B.traverseFiberSync(fiberRoot.current, function(fiber) {
      if (!B.isCompositeFiber(fiber)) return;
      var name  = B.getDisplayName(fiber.type) || '';
      var props = fiber.memoizedProps || {};

      // Redux Provider — duck-typed, not name-matched: on minified production
      // builds getDisplayName() returns the mangled name, so 'Provider' never
      // matches and the store went undetected. The getState+dispatch+subscribe
      // trio on a `store` prop is distinctive enough on its own.
      if (!result.redux && props.store &&
          typeof props.store.getState === 'function' &&
          typeof props.store.dispatch === 'function' &&
          typeof props.store.subscribe === 'function') {
        try { result.redux = captureReduxState(props.store); } catch (_) {}
      }

      // MobX Provider (mobx-react / mobx-react-lite)
      if (!result.mobx && (name === 'Provider' && props.value)) {
        try {
          var mobxVal = props.value;
          if (typeof mobxVal === 'object' && !Array.isArray(mobxVal)) {
            // Check if values look like observables
            var isMobX = false;
            for (var mvk of Object.keys(mobxVal)) {
              var mv = mobxVal[mvk];
              if (mv && typeof mv === 'object') {
                // MobX observable indicators
                if (mv.$mobx || mv.__mobxDidRunLazyInitializers ||
                    (mv.constructor && mv.constructor.name && mv.constructor.name.indexOf('Observable') !== -1)) {
                  isMobX = true;
                  break;
                }
              }
            }
            if (isMobX) {
              var mobxProvData = { stores: {}, detectedVia: 'Provider-props' };
              for (var mvk2 of Object.keys(mobxVal)) {
                try { mobxProvData.stores[mvk2] = safeVal(mobxVal[mvk2], 2); }
                catch (_) { mobxProvData.stores[mvk2] = '[unserializable]'; }
              }
              result.mobx = mobxProvData;
            }
          }
        } catch (_) {}
      }

      // Zustand (useSyncExternalStore / getSnapshot ベース)
      var h = fiber.memoizedState;
      var hc = 0;
      while (h && hc < 30) {
        var hq = h.queue;
        if (hq && typeof hq.getSnapshot === 'function' && typeof hq.subscribe === 'function') {
          try {
            var snap = hq.getSnapshot();
            if (snap && typeof snap === 'object') result.zustand.push(safeVal(snap, 2));
          } catch (_) {}
        }
        h = h.next;
        hc++;
      }

      // React Query QueryClientProvider
      if (!result.reactQuery && name === 'QueryClientProvider') {
        if (props.client && typeof props.client.getQueryCache === 'function') {
          try {
            result.reactQuery = safeVal(
              props.client.getQueryCache().getAll().slice(0, 20).map(function(q) {
                return { key: q.queryKey, status: q.state.status, data: safeVal(q.state.data, 1) };
              })
            );
          } catch (_) {}
        }
      }

      // React Router / TanStack Router
      if (!result.router && (
        name === 'Router' || name === 'BrowserRouter' || name === 'HashRouter' ||
        name === 'MemoryRouter' || name === 'RouterProvider' || name === 'StaticRouter'
      )) {
        try {
          result.router = {
            type:     name,
            basename: props.basename || null,
            location: safeVal((props.router && props.router.state && props.router.state.location) || props.location, 1),
            routes:   (props.router && props.router.routes) ? props.router.routes.length : null,
          };
        } catch (_) {}
      }

      // Jotai Provider
      if (!result.jotai && name === 'Provider' && !props.store) {
        try {
          var jh = fiber.memoizedState;
          while (jh) {
            var ms = jh.memoizedState;
            if (ms && typeof ms === 'object' && 'current' in ms) {
              var ref = ms.current;
              if (ref && typeof ref.get === 'function' && typeof ref.set === 'function') {
                result.jotai = '[Jotai store detected]';
                break;
              }
            }
            jh = jh.next;
          }
        } catch (_) {}
      }

      // Recoil hooks: useRecoilState / useRecoilValue / useSetRecoilState
      // These have a distinctive pattern: hook with a RecoilValue/Atom selector
      if (!result.recoil) {
        try {
          var rh = fiber.memoizedState;
          var rhc = 0;
          while (rh && rhc < 30) {
            var rms = rh.memoizedState;
            // Recoil hooks often have { key: '...', default: ... } objects
            if (rms && typeof rms === 'object') {
              var hasKey = 'key' in rms && typeof rms.key === 'string';
              var hasDefault = 'default' in rms;
              if (hasKey && (hasDefault || rms.type)) {
                // This looks like an Atom/Selector descriptor
                if (!result.recoil) {
                  result.recoil = {
                    detectedVia: 'fiber-hooks',
                    atoms: [],
                    note: 'Recoil hooks detected via Atom descriptors in hook chain'
                  };
                }
                var atomInfo = { key: rms.key, type: rms.type || 'atom' };
                if (hasDefault) atomInfo.default = safeVal(rms.default, 1);
                result.recoil.atoms.push(atomInfo);
              }
            }
            rh = rh.next;
            rhc++;
          }
        } catch (_) {}
      }
    });
  } catch (_) {}

  if (result.zustand.length === 0) result.zustand = null;
  return result;
}

window.__SI_REACT_STATE_MANAGERS__ = { detectStateManagers };
