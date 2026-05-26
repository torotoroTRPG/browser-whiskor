/**
 * injected/bridge.js  –  ISOLATED world, document_start
 *
 * 1. Relays postMessage (MAIN world → collector) to background SW
 * 2. Relays chrome.storage config changes back to MAIN world
 * 3. Relays SW → MAIN world messages (CONFIG_UPDATE, MANUAL_COLLECT)
 */
'use strict';

// ── MAIN world → background SW ────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__BROWSER_WHISKOR__) return;
  // Don't echo config updates back (prevents loop)
  if (event.data.type === 'CONFIG_UPDATE' || event.data.type === 'MANUAL_COLLECT') return;

  console.log('[SI Bridge] Relaying to SW:', event.data.type);
  chrome.runtime.sendMessage({
    from:     'collector',
    tabUrl:   location.href,
    type:     event.data.type,
    payload:  event.data.payload,
    reqId:    event.data.reqId,   // CSS_ORIGIN_RESOURCE_REQUEST correlation id
    ...event.data.payload,
    realtime: !!event.data.realtime,
    ts:       Date.now(),
  }).catch(() => {});
});

// ── chrome.storage → MAIN world (config changes from SW/HTTP API) ─────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.SI_CONFIG) return;
  window.postMessage({
    __BROWSER_WHISKOR__: true,
    type:    'CONFIG_UPDATE',
    payload: changes.SI_CONFIG.newValue,
  }, '*');
});

// ── Background SW → MAIN world (commands: manual collect, etc.) ──────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONFIG_UPDATE' || message.type === 'MANUAL_COLLECT') {
    window.postMessage({ __BROWSER_WHISKOR__: true, ...message }, '*');
  }
});
