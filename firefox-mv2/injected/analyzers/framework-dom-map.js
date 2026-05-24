/**
 * analyzers/framework-dom-map.js
 * 
 * Subsystem 4 : FRAMEWORK <-> DOM MAPPER
 * 
 * ブラウザの生DOM要素から、背後にあるフレームワーク（React, Vue, Angular, Svelte等）の
 * コンポーネントインスタンス、Props、Stateを逆引きして抽出するモジュール。
 * 
 * Programmatic Click 戦略（イベントハンドラを直接叩く）や、
 * explain_element（なぜここが変化したか）の因果関係推論（Correlator）に使用される。
 */
'use strict';

(function() {
  const registry = window.__SI_REGISTRY__;
  // プラグインシステムがなくても単独で機能できるように設計（clickability等からの呼び出し用）

  // 根本的な考え方: フレームワークは本番ビルドで変数名を難読化しますが、
  // ReactのFiberツリーキー（__reactFiber$xxx）やVueの親コンポーネントキー（__vueParentComponent）
  // はDOM要素のプロパティとして必ず残ります（イベント委譲などのため）。
  // この特性を利用してDOMから仮想DOMツリーへ遡上（Reverse Engineering）します。

  // ── 安全なオブジェクトシリアライズ（循環参照回避） ─────────────────────────
  function shallowClone(obj, maxDepth = 2, currentDepth = 0) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (currentDepth >= maxDepth) return '[Object]';
    if (Array.isArray(obj)) {
      return obj.slice(0, 5).map(v => shallowClone(v, maxDepth, currentDepth + 1));
    }
    const cloned = {};
    let keys = 0;
    try {
      for (const k in obj) {
        if (keys++ > 10) break; // プロパティ爆発を防ぐ
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          // ReactやVueの内部プロパティ（循環する危険があるもの）は除外
          if (k.startsWith('_') || k === 'children' || k === 'vnode') continue;
          cloned[k] = shallowClone(obj[k], maxDepth, currentDepth + 1);
        }
      }
    } catch (_) {}
    return cloned;
  }

  // ── 抽出ロジック: React (Fiber) ──────────────────────────────────────────
  function extractReact(el) {
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternals$'));
    if (!fiberKey) return null;

    let fiber = el[fiberKey];
    let componentFiber = null;

    // ホストコンポーネント(DOMタグ)から、それをレンダリングした関数/クラスコンポーネントへ遡上
    let current = fiber;
    while (current) {
      if (typeof current.type === 'function' || typeof current.type === 'class') {
        componentFiber = current;
        break;
      }
      current = current.return;
    }

    if (!componentFiber) return null; // Component not found in hierarchy

    let name = componentFiber.type.displayName || componentFiber.type.name || '(anonymous)';
    let props = shallowClone(componentFiber.memoizedProps) || null;
    let state = null;

    // Hooks Stateの抽出 (単純な linked list の最初の値だけ取得)
    if (componentFiber.memoizedState && typeof componentFiber.memoizedState === 'object') {
      try {
        state = shallowClone(componentFiber.memoizedState.memoizedState) || null;
      } catch (_) {}
    }

    let sourceFile = null;
    let sourceLine = null;
    if (componentFiber.type && componentFiber.type._debugSource) {
      sourceFile = componentFiber.type._debugSource.fileName;
      sourceLine = componentFiber.type._debugSource.lineNumber;
    }

    return {
      name,
      framework: 'react',
      props,
      state,
      sourceFile,
      sourceLine,
      confidence: 1.00,
      acquisitionLevel: 1,
      _fiberRef: componentFiber // Programmatic click 等で直接参照するために内部保持
    };
  }

  // ── 抽出ロジック: Vue 3 ─────────────────────────────────────────────────
  function extractVue(el) {
    const vueKey = Object.keys(el).find(k => k.startsWith('__vueParentComponent'));
    if (!vueKey) return null;

    const instance = el[vueKey];
    if (!instance) return null;

    let name = (instance.type && (instance.type.__name || instance.type.name)) || '(anonymous)';
    let props = shallowClone(instance.props) || null;
    
    // Composition API (setupState) か Options API (data)
    let state = shallowClone(instance.setupState) || shallowClone(instance.data) || null;

    return {
      name,
      framework: 'vue3',
      props,
      state,
      sourceFile: null,
      sourceLine: null,
      confidence: 0.97,
      acquisitionLevel: 2,
      _vueInstanceRef: instance
    };
  }

  // ── 抽出ロジック: Angular (Ivy) ─────────────────────────────────────────
  function extractAngular(el) {
    if (!window.ng || typeof window.ng.getComponent !== 'function') return null;

    try {
      let component = window.ng.getComponent(el) || window.ng.getOwningComponent(el);
      if (!component) return null;

      let name = component.constructor ? component.constructor.name : '(anonymous)';
      // Angularの場合、propsとstateは明確に分かれておらずコンポーネントインスタンス自体に生えている
      let state = shallowClone(component); 

      return {
        name,
        framework: 'angular',
        props: null,
        state,
        sourceFile: null,
        sourceLine: null,
        confidence: 0.98,
        acquisitionLevel: 3,
        _ngComponentRef: component
      };
    } catch (_) {
      return null;
    }
  }

  // ── 抽出ロジック: Svelte ────────────────────────────────────────────────
  function extractSvelte(el) {
    // Svelte 4+ (dev mode only)
    if (el.__svelte_meta && el.__svelte_meta.loc) {
      const loc = el.__svelte_meta.loc;
      return {
        name: loc.file ? loc.file.split(/[/\\]/).pop().replace('.svelte', '') : '(unknown)',
        framework: 'svelte',
        props: null, // Svelteの実行時props取得はDOMからは困難
        state: null,
        sourceFile: loc.file,
        sourceLine: loc.line,
        confidence: 0.95,
        acquisitionLevel: 4
      };
    }
    return null;
  }

  // ── メイン抽出関数 ──────────────────────────────────────────────────────
  function extractFrameworkInfo(el) {
    if (!el || el.nodeType !== 1) return null;

    // Fallback chain (Level 1 to 5)
    const info = extractReact(el) 
              || extractVue(el) 
              || extractAngular(el) 
              || extractSvelte(el);

    if (info) {
      return info;
    }

    // Level 5: Generic DOM position record (No framework detected)
    return {
      name: null,
      framework: null,
      props: null,
      state: null,
      sourceFile: null,
      sourceLine: null,
      confidence: 0.00,
      acquisitionLevel: 5
    };
  }

  // グローバル公開 (executor や clickability から呼び出せるように)
  window.__SI_FRAMEWORK_MAPPER__ = {
    extract: extractFrameworkInfo
  };

  // ── Plugin Registration ──────────────────────────────────────────────────
  if (registry) {
    registry.register({
      id:          'framework-dom-map',
      name:        'Framework DOM Mapper',
      version:     '1.0.0',
      runAt:       'load',
      realtime:    false,
      priority:    5,
      emitType:    'FRAMEWORK_DOM_MAP',
      dependencies: [],
      
      install(api) {},

      // On-demand trigger: ctxに targetSelector などが渡された場合に処理する
      collect(api, ctx) {
        if (!ctx || !ctx.targetSelector) return null;
        
        try {
          const el = document.querySelector(ctx.targetSelector);
          if (!el) return null;

          const info = extractFrameworkInfo(el);
          
          // Internal refs は削除して出力
          const cleanInfo = { ...info };
          delete cleanInfo._fiberRef;
          delete cleanInfo._vueInstanceRef;
          delete cleanInfo._ngComponentRef;

          return {
            domSelector: ctx.targetSelector,
            component: cleanInfo,
            acquisitionLevel: cleanInfo.acquisitionLevel
          };
        } catch (_) {
          return null;
        }
      }
    });
  }

})();
