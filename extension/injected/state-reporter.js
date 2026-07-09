/**
 * injected/state-reporter.js  –  MAIN world
 *
 * 1. Always-on composite hash engine: keeps window.__SI_CURRENT_HASH__ fresh
 *    during normal browsing (not just explorer runs) and exposes it as
 *    window.__SI_HASH_ENGINE__ for other injected modules (explorer.js
 *    delegates here so node identity can never fork between the two).
 * 2. Passive transition emitter: when the settled composite hash changes,
 *    emits STATE_TRANSITION so the server records nodes/edges in the
 *    composite keyspace (docs/ideas/REVERSE_EDGE_NAVIGATION.md, S0).
 * 3. Handles REQUEST_STATE_HASH from server and responds with STATE_HASH_REPORT.
 *    Also supports watchMode for continuous hash reporting during replay.
 */
'use strict';

(function () {
  // ── Composite hash engine (always on) ──────────────────────────────────────
  // fnv32 mirrors server/state-fingerprint.js. The client-computed composite
  // IS the node identity the server stores verbatim (state-store addNode) —
  // any drift between producers splits one state into duplicate nodes.

  function fnv32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36).padStart(7, '0');
  }

  function computeDomHash() {
    var pathname = location.pathname;
    var search = location.search;
    var interactive = document.querySelectorAll('a, button, input, select, textarea, [role=button], [role=link]');
    var domSig = [];
    for (var i = 0; i < Math.min(interactive.length, 50); i++) {
      var el = interactive[i];
      domSig.push(el.tagName.toLowerCase() + ':' + (el.textContent || '').trim().slice(0, 20));
    }
    return fnv32((pathname + search) + '|||' + domSig.join('|'));
  }

  function compute() {
    var domHash = computeDomHash();
    var reactHash = window.__SI_REACT_HASH__ || null;
    var compositeHash = reactHash ? fnv32(reactHash + '|' + domHash) : domHash;
    var info = { compositeHash: compositeHash, reactHash: reactHash, domHash: domHash };
    window.__SI_CURRENT_HASH__ = info;
    return info;
  }

  window.__SI_HASH_ENGINE__ = { compute: compute, domHash: computeDomHash };

  // ── Passive transition emitter ─────────────────────────────────────────────
  // Poll + settle: a SPA transition ripples (react commit, then DOM catches
  // up), so a changed hash is held as a candidate until it stays put for
  // SETTLE_MS — one STATE_TRANSITION per settled state, not one per render
  // tick. The very first settled hash after load is emitted with from:null
  // (node only, no edge). The causing interaction is snapshotted when the
  // change is FIRST seen — by emit time the settle delay would have aged it
  // out of the attribution window.

  var POLL_MS = 700;
  var SETTLE_MS = 800;
  var INTERACTION_WINDOW_MS = 3000;

  var lastStable = null;
  var candidate = null;
  var candidateSince = 0;
  var candidateInteraction = null;

  function recentInteraction() {
    var reg = window.__SI_REGISTRY__;
    var inter = reg && reg._lastInteraction;
    if (!inter || (Date.now() - inter.ts) > INTERACTION_WINDOW_MS) return null;
    return { type: inter.type, text: inter.text || null, id: inter.id || null, ts: inter.ts };
  }

  function emitTransition(from, to, interaction) {
    window.postMessage({
      __BROWSER_WHISKOR__: true,
      type: 'STATE_TRANSITION',
      siteVersion: window.__SI_VERSION__ && window.__SI_VERSION__.id,
      payload: {
        from: from ? from.compositeHash : null,
        to: to.compositeHash,
        reactHash: to.reactHash,
        domHash: to.domHash,
        url: location.href,
        title: (document.title || '').slice(0, 300) || null,
        interaction: interaction || null,
        capturedAt: Date.now(),
      },
    }, '*');
  }

  function tick() {
    if (document.hidden) return;
    var info = compute();
    if (lastStable && info.compositeHash === lastStable.compositeHash) {
      candidate = null;
      candidateInteraction = null;
      return;
    }
    if (!candidate || candidate.compositeHash !== info.compositeHash) {
      candidate = info;
      candidateSince = Date.now();
      candidateInteraction = recentInteraction();
      return;
    }
    if (Date.now() - candidateSince >= SETTLE_MS) {
      emitTransition(lastStable, info, candidateInteraction);
      lastStable = info;
      candidate = null;
      candidateInteraction = null;
    }
  }

  setInterval(tick, POLL_MS);
  window.addEventListener('popstate', function () { setTimeout(tick, 50); });
  window.addEventListener('hashchange', function () { setTimeout(tick, 50); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  // ── REQUEST_STATE_HASH / watch mode ────────────────────────────────────────

  var watchMode = false;
  var watchTimer = null;
  var lastReportedHash = null;

  function sendHashReport(requestId) {
    var hashInfo = compute();
    if (!hashInfo.compositeHash) return;

    window.postMessage({
      __BROWSER_WHISKOR__: true,
      type: 'STATE_HASH_REPORT',
      requestId: requestId,
      payload: {
        compositeHash: hashInfo.compositeHash,
        reactHash: hashInfo.reactHash,
        domHash: hashInfo.domHash,
        source: hashInfo.reactHash ? 'react' : 'dom',
        capturedAt: Date.now()
      }
    }, '*');
  }

  function startWatchMode() {
    if (watchMode) return;
    watchMode = true;
    lastReportedHash = null;

    watchTimer = setInterval(function () {
      var hashInfo = compute();
      if (!hashInfo.compositeHash) return;
      if (hashInfo.compositeHash === lastReportedHash) return;

      lastReportedHash = hashInfo.compositeHash;
      window.postMessage({
        __BROWSER_WHISKOR__: true,
        type: 'STATE_HASH_REPORT',
        requestId: 'watch',
        payload: {
          compositeHash: hashInfo.compositeHash,
          reactHash: hashInfo.reactHash,
          domHash: hashInfo.domHash,
          source: hashInfo.reactHash ? 'react' : 'dom',
          capturedAt: Date.now()
        }
      }, '*');
    }, 200);
  }

  function stopWatchMode() {
    watchMode = false;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data?.__BROWSER_WHISKOR__) return;

    if (event.data.type === 'REQUEST_STATE_HASH') {
      if (event.data.watchMode) {
        startWatchMode();
      } else {
        sendHashReport(event.data.requestId);
      }
    }

    if (event.data.type === 'CANCEL_WATCH') {
      stopWatchMode();
    }
  });

  // Stop watch mode on page unload
  window.addEventListener('beforeunload', stopWatchMode);
})();
