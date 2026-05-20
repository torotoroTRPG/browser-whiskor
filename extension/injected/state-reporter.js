/**
 * injected/state-reporter.js  –  MAIN world
 *
 * Handles REQUEST_STATE_HASH from server and responds with STATE_HASH_REPORT.
 * Also supports watchMode for continuous hash reporting during navigation replay.
 */
'use strict';

(function () {
  var watchMode = false;
  var watchTimer = null;
  var lastReportedHash = null;

  function getCurrentHash() {
    if (window.__SI_CURRENT_HASH__) return window.__SI_CURRENT_HASH__;
    return {
      compositeHash: null,
      reactHash: window.__SI_REACT_HASH__ || null,
      domHash: null,
    };
  }

  function sendHashReport(requestId) {
    var hashInfo = getCurrentHash();
    if (!hashInfo.compositeHash) return;

    window.postMessage({
      __SITE_INSPECTOR__: true,
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
      var hashInfo = getCurrentHash();
      if (!hashInfo.compositeHash) return;
      if (hashInfo.compositeHash === lastReportedHash) return;

      lastReportedHash = hashInfo.compositeHash;
      window.postMessage({
        __SITE_INSPECTOR__: true,
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
    if (!event.data?.__SITE_INSPECTOR__) return;

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
