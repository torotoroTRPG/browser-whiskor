# Forensic Report: `__SI_CONFIG__` Not Propagated to MAIN World on Page Load

**Date:** 2026-06-24
**Reporter:** opencode (automated analysis session)
**Scope:** browser-whiskor v3, extension config propagation from server/ServiceWorker to MAIN-world injected scripts

---

## Executive Summary

When the server pushes a config via `POST /api/config` or WebSocket `SET_CONFIG`, the Service Worker stores it in `chrome.storage.local` and pushes it to **currently open** tabs. However, **any page loaded after** the config was set receives **no config at all** — `window.__SI_CONFIG__` remains `undefined`. This breaks every plugin that reads `__SI_CONFIG__` (e.g. `source-fetcher` reading `storeJs`).

---

## 1. Objective

**Goal:** Enable `source-fetcher.storeJs: true` so JS source files are persisted in the whiskor cache.

**Context:** A production React+Redux web app (referred to as "the target app" below). Its production webpack bundle `main.<hash>.js` (4.4MB) is loaded from CDN. We need the analyzer to fetch and store script contents to `cache/sources/`.

---

## 2. Test Environment

| Component | Path |
|---|---|
| Server | `C:\Users\onetr\AppData\Roaming\npm\node_modules\browser-whiskor\` |
| Dev source | `C:\JavaApp\browser-extension\browser-whiskor\` |
| Cache dir | `C:\Users\onetr\AppData\Roaming\npm\node_modules\browser-whiskor\cache\` |
| Extension ID (Chrome) | `hhfkbeloejjheeiihhjndfcogjhejoek` |
| Target page | `https://<target-app>/rooms/<room-id>` |

---

## 3. Procedure and Results

### 3.1 Initial Config Setup

| Step | Action | Expected | Actual | Status |
|---|---|---|---|---|
| 3.1.1 | Write `config.local.json` with `{"plugins":{"intelligence":{"sourceFetcher":{"storeJs":true,"maxJsSizeBytes":5242880}}}}` | Config persisted on disk, loaded at server start | File written, confirmed via `Get-Content` | ✅ |
| 3.1.2 | `whk restart` | Server restarts, extension reconnects | `whk health` shows `ok: true`, `wsConnections: 1`, `sessions: 5` | ✅ |
| 3.1.3 | `whk GET /api/config` | Config includes `sourceFetcher.storeJs: true` | Confirmed: `"storeJs": true, "maxJsSizeBytes": 5242880` | ✅ |
| 3.1.4 | Reload the target tab: `POST /api/action {"tabId":265874619,"action":{"type":"reload"}}` | Tab reloads, whiskor re-injects, source-fetcher runs with config | Tab reload confirmed (session data refreshed) | ✅ |
| 3.1.5 | Run collect: `whk POST /api/collect 265874619` | source-fetcher emits SOURCE_CONTENT, server stores JS files | Command succeeded (no error output) | apparently ✅ |
| 3.1.6 | Check `cache/sessions/*/raw/sources/` | `.js` files present alongside `.css` | Only `8dbddfdc.css` (18.9KB), `ea913396.css` (5.9KB), `catalog.json` — **no JS files** | ❌ |

**Prediction:** Setting `storeJs: true` via server config and reloading the page would cause source-fetcher to fetch and store JS content at the next collect cycle.

**Finding:** Config was correctly stored server-side but did **not** reach the MAIN-world plugin system.

### 3.2 Config Inspection via `execute_js`

| Step | Action | Expected | Actual | Status |
|---|---|---|---|---|
| 3.2.1 | `execute_js`: `JSON.stringify(window.__SI_CONFIG__?.plugins?.intelligence?.sourceFetcher)` | `{"storeJs":true,"maxJsSizeBytes":5242880}` | `undefined` | ❌ |
| 3.2.2 | `execute_js`: `typeof window.__SI_REGISTRY__` | `"object"` | `"object"` (registry exists) | ✅ |
| 3.2.3 | `execute_js`: `typeof window.__SI_CONFIG__` | `"object"` | `"undefined"` | ❌ |
| 3.2.4 | Check `sessionStorage.__SI_CONFIG__` | `"string"` (JSON) | `undefined` (empty on fresh load) | ❌ |

**Prediction:** After `POST /api/config` and page reload, `window.__SI_CONFIG__` should contain the merged config.

**Finding:** `__SI_CONFIG__` is entirely `undefined` in the MAIN world. The registry object exists but its internal `_config` never received the server config. This means the config propagation chain is broken at page load.

### 3.3 Direct Config Injection Workaround

| Step | Action | Expected | Actual | Status |
|---|---|---|---|---|
| 3.3.1 | `execute_js`: `(window.__SI_REGISTRY__.updateConfig({plugins:{intelligence:{sourceFetcher:{storeJs:true,maxJsSizeBytes:5242880}}}}), window.__SI_REGISTRY__.runPlugin('source-fetcher'), 'ok')` | source-fetcher runs, emits SOURCE_CONTENT with JS content | `ok: true, result: "ok"`, console log shows `[SECURITY] execute_js` only, no source-fetcher output | ❌ |
| 3.3.2 | Re-check `cache/sessions/*/raw/sources/` after step 3.3.1 | `.js` files appear | Still only CSS files | ❌ |

**Note:** `execute_js` wraps code in `new Function(\`return (${code})\`)()` — so the code must be a **single expression** (use comma operator, not semicolons). Our initial attempt used semicolons and failed with `"Unexpected token ';'"`.

**Finding:** Even with correct expression syntax and `registry.updateConfig()` apparently succeeding, source-fetcher still didn't produce stored JS files. Possible reasons:
- `__SI_REGISTRY__.updateConfig()` updates `registry._config` but not `window.__SI_CONFIG__` (the two are separate references)
- source-fetcher's `collect()` reads from `window.__SI_CONFIG__?.plugins?.intelligence?.sourceFetcher` (line 76 of source-fetcher.js), which is NOT the same as `registry._config`
- `const cfg = window.__SI_CONFIG__?.plugins?.intelligence?.sourceFetcher || {};` — since `__SI_CONFIG__` is never assigned, this always falls through to `{}`

---

## 4. Root Cause Analysis

### 4.1 Config Propagation Chain (Designed)

```
Server SET_CONFIG
  ↓ (WebSocket)
SW sw.js:559-573 handleServerMessage('SET_CONFIG')
  ├── chrome.storage.local.set({ SI_CONFIG: msg.config })   ← persisted
  ├── chrome.scripting.executeScript() → MAIN world
  │     postMessage({ __BROWSER_WHISKOR__: true, type: 'CONFIG_UPDATE', payload: cfg })
  │       ↓
  │     collector.js:43-47 — reads d.payload → registry.updateConfig(d.payload)  ✓
  │       ↓
  │     plugin-system.js:140-157 — merges newConfig into this._config            ✓
  │       ↓
  │     collector.js:45 — sessionStorage.setItem('__SI_CONFIG__', JSON.stringify(d.payload))  ✓ (SPA only)
  └── broadcastToPanels()
```

### 4.2 Bug: No Initial Config on Fresh Page Load

When a page is **loaded fresh** (navigation, reload, new tab):

```
Page loads
  ├── bridge.js (ISOLATED world, document_start)
  │     chrome.storage.onChanged.addListener(...)  ← ONLY fires on CHANGE, not on init
  │     chrome.runtime.onMessage.addListener(...)  ← ONLY receives CONFIG_UPDATE from SW
  │     ★ NO chrome.storage.local.get() on init ★
  │
  ├── plugin-system.js (MAIN world, document_start)
  │     constructor → _loadStoredConfig()
  │       → sessionStorage.getItem('__SI_CONFIG__')  ← EMPTY on fresh load
  │       → this._config = { mode: 'always_on', plugins: {}, options: {...defaults...} }
  │     ★ NO fallback to chrome.storage.local (MAIN world can't access chrome.*) ★
  │
  ├── collector.js (MAIN world, document_start)
  │     registry.installAll() → runs source-fetcher etc. with default config
  │     ★ At this point __SI_CONFIG__ is never read from storage ★
  │
  └── SW has no chrome.tabs.onUpdated listener to re-push config
        chrome.tabs.onUpdated only calls scheduleTabInventory() → sendToServer TAB_INVENTORY
        ★ NO config re-push on page load ★
```

**Result:** Config set via `POST /api/config` lives forever in `chrome.storage.local` but never reaches the MAIN world on a new page load. Only tabs that were already open at the time of `SET_CONFIG` receive it.

### 4.3 Secondary Issue: `window.__SI_CONFIG__` vs `registry._config`

Two separate variables exist:
- `window.__SI_REGISTRY__._config` (internal to PluginRegistry, updated by `updateConfig()`)
- `window.__SI_CONFIG__` (a **separate** global — **never assigned anywhere in the codebase**)

source-fetcher.js:76 reads `window.__SI_CONFIG__?.plugins?.intelligence?.sourceFetcher`. Since `__SI_CONFIG__` is never set, this is always `{}`, regardless of what `registry.updateConfig()` does.

**This appears to be a dead code path or a bug in source-fetcher.js itself.** It should be reading from `window.__SI_REGISTRY__?.getConfig()` instead of `window.__SI_CONFIG__`.

### 4.4 Summary of Defects Found

| # | File | Line(s) | Severity | Description |
|---|---|---|---|---|
| 1 | `extension/injected/bridge.js` | 31-38 | **High** | Listens for `chrome.storage.onChanged` but never reads the **current** value on init. Config in storage is invisible to newly loaded tabs. |
| 2 | `extension/background/sw.js` | 1450-1451 | **Medium** | `chrome.tabs.onUpdated` / `onCreated` only call `scheduleTabInventory()` — should also push stored config to the new tab. |
| 3 | `extension/injected/analyzers/source-fetcher.js` | 76 | **High** | Reads `window.__SI_CONFIG__` which is **never assigned** anywhere in the codebase. Should read from `window.__SI_REGISTRY__.getConfig()` or `window.__SI_REGISTRY__._config`. |
| 4 | `extension/injected/plugin-system.js` | 23 | **Low** | `getConfig()` is defined on the API object (`registry._api.getConfig()`) but source-fetcher accesses it via the raw global instead of the API. |
| 5 | `extension/injected/collector.js` | 45 | **Low** | `sessionStorage.setItem('__SI_CONFIG__', ...)` uses the key `__SI_CONFIG__` but plugin-system.js reads `__SI_CONFIG__` which is `undefined`. This works only because collector.js also calls `registry.updateConfig()` directly. |

---

## 5. Verification of Fix Paths (Not Applied)

The following fixes would resolve the issue but were **not applied** (as instructed):

### Fix A — bridge.js: Read current storage on init (recommended)

Add after existing listener registrations in `bridge.js`:
```js
chrome.storage.local.get('SI_CONFIG').then(result => {
  if (result.SI_CONFIG) {
    window.postMessage({
      __BROWSER_WHISKOR__: true,
      type: 'CONFIG_UPDATE',
      payload: result.SI_CONFIG,
    }, '*');
  }
});
```

**Expected result:** On every page load, the ISOLATED-world bridge reads the stored config and forwards it to MAIN world before plugins initialize. `__SI_CONFIG__` (or rather `registry._config`) would be populated by the time `installAll()` runs.

### Fix B — source-fetcher.js: Use registry API instead of dead global

Change line 76 from:
```js
const cfg = window.__SI_CONFIG__?.plugins?.intelligence?.sourceFetcher || {};
```
to:
```js
const cfg = (window.__SI_REGISTRY__?.getConfig() || {}).plugins?.intelligence?.sourceFetcher || {};
```

**Expected result:** source-fetcher reads config from the actual config object that `updateConfig()` modifies.

### Fix C — sw.js: Push config to newly loaded tabs

Add to the existing `chrome.tabs.onUpdated` listener at sw.js:1451:
```js
if (info.status === 'complete') {
  const { SI_CONFIG } = await chrome.storage.local.get('SI_CONFIG');
  if (SI_CONFIG) {
    chrome.scripting.executeScript({
      target: { tabId },
      func: (cfg) => window.postMessage(
        { __BROWSER_WHISKOR__: true, type: 'CONFIG_UPDATE', payload: cfg }, '*'
      ),
      args: [SI_CONFIG],
      world: 'MAIN',
    }).catch(() => {});
  }
}
```

**Expected result:** Config is pushed to every tab as soon as it finishes loading, not just at SET_CONFIG time.

---

## 6. Workaround (Manual, via `execute_js`)

**Does NOT work** because source-fetcher reads from `window.__SI_CONFIG__` which is never set by `registry.updateConfig()`.

The following runs successfully but produces no stored JS:
```js
window.__SI_REGISTRY__.updateConfig({
  plugins: { intelligence: { sourceFetcher: { storeJs: true, maxJsSizeBytes: 5242880 } } }
});
window.__SI_REGISTRY__.runPlugin('source-fetcher');
```

To make the workaround effective, you would need to ALSO set `window.__SI_CONFIG__`:
```js
window.__SI_CONFIG__ = window.__SI_REGISTRY__.getConfig();
// OR equivalently:
window.__SI_CONFIG__ = { plugins: { intelligence: { sourceFetcher: { storeJs: true } } } };
```

This was **not tested**.

---

## 7. Alternative Approach: Direct Resource Download

JS source files can be downloaded directly via curl without whiskor involvement:

```
curl -o main.js "https://<target-app>/static/js/main.<hash>.js"
```

This works and produces identical content to what whiskor's source-fetcher would store. The difference is:
- whiskor stores with hash dedup, change detection, and session correlation
- Direct download is a one-off snapshot

---

## 8. Files Examined

| File | Path | Relevance |
|---|---|---|
| `bridge.js` | `extension/injected/bridge.js` | ISOLATED-world config relay (lines 31-38) |
| `collector.js` | `extension/injected/collector.js` | MAIN-world CONFIG_UPDATE handler (lines 43-47) |
| `plugin-system.js` | `extension/injected/plugin-system.js` | Config storage and `updateConfig()` (lines 44-52, 140-157, 202-212) |
| `source-fetcher.js` | `extension/injected/analyzers/source-fetcher.js` | Reads config at line 76 |
| `sw.js` | `extension/background/sw.js` | SET_CONFIG handler (lines 559-573), tab lifecycle (lines 1450-1451) |
| `core.js` | `server/core.js` | Config push to SW via WebSocket |
| `config-loader.js` | `server/config-loader.js` | Config file loading |
| `action-executor.js` | `server/action-executor.js` | Action dispatch (no config involvement) |
| `source-store.js` | `server/source-store.js` | Source content persistence |
