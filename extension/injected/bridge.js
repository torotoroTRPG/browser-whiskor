/**
 * injected/bridge.js  –  ISOLATED world, document_start
 *
 * 1. Relays postMessage (MAIN world → collector) to background SW
 * 2. Relays chrome.storage config changes back to MAIN world
 * 3. Relays SW → MAIN world messages (CONFIG_UPDATE, MANUAL_COLLECT)
 *
 * SECURITY — trust boundary of this relay:
 *   The MAIN-world collectors share the PAGE's JS context (they must, to read
 *   React fiber / framework internals). So a postMessage arriving here cannot be
 *   cryptographically distinguished from one the page itself crafted — any secret
 *   we'd hand the collector, the page can read too. We therefore do NOT pretend to
 *   authenticate the sender. Instead the model is: observation data coming through
 *   this channel is treated as page-influenced (a hostile page can already lie
 *   about its own DOM/state), and NO command path is reachable here — the SW's
 *   click/type/debugger handling is on the separate WebSocket channel
 *   (handleServerMessage), which page postMessage cannot reach. The tabId/frameId
 *   the server trusts come from `sender` in the SW, never from the message body.
 *   What we DO enforce below: (a) the type must be a well-formed string, and
 *   (b) SW/panel-origin control types can't be impersonated by the page.
 */
'use strict';

// Control/result message types that legitimately originate ONLY from the SW or
// the DevTools panel — never from a MAIN-world collector. Dropping them here
// stops a page from impersonating SW-level messages (fake tab inventory, forged
// action/capture results, a spoofed EXT_HELLO handshake, etc.) to the server.
const RELAY_DENY = new Set([
  'EXT_HELLO', 'TAB_INVENTORY', 'TAB_CLOSED',
  'ACTION_RESULT', 'SCREENSHOT_RESULT', 'PACKED_SOM_RESULT', 'ELEMENT_CAPTURE_RESULT',
  'SOURCE_CONTENT', 'SOURCE_CAPTURE_DONE', 'CONFIG_FROM_PANEL',
  'CONFIG_UPDATE', 'MANUAL_COLLECT', // SW→MAIN commands; never relayed back (loop guard)
]);
const TYPE_RE = /^[A-Z][A-Z0-9_]*$/;

// ── MAIN world → background SW ────────────────────────────────────────────
window.addEventListener('message', function onCollectorMessage(event) {
  if (event.source !== window) return;
  if (!event.data?.__BROWSER_WHISKOR__) return;
  const type = event.data.type;
  // Well-formed collector type only, and never a SW/panel-origin control type.
  if (typeof type !== 'string' || !TYPE_RE.test(type) || RELAY_DENY.has(type)) return;

  // siteVersion is part of the emit envelope (plugin-system.js api.emit and
  // explorer.js both put it at the top level) and the server keys sessions and
  // state graphs by it (cache-writer getSession / core.js graph handlers). It is
  // page-influenced like the rest of the observation data — the server pairs it
  // with the trusted tabUrl below before using it for any graph identity.
  const siteVersion = (typeof event.data.siteVersion === 'string' && event.data.siteVersion.length <= 64)
    ? event.data.siteVersion : undefined;

  console.log('[SI Bridge] Relaying to SW:', type);
  try {
    chrome.runtime.sendMessage({
      from:     'collector',
      tabUrl:   location.href,
      type,
      payload:  event.data.payload,
      reqId:    event.data.reqId,   // CSS_ORIGIN_RESOURCE_REQUEST correlation id
      siteVersion,
      realtime: !!event.data.realtime,
      ts:       Date.now(),
    }).catch(() => {});
  } catch {
    // "Extension context invalidated" — the extension was reloaded and this is
    // an orphaned content script in a tab that predates the reload. The throw
    // is synchronous, so the promise .catch above never sees it. Nothing this
    // orphan sends can arrive anywhere; unhook so page postMessage traffic
    // stops producing uncaught errors in the page console.
    window.removeEventListener('message', onCollectorMessage);
  }
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

// ── Initial config pull (fresh page load) ─────────────────────────────────
// The SW only *pushes* config to tabs on SET_CONFIG (server connect / config
// change), reaching tabs that happen to be open at that moment. A tab loaded
// afterwards gets nothing, so its MAIN-world plugins run with default config.
// Read the persisted value on init and forward it, so config reaches plugins
// on every page load. The MAIN-world listener (collector.js) is registered
// synchronously at document_start, well before this async read resolves, and
// 'load'-phase plugins (source-fetcher / css-origin) collect far later still.
chrome.storage.local.get('SI_CONFIG').then((result) => {
  if (result && result.SI_CONFIG) {
    window.postMessage({
      __BROWSER_WHISKOR__: true,
      type:    'CONFIG_UPDATE',
      payload: result.SI_CONFIG,
    }, '*');
  }
}).catch(() => {});
