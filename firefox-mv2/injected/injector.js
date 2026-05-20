/**
 * injected/injector.js  –  ISOLATED world, document_start
 *
 * MV2 では content_scripts の world 指定がない。
 * 同期 XHR でスクリプト内容を読み込み、inline <script> で MAIN world に注入する。
 * document_start + 同期実行なので React など本文スクリプトより確実に先に走る。
 */
(function () {
  'use strict';

  const _b = (typeof browser !== 'undefined') ? browser : chrome;

  // MAIN world に注入するスクリプトの順序（順序厳守）
  const SCRIPTS = [
    'injected/version-helper.js',
    'injected/plugin-system.js',
    'lib/bippy.iife.js',
    'injected/adapters/react.js',
    'injected/adapters/vue3.js',
    'injected/adapters/vue2.js',
    'injected/adapters/angular.js',
    'injected/adapters/svelte.js',
    'injected/adapters/preact.js',
    'injected/adapters/alpine.js',
    'injected/adapters/solid.js',
    'injected/adapters/dom-generic.js',
    'injected/analyzers/text-coords.js',
    'injected/analyzers/network.js',
    'injected/analyzers/css.js',
    'injected/analyzers/ui-catalog.js',
    'injected/analyzers/perf.js',
    'injected/analyzers/dom-mutations.js',
    'injected/explorer.js',
    'injected/collector.js',
  ];

  const root = document.head || document.documentElement;

  for (const src of SCRIPTS) {
    try {
      // 同期XHRで拡張機能ローカルファイルを読み込む
      // （chrome-extension:// / moz-extension:// は高速・同期可）
      console.log(`[SI injector] Attempting to load: ${src}`);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', _b.runtime.getURL(src), false /* synchronous */);
      xhr.send(null);
      console.log(`[SI injector] XHR status for ${src}: ${xhr.status}`);

      if (xhr.status === 200) {
        const s = document.createElement('script');
        s.textContent = xhr.responseText;
        s.dataset.si = src; // デバッグ用
        root.appendChild(s);
        s.remove();
        console.log(`[SI injector] Successfully injected: ${src}`);
      } else {
        console.error('[SI injector] failed to load:', src, xhr.status);
      }
    } catch (e) {
      console.error('[SI injector] critical error loading:', src, e.message);
    }
  }
})();
