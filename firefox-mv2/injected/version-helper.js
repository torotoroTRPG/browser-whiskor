/**
 * version-helper.js  –  MAIN world
 * Generates a fingerprint for the current site to detect version changes.
 */
'use strict';

(function () {
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return h.toString(36);
  }

  function getSiteFingerprint() {
    const scripts = Array.from(document.scripts)
      .map(s => s.src || s.textContent.slice(0, 100))
      .sort()
      .join('|');
    
    const meta = {
      url: location.origin + location.pathname,
      title: document.title,
      scriptHash: hash(scripts),
      reactVersion: window.React?.version || 'unknown'
    };

    return hash(JSON.stringify(meta));
  }

  window.__SI_VERSION__ = {
    getFingerprint: getSiteFingerprint,
    id: getSiteFingerprint()
  };
})();
