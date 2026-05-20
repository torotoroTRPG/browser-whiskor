/**
 * analyzers/storage-reader.js  –  MAIN world
 * Reads localStorage, sessionStorage, and document.cookie.
 * Emits: STORAGE_SNAPSHOT
 */
'use strict';

(function () {
  if (window.__SI_STORAGE_INIT__) return;
  window.__SI_STORAGE_INIT__ = true;

  const MAX_VALUE_LEN = 1000;

  function readStorage(store) {
    const result = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key == null) continue;
        let val = store.getItem(key);
        if (val && val.length > MAX_VALUE_LEN) {
          val = val.slice(0, MAX_VALUE_LEN) + '…[truncated]';
        }
        // Try to pretty-print JSON values
        try {
          const parsed = JSON.parse(val);
          result[key] = { raw: val, parsed, isJson: true };
        } catch {
          result[key] = { raw: val, isJson: false };
        }
      }
    } catch (e) {
      // storage may be blocked (cross-origin iframes etc.)
    }
    return result;
  }

  function readCookies() {
    try {
      return document.cookie.split(';').map(c => {
        const eq = c.indexOf('=');
        const name  = eq !== -1 ? c.slice(0, eq).trim() : c.trim();
        const value = eq !== -1 ? c.slice(eq + 1).trim() : '';
        return { name, value: value.slice(0, MAX_VALUE_LEN) };
      }).filter(c => c.name);
    } catch {
      return [];
    }
  }

  function collect() {
    return {
      capturedAt:     Date.now(),
      pageUrl:        location.href,
      localStorage:   readStorage(window.localStorage),
      sessionStorage: readStorage(window.sessionStorage),
      cookies:        readCookies(),
      localStorageCount:   window.localStorage.length,
      sessionStorageCount: window.sessionStorage.length,
    };
  }

  window.__SI_STORAGE_READER__ = { collect };

})();
