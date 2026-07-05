/**
 * analyzers/dom-mutations.js
 * 
 * Extended Proposal A: DOM_MUTATION Event Type
 * 
 * 座標変化（TEXT_COORD_DELTA）では捕捉できない「非可視要素の挿入」「属性値のみの変更」
 * を正確にトラッキングするための MutationObserver ベースの監視エンジン。
 * Time-series Correlator で高精度な因果関係を構築するために使用される。
 */
'use strict';

(function() {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  // ── ユーティリティ: 高速で一意性の高いセレクタ計算 ─────────────────────────
  // 根本的な考え方: ここでのセレクタは「後からCorrelatorが要素を特定できること」が目的です。
  function computeSelector(el) {
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el || !el.tagName || el === document.body || el === document.documentElement) {
      return el && el.tagName ? el.tagName.toLowerCase() : 'unknown';
    }
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 4) {
      let segment = current.tagName.toLowerCase();
      const classes = [...(current.classList || [])].filter(
        c => !/^[a-z]{1,3}-[a-zA-Z0-9]{4,8}$/.test(c) && !/^\d/.test(c)
      );
      if (classes.length) {
        segment += '.' + CSS.escape(classes[0]);
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          segment += `:nth-child(${idx})`;
        }
      }
      parts.unshift(segment);
      current = parent;
      depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // Find a dialog ([role=dialog]/[role=alertdialog]/<dialog>) in a mutation's
  // added/removed nodes. Returns a selector-ish identifier or null.
  const DIALOG_SEL = 'dialog, [role="dialog"], [role="alertdialog"]';
  function _scanForDialog(nodes) {
    for (const n of nodes) {
      if (!n || n.nodeType !== 1) continue;
      try {
        const hit = (n.matches && n.matches(DIALOG_SEL)) ? n : (n.querySelector && n.querySelector(DIALOG_SEL));
        if (hit) return computeSelector(hit);
      } catch (_) {}
    }
    return null;
  }

  // ── Mutation Handler & Batching ───────────────────────────────────────────
  let _observer = null;
  let batchQueue = [];
  let batchTimeout = null;
  const BATCH_WINDOW_MS = 16; // Proposal A: 16ms window
  let _api = null;

  function flushBatch() {
    if (batchQueue.length === 0) return;
    
    const recordsToEmit = [];
    const attrMap = new Map();

    // Coalescing Rule (Proposal A)
    // 属性と文字データの変更は要素+プロパティ単位で最新のものに上書き統合。
    // childList（要素の挿入・削除）はトランジェントな状態を追うため統合せず全て送る。
    for (const record of batchQueue) {
      if (record.mutationType === 'attributes' || record.mutationType === 'characterData') {
        const key = `${record.targetSelector}_${record.mutationType}_${record.attributeName || ''}`;
        attrMap.set(key, record);
      } else if (record.mutationType === 'childList') {
        recordsToEmit.push(record);
      }
    }

    for (const record of attrMap.values()) {
      recordsToEmit.push(record);
    }

    if (recordsToEmit.length > 0 && _api) {
      _api.emit('DOM_MUTATION', {
        type: 'DOM_MUTATION',
        timestamp: Date.now(),
        batchDurationMs: BATCH_WINDOW_MS,
        records: recordsToEmit
      }, true); // realtime: true
    }

    batchQueue = [];
    batchTimeout = null;
  }

  function handleMutations(mutations) {
    for (const mut of mutations) {
      if (mut.target && mut.target.id === 'si-ui-container') continue;

      const record = {
        mutationType: mut.type,
        targetSelector: computeSelector(mut.target)
      };

      if (mut.type === 'childList') {
        record.addedCount = mut.addedNodes.length;
        record.removedCount = mut.removedNodes.length;
        if (record.addedCount === 0 && record.removedCount === 0) continue;
        // Modal boundary flags: a dialog appearing/disappearing is the page-level
        // premise change agents most need to know about (server change-feed reads
        // these — see docs/ideas/PREMISE_CHANGE_FEED.md). querySelector works on
        // removed (detached) subtrees, so both directions are detectable here.
        const dialogIn = _scanForDialog(mut.addedNodes);
        const dialogOut = _scanForDialog(mut.removedNodes);
        if (dialogIn)  { record.dialogAppeared = true;  record.dialogSelector = dialogIn; }
        if (dialogOut) { record.dialogRemoved  = true;  record.dialogSelector = record.dialogSelector || dialogOut; }
      } else if (mut.type === 'attributes') {
        record.attributeName = mut.attributeName;
        record.oldValue = mut.oldValue;
        record.newValue = mut.target.getAttribute(mut.attributeName);
      } else if (mut.type === 'characterData') {
        record.oldValue = mut.oldValue;
        record.newValue = mut.target.nodeValue;
      }

      batchQueue.push(record);
    }

    if (!batchTimeout && batchQueue.length > 0) {
      batchTimeout = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
  }

  // ── Plugin Registration ───────────────────────────────────────────────────
  registry.register({
    id:          'dom-mutations',
    name:        'DOM Mutation Observer (Proposal A)',
    version:     '3.0.0', // v2 -> v3 (Prop A)
    runAt:       'document_start',
    realtime:    true,
    priority:    4,
    emitType:    'DOM_MUTATION',
    cacheTarget: null,

    install(api) {
      if (_observer) return;
      _api = api;

      const observe = () => {
        if (!document.body) return;
        _observer = new MutationObserver(handleMutations);
        _observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
          attributeOldValue: true,
          // Proposal A: "high volume; opt-in only" -> false
          characterDataOldValue: false 
        });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
      } else {
        observe();
      }
    },

    collect(_api) { return null; },
  });

})();
