// Firefox/Chrome 互換シム
/* global browser, chrome */
const _b = (typeof browser !== 'undefined') ? browser : chrome;

/**
 * injected/bridge.js  –  ISOLATED world, document_start
 *
 * 1. Relays postMessage (MAIN world → collector) to background SW
 * 2. Relays _b.storage config changes back to MAIN world
 * 3. Relays SW → MAIN world messages (CONFIG_UPDATE, MANUAL_COLLECT)
 */
'use strict';

// ── MAIN world → background SW ────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__BROWSER_WHISKOR__) return;
  // Don't echo config updates back (prevents loop)
  if (event.data.type === 'CONFIG_UPDATE' || event.data.type === 'MANUAL_COLLECT') return;

  _b.runtime.sendMessage({
    from:     'collector',
    tabUrl:   location.href,
    type:     event.data.type,
    payload:  event.data.payload,
    realtime: !!event.data.realtime,
    ts:       Date.now(),
  }).catch(() => {});
});

// ── _b.storage → MAIN world (config changes from SW/HTTP API) ─────────
_b.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.SI_CONFIG) return;
  window.postMessage({
    __BROWSER_WHISKOR__: true,
    type:    'CONFIG_UPDATE',
    payload: changes.SI_CONFIG.newValue,
  }, '*');
});

// ── Background SW → MAIN world (commands: manual collect, etc.) ──────────
_b.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONFIG_UPDATE' || message.type === 'MANUAL_COLLECT') {
    window.postMessage({ __BROWSER_WHISKOR__: true, ...message }, '*');
  }
});
