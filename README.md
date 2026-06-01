# browser-whiskor v0.4.2

**Agent-grade browser perception and state navigation.** A Chrome/Firefox extension + MCP server that gives AI agents "eyes" into the browser — framework state, DOM structure, text coordinates, network traffic — and the ability to navigate between recorded UI states.

## What This Is (and Isn't)

**This is a perception and state management tool.** It gives AI agents rich, structured visibility into what's happening inside a browser tab, plus a semantic state graph that enables navigation between recorded UI states.

**What it provides (senses):**
- **Sight:** Component trees, state, props, hooks for React/Vue/Angular/Svelte/etc.
- **Touch:** Text content with pixel-precise coordinates (OCR-style)
- **Hearing:** Network requests/responses, console logs
- **Spatial awareness:** UI catalog (buttons, links, forms), accessibility tree, CSS layout
- **Memory:** Semantic state graph with labels, tags, and action paths between states

**What it also has (hands):**
- Click, type, navigate, scroll, and other browser actions
- State-based navigation: "go to the cart page" via recorded action replay

These action features work, but they live outside the core purpose of this project. **For reliable browser automation, we recommend pairing browser-whiskor with a dedicated browser control tool** (Playwright, Puppeteer, or a browser-use agent). The action layer here is useful for simple follow-up actions after perception and state navigation, but it is not a replacement for a proper automation framework.

## Framework Support — Honest Depth Report

Not all frameworks are supported equally. Here is the real state of each adapter:

| Framework | Depth | What You Get | Caveats |
|-----------|-------|-------------|---------|
| **React** | Deep | Full Fiber tree, hooks (useState/useRef/useEffect/etc.), Redux, Zustand, Jotai, MobX, Recoil, React Query, Router, render timings | Requires Bippy (bundled). Production builds work but hook names may be mangled. MobX/Recoil: best-effort detection via multi-layer failover |
| **Vue 3** | Deep | Component tree, setupState, props, Pinia stores, Vuex, Vue Router, provides | Production builds fully supported |
| **Vue 2** | Medium | Component tree, $data, $props, computed, Vuex, Vue Router | Relies on `__vue__` property; may miss deeply nested components |
| **Angular** | Medium | Component tree (Ivy), inputs, directives, NgRx store, Signals (v16+), Router | AngularJS (1.x) and Angular (2+) both supported but separately. NgRx detection depends on DevTools or injector access |
| **Svelte** | Medium | Svelte 4: component instances via DOM internals. Svelte 5: dev mode effect tree. Stores via subscribe-pattern scan, CSS scoping hashes | Production Svelte 4: component instances are not retained on DOM. Detection relies on internal property patterns |
| **Preact** | Medium | Component tree via vnode traversal, hooks, state. Multi-property-name probing for minified builds | Production builds mangle internal names; we probe candidates (`__k`, `_children`, etc.) but root vnode may not always be findable |
| **Alpine.js** | Medium | Components (`[x-data]` data), v3 stores via `Alpine.store()`, v2 registered components | v2/v3 both supported. Store access uses internal `_stores` map |
| **SolidJS** | Medium-Light | Dev mode: owner tree with signals/effects/memos. Production: SSR hydration markers, stores via 6-layer failover, router | Production builds: owner tree unavailable. Store detection uses DevTools hook → window scan → context providers → signal proxies → event closures → candidate names |

**In short:** React and Vue 3 are the most reliable. Everything else is "best effort" with multi-layer detection that works well in dev mode and reasonably in production.

## Architecture

```
AI Agent (Claude / Cursor / etc.)
    │ MCP stdio (JSON-RPC 2.0)
    ▼
┌─ server/mcp/ ──────────────────────────────────────────────────┐
│  MCP Layer (62 tools, configurable visibility)                 │
│                                                                │
│  mcp-server.js          ← Entry point, wires layers together   │
│  mcp/registry.js        ← Tool registration, filtering, presets│
│  mcp/transport.js       ← stdio JSON-RPC transport             │
│  mcp/tools/read.js      ← 18 read tools (sessions, DOM, etc.) │
│  mcp/tools/write.js     ← 16 write tools (click, type, drag — observe opt.) │
│  mcp/tools/tabs.js      ← 4 tab tools (list/switch/open/close) │
│  mcp/tools/capture.js   ← 2 capture tools (screenshot, refresh)│
│  mcp/tools/control.js   ← 10 control tools (config, explorer, profiles)  │
│                                                                │
│  Tool visibility: per-tool on/off, category toggle, presets    │
│  Config: server/configs/mcp-tools.json                         │
└────────────────────────┬───────────────────────────────────────┘
                         │ callbacks
┌─ server/index.js ──────────────────────────────────────────────┐
│  Server Core                                                   │
│  HTTP :7892  ← cache API, config, screenshots, actions         │
│  WebSocket :7891 ← extension bridge                            │
│                                                                │
│  cache-writer.js       ← Disk persistence, freshness tracking  │
│  action-executor.js    ← Action routing to extension           │
│  screenshot-manager.js ← Screenshot capture + SoM overlay      │
│  config-change-log.js  ← Config audit, validation, auto-revert │
│  config-loader.js      ← config.json + .env + mcp-tools.json   │
│  delta-engine.js       ← Smart delta aggregation, motion clustering │
│  pattern-registry.js   ← UI pattern storage + lookup (ref IDs) │
│                                                                │
│  state-store.js        ← State graph + LRU + gzip + backward compat wrapper │
│  state-fingerprint.js  ← FNV32 hash engine                     │
│  state-semantic.js     ← Labels, tags, keyState, search        │
│  state-navigator.js    ← BFS path finding + action replay      │
└──────────┬──────────────────────────────┬──────────────────────┘
           │ HTTP :7892                     │ WebSocket :7891
           ▼                                ▼
┌─ Cache ────────────┐    ┌─ Extension (Chrome MV3) ─────────────┐
│ cache/{tabId}/     │    │ background/sw.js                     │
│   _index.json      │    │ injected/collector.js                │
│   raw/visual/      │    │ injected/bridge.js                   │
│   raw/network/     │    │ injected/executor.js                 │
│   raw/ui/          │    │ injected/explorer.js                 │
│   raw/accessibility│    │ injected/state-reporter.js           │
│   raw/storage/     │    │ injected/plugin-system.js            │
│   raw/console/     │    │ injected/adapters/ (9 frameworks)    │
│   raw/perf/        │    │ injected/analyzers/ (13 analyzers)   │
│   raw/css/         │    │ lib/bippy.iife.js                    │
│   raw/dom/         │    └──────────────────────────────────────┘
│   raw/react_*.json │
│                    │    ┌─ Extension (Firefox MV2) ────────────┐
│ graphs/            │    │ background/background.js             │
│   {ver}.json.gz    │    │ injected/ (synced with Chrome)       │
│   snapshots/       │    └──────────────────────────────────────┘
└────────────────────┘
```

## State Graph & Navigation

browser-whiskor builds a semantic state graph as you browse or run the autonomous explorer. Each state is identified by a composite hash (React state priority, DOM fallback) and enriched with:

- **Auto-generated label:** "Cart page (2 items, $49.99 total)"
- **Semantic tags:** `["authenticated", "cart-open"]`
- **keyState:** Important values extracted from Redux/Zustand stores
- **Action edges:** Recorded transitions with confidence scores

### Workflow

1. **Discover states:** `list_states()` or `search_states("cart")`
2. **Inspect a state:** `get_state_detail(hash)`
3. **Check path:** `get_navigation_path({ fromHash, toHash })` (dry-run)
4. **Navigate:** `navigate_to_state({ tabId, hash })` — replays recorded actions with hash verification

### State Hashing

States are identified by a composite hash:
- **reactHash:** Component tree shape + router path + store keys (FNV32; non-deterministic prop values filtered — see below)
- **domHash:** URL pathname + interactive element signatures
- **compositeHash:** `FNV32(reactHash + domHash)` if React is available, otherwise `domHash`

Non-deterministic prop values are filtered out so the hash stays stable across volatile changes. The filter is **key-aware** by default (`config.json` → `react.hashFilter.mode`):
- **`key-aware`** (default): a value is normalized away only when its *key* looks volatile (`createdAt`, `*At`, `timestamp`, `nonce`…) or the value is an unambiguous UUID v4 / ISO-8601 datetime. Legitimate numeric IDs — even 13-digit — survive, so distinct states stay distinct.
- **`aggressive`**: also strips bare 13-digit numbers and 32+ char random strings regardless of key.
- **`off`**: no filtering (legacy).

See `docs/v0.3.6-improvements.md` for the rationale and the dual-hash implementation note.

## Setup

### Installation

```bash
cd browser-whiskor-v3
npm install
node server/index.js
```

> **Note on Machine Learning Models:** 
> On first startup, the server will automatically download the ONNX model (~50MB) for Semantic Search from Hugging Face Hub. This is a one-time download and takes 30-60 seconds depending on your connection. **No Hugging Face account or login is required.** The model is cached in `.model-cache/`.
> 
> If the automatic download fails, you can manually run: `npm run download-model`

### Chrome/Edge (MV3)
1. `chrome://extensions` → Developer mode ON
2. "Load unpacked" → select `extension/` folder

### Firefox (MV2)
1. `about:debugging` → This Firefox → Load Temporary Add-on
2. Select `firefox-mv2/manifest.json`

## MCP Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "browser-whiskor": {
      "command": "node",
      "args": ["/path/to/browser-whiskor-v3/server/index.js"]
    }
  }
}
```

### Proxy Mode (Coexistence with Standalone Server)

If you manually start a standalone Whiskor server (e.g., `node server/index.js` to view the dashboard and manage browser extension connections) and then launch an editor or client that spawns browser-whiskor via MCP, a port conflict (`EADDRINUSE`) would normally occur.

To prevent this, browser-whiskor automatically detects if another instance is already running on port `7892`. If detected, the MCP process automatically switches to **Proxy Mode**:
- It bypasses WebSocket/HTTP port binding (preventing socket conflicts).
- It transparently proxies all tool actions, screenshots, data collection, and semantic embeddings to the running standalone server.

This allows seamless coexistence of a global browser instrumentation dashboard and local editor-based AI agents.

---

## Explorer — Honest Assessment

The autonomous exploration engine (`explorer.js`) uses a unified composite hash for state identification, fuzzy element matching, loop detection, and depth limiting. Current status:

- **Unified hashing:** React state (when available) + DOM signature ensures accurate state deduplication across SPA navigations
- **Element matching:** Token overlap + character bigram similarity for fuzzy text matching
- **Loop detection:** Revisits the same state hash N times → backtracks
- **Depth limiting:** Configurable max depth (default: 20)
- **State graph:** All transitions recorded with confidence scores based on observation count and recency

**What it does well:** Builds a navigable state graph of the application. The graph can be queried and traversed by agents using `navigate_to_state`.

**What it cannot do:** Handle authentication flows that require credentials, or navigate states that were never recorded in the graph.

**Recommendation:** Run the explorer to build the state graph, then use `navigate_to_state` for reliable state-based navigation.

## Chrome (MV3) vs Firefox (MV2) — Adapter Parity

The Chrome and Firefox builds share the same core architecture. **Injected scripts (analyzers, adapters, executor, state-reporter) are kept in sync between both builds.** The background layer differs due to manifest requirements (Service Worker vs Event Page).

**Adapter parity may diverge over time.** The Chrome MV3 adapters receive the most iteration as the primary development target. Firefox MV2 adapters are functionally equivalent for core features but may lag behind on newer framework-specific capabilities. The gap is not permanent — both builds share the same codebase for injected scripts, and adapter updates can be ported as needed.

**What works the same on both:** React (core), network capture, text-coords, UI catalog, CSS analysis, perf metrics, accessibility tree, console logger, storage reader, action executor, state reporting, state navigation.

**Recommendation:** Chrome/Edge for the deepest framework introspection. Firefox is fully functional for DOM-level perception (text, UI catalog, network, accessibility) and all state navigation features.

## Data Quality Warnings

Responses may include a `_warnings` array when data is incomplete or collected under degraded conditions:

```json
{
  "_warnings": [
    { "code": "ADAPTER_LIMITED", "message": "Firefox MV2 adapter: only hydration markers available." },
    { "code": "STALE_DATA", "ageMs": 45000, "message": "Data is 45s old. Consider calling refresh_data." }
  ]
}
```

Warning codes:
| Code | Meaning |
|------|---------|
| `ADAPTER_LIMITED` | Framework adapter is a stub or significantly reduced vs Chrome |
| `STALE_DATA` | Data age exceeds freshness threshold (default: 30s) |
| `PARTIAL_TREE` | Component tree was truncated (depth limit or serialization error) |
| `NO_FRAMEWORK` | No framework detected; `get_framework_state` returned generic DOM |
| `NO_MATCH` | Fuzzy text search returned no results above minScore |

---

## MCP Tools (v0.4.2: 62 tools)

### Dynamic Tool Profiles

Instead of exposing all 62 tools at once, browser-whiskor uses **dynamic profiles** to keep AI context lean:

| Profile | Tools | Auto-Trigger | Idle Unload |
|---------|-------|-------------|-------------|
| **core** (14) | get_sessions, get_index, get_text_coords, get_viewport, get_framework_state, get_ui_catalog, get_network, find_target, refresh_data, capture_screenshot, capture_element_screenshot, click, type_text, navigate_to | Always loaded | Never |
| **debug** (+6) | get_console_logs, get_storage, get_perf_metrics, get_css_analysis, get_dom_snapshot, get_accessibility | "console", "debug", "error" | 10 turns |
| **state-nav** (+9) | get_state_map, list_states, search_states, get_state_detail, pin_state, navigate_to_state, get_navigation_path, get_state_map_visual, replay_session | "state", "graph", "navigate", "replay" | 8 turns |
| **delta** (+3) | get_delta, list_patterns, lookup_pattern | "delta", "change", "scroll" | 6 turns |
| **advanced-actions** (+11) | drag, hover, select_option, check_box, mouse_scroll, right_click, press_key, go_back, go_forward, reload_page, scroll_page | "drag", "hover", "select" | 5 turns |
| **tabs** (+4) | list_tabs, switch_tab, open_tab, close_tab | "switch tab", "new tab", "popup", "redirect" | 6 turns |
| **intelligence** (+4) | explain_element, why_did_this_change, get_source_file, detect_site_updates | "explain", "why", "source", "cause" | 5 turns |
| **admin** (+4) | set_config, get_config_changes, trigger_collect, trigger_explorer | "config", "collect" | 3 turns |
| **power** (+2) | execute_js, wait_for_element | "execute", "wait" | 2 turns |

**How it works:**
1. **Core tools** are always available.
2. **Auto-detection**: When you call a tool that matches a profile's triggers, the server automatically loads that profile. Triggers are matched against both the tool name and the tool's string arguments (whole-word), so an intent expressed in arguments — e.g. `get_text_coords({match: "console error"})` — can surface the relevant profile. Argument scanning can be disabled via `agentControl.argTriggerDetection: false`.
3. **Idle unloading**: Profiles not used for N turns are automatically removed.
4. **Warnings**: If a profile stays active too long, you'll get a warning suggesting unload→reload.
5. **Manual control**: Use `load_profile`, `unload_profile`, `search_tools`, and `profile_status` for explicit management.

> **Meta tools are always visible.** `search_tools`, `load_profile`, `unload_profile`, `profile_status`, and `analyze_click` are exposed in every `tools/list` response regardless of the active profiles, so an agent can discover and bootstrap the rest of the toolset from a cold start. They are owned by `server/tool-manager.js` (`ALWAYS_VISIBLE_TOOLS`) and intentionally **not** listed in any profile in `server/configs/tool-profiles.json`. `profile_status` additionally returns an `available` array listing every inactive profile, its `requiresConfig` gate and tool count, so the agent can plan loads without an extra `search_tools` round-trip.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `WHISKOR_MCP_SESSION_ID` | Pin the MCP session id (for tests / deterministic workflows). Must match `/^[A-Za-z0-9_.:-]{1,64}$/`; invalid values are ignored with a warning. | `mcp-<epoch-ms>` |
| `WHISKOR_CACHE_DIR` | Override the session cache root used by the integrity check on startup. | `<repo>/cache/sessions` |

### Perception (READ)

| Tool | Description |
|------|-------------|
| `get_sessions` | Active tabs (tabId, URL, data freshness) |
| `get_index` | Session file listing with summaries |
| `get_text_coords` | Text + absolute coordinates with fuzzy search and similarity scoring |
| `get_viewport` | Current viewport size and scroll position |
| `get_framework_state` | Component tree + state for detected framework |
| `get_network` | Captured HTTP requests/responses |
| `get_ui_catalog` | Buttons, links, forms listing |
| `get_accessibility` | ARIA accessibility tree |
| `get_storage` | localStorage / sessionStorage / Cookies |
| `get_console_logs` | Console output + unhandled errors |
| `get_perf_metrics` | Web Vitals (LCP, FCP, CLS, TTFB) |
| `get_css_analysis` | CSS variables, stylesheets |
| `get_dom_snapshot` | Generic DOM tree / global variables |
| `get_state_map` | State transition graph from exploration |
| `list_states` | List all recorded states with semantic labels, tags, visit counts |
| `search_states` | Fuzzy-search states by label, tags, URL, or keyState |
| `get_state_detail` | Full metadata for a specific state, optionally with snapshot |
| `pin_state` | Bookmark a state with a custom label and tags |
| `get_delta` | Latest aggregated UI changes (scroll, motion groups, content updates) |
| `list_patterns` | List known UI patterns for a tab |
| `lookup_pattern` | Look up full definition of a pattern by its reference ID |

### State Navigation

| Tool | Description |
|------|-------------|
| `navigate_to_state` | Navigate to a target state by replaying recorded actions (BFS path + hash verification) |
| `get_navigation_path` | Dry-run: check if a path exists without executing actions |

### Action (WRITE)

> These work but are not the focus of this project. For serious browser automation, use Playwright/Puppeteer alongside browser-whiskor.

> **`observe` option:** `click`, `type_text`, `press_key`, `hover`, `scroll_page`, `mouse_scroll`, `drag`, `select_option`, `check_box`, and `right_click` accept `observe: true` (plus optional `observeTimeoutMs`, default 3000). After the action, the server watches the page state hash until it settles and returns `_observation: { available, fromHash, toHash, hashChanged, settled, reads, mode, elapsedMs }` — letting you check whether the action changed the UI state without a separate `refresh_data` round-trip. The settle loop uses **adaptive polling** (fast first reads to catch brief SPA transitions, then back-off) plus a **quiescent window** so a fast A→B→A flip doesn't settle early; tune via `config.json` → `observe`, or set `adaptive: false` for fixed-interval legacy behaviour. Requires the page to report a composite state hash (state graph / explorer active); otherwise `_observation.available` is `false` and the action still runs normally.

| Tool | Description |
|------|-------------|
| `navigate_to` | Navigate to URL |
| `click` | Click by selector, text, or coordinates |
| `right_click` | Right-click (context menu) by selector, text, or coordinates |
| `type_text` | Text input (React synthetic event aware) |
| `press_key` | Keyboard shortcuts |
| `hover` | Hover (dropdowns, tooltips) |
| `scroll_page` | Scroll to position or element |
| `mouse_scroll` | Fire wheel event at specific coordinates |
| `drag` | Drag from coordinates/selector to coordinates |
| `select_option` | `<select>` value |
| `check_box` | Checkbox toggle |
| `execute_js` | Arbitrary JavaScript |
| `wait_for_element` | Wait for element |
| `go_back` / `go_forward` | Browser history |
| `reload_page` | Reload |

### Tabs

| Tool | Description |
|------|-------------|
| `list_tabs` | List all open browser tabs (every window), including tabs whiskor has not instrumented. Complements `get_sessions` (whiskor-active tabs only). |
| `switch_tab` | Activate a tab by `tabId` and bring its window to the foreground (handles popups, auth windows) |
| `open_tab` | Open a new tab, optionally at a URL; returns the new `tabId` |
| `close_tab` | Close a tab by `tabId` |

### Intelligence

| Tool | Description |
|------|-------------|
| `explain_element` | Explain why an element has its current CSS appearance (selector, specificity, cascade, sourcemap) |
| `why_did_this_change` | Correlate a UI change with network events and framework transitions |
| `analyze_click` | Analyze a click target's React/Vue event handlers before clicking |
| `get_source_file` | Retrieve source file content by URL or hash |
| `detect_site_updates` | Cross-session: detect which CSS/JS files have changed |

### Capture

| Tool | Description |
|------|-------------|
| `capture_screenshot` | Screenshot (base64 PNG), optionally with numbered markers (SoM) |
| `capture_element_screenshot` | Element-level screenshot by selector or rect with padding |
| `refresh_data` | Trigger data collection + wait for completion |

### Control

| Tool | Description |
|------|-------------|
| `set_config` | Change extension settings |
| `get_config_changes` | Review config changes made during session |
| `trigger_collect` | Manual data collection |
| `trigger_explorer` | Start/stop autonomous exploration |

---

## Text Search — Fuzzy Matching

`get_text_coords` supports two search modes:

**`search`** — Exact substring match (case-insensitive). Fast, returns all containing items.

**`match`** — Semantic Similarity & Fuzzy matching. Powered by a local **MiniLM ONNX model** (running in a background Worker Thread), this provides high-quality semantic similarity combined with character n-gram scoring. It returns results sorted by similarity score (descending, 0.0–1.0). Useful when you don't know the exact text — e.g., searching for `"sign in"` will seamlessly surface `"Login"`, `"Sign In"`, or `"Log in"`.

```json
{
  "name": "get_text_coords",
  "arguments": {
    "tabId": 1234,
    "match": "login",
    "level": "blocks",
    "maxResults": 10
  }
}
```

Each result includes a `contextHint` field — a short description of the element's role (e.g., `"navigation link"`, `"form label"`, `"heading"`, `"button text"`) so the agent can understand *why* this text appears and in what context. 

> **Performance Note:** The embedding model runs entirely locally in a dedicated worker thread with dynamic batching. To prevent latency, embeddings are pre-calculated asynchronously when `refresh_data` is called or when page updates are detected.

---

## Data Freshness

All data includes a `_freshness` field:
```json
{
  "_freshness": {
    "available": true,
    "capturedAt": 1716000000000,
    "ageMs": 1200,
    "isStale": false
  }
}
```

Data older than 30 seconds is marked `isStale: true`. Use `refresh_data` to get fresh data.

## Smart Delta & Pattern Registry

Instead of streaming raw coordinate updates, browser-whiskor aggregates UI changes into **semantic events** that AI agents can understand efficiently.

### How It Works

1. **Delta Engine** (`delta-engine.js`): Collects `TEXT_COORD_DELTA` frames from the extension and aggregates them over a 1.5s window (or 5 frames).
2. **Motion Clustering**: Elements moving with the same vector are grouped together. If 70%+ of elements move the same way, it's classified as a **scroll event** — individual element positions are omitted.
3. **Pattern Registry** (`pattern-registry.js`): UI patterns (modals, toasts, loading spinners) are hashed and stored. The first time a pattern appears, its full definition is sent. Subsequent appearances are sent as a **reference ID** (`ref: "pat-a1b2c3d4"`).
4. **Noise Filtering**: Pure CSS animations (opacity-only, color-only, shadow-only) are ignored. Only position, size, text, and state changes are reported.

### AI Usage

When you call `get_delta`, you get:

```json
{
  "elapsed_ms": 1500,
  "scroll": { "vector": { "x": 0, "y": -500 }, "affected_elements": 15 },
  "motion_groups": [
    { "ref": "pat-a1b2c3d4", "vector": { "x": 10, "y": 0 }, "count": 5 }
  ],
  "appearances": [
    { "ref": "pat-e5f6g7h8", "id": "toast-1", "text": "Saved!" }
  ],
  "_patterns": {
    "new": [{ "ref": "pat-e5f6g7h8", "def": { "type": "appearance", ... } }],
    "known": [{ "ref": "pat-a1b2c3d4" }]
  }
}
```

- **`ref` IDs** are compact references. If you recognize the pattern from context, proceed normally.
- **`lookup_pattern("pat-xxx")`** retrieves the full definition if you've forgotten what a pattern is.
- **`list_patterns(tabId)`** shows all patterns observed for a tab.

This design keeps token usage low while giving AI agents a clear understanding of **what changed and why**.

## HTTP API

```
GET  http://localhost:7892/health             → Connection status
GET  http://localhost:7892/api/config         → Current config
POST http://localhost:7892/api/config         → Change config
GET  http://localhost:7892/api/sessions       → Session list
POST http://localhost:7892/api/collect        → Manual collection
POST http://localhost:7892/api/screenshot     → Screenshot
POST http://localhost:7892/api/action         → Execute action
GET  http://localhost:7892/api/graphs         → State graph listing
GET  http://localhost:7892/                   → Dashboard
```

> **PowerShell / Windows note:** When using the HTTP API from PowerShell, be aware that `curl` is an alias for `Invoke-WebRequest` and backslash escaping in double-quoted strings works differently than bash. Use single quotes for the JSON body, or use `Invoke-RestMethod` instead:
> ```powershell
> # ✓ Works
> Invoke-RestMethod -Uri http://localhost:7892/api/action -Method Post -ContentType application/json -Body '{"tabId":1234,"action":{"type":"navigate","url":"https://example.com"}}'
> # ✗ May fail — \" inside "..." is not an escape in PowerShell
> curl -d "{\"tabId\":1234,...}"
> ```

## Dependencies

**Server dependencies:**
- **`ws`** (^8.18.0) — WebSocket server
- **`@xenova/transformers`** (^2.0.0) — ONNX-based semantic search (MiniLM model, added in v0.3.2)
- **`playwright`** (^1.60.0) — E2E testing only (not required for runtime)

**Extension side:** Zero-dependency vanilla JS.

> **Note:** The semantic search feature uses a local ONNX model (~50MB) that is automatically downloaded during `npm install` via the `postinstall` script. No external API calls or authentication required. Model is cached in `.model-cache/`.

## Agent Config Control

Agents can modify server settings via `set_config`, but this is **disabled by default** for safety.

### Enabling agent config control

Set in `config.json`:
```json
{
  "agentControl": {
    "allowAgentConfig": true,
    "autoRevertConfig": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `allowAgentConfig` | `false` | Allow agents to change config via `set_config` |
| `autoRevertConfig` | `false` | Auto-revert non-recommended changes on next server restart |

### Non-recommended changes

The following changes trigger warnings and may be auto-reverted:
- Disabling security features (`allowExecuteJs`, `allowActions`, `allowScreenshots`)
- Disabling plugins (reduces perception capability)
- Extreme values (`react.maxDepth > 100`, `textCoords.maxWords > 20000`)

### Reviewing changes

Use `get_config_changes` to see what was modified:
```json
{
  "name": "get_config_changes",
  "arguments": { "activeOnly": true }
}
```

## Set-of-Marks (SoM) Screenshots

Instead of working with raw pixel coordinates, agents can request screenshots with **numbered markers** overlaid on interactive elements. This eliminates coordinate misidentification.

### Enabling

Set in `config.json`:
```json
{
  "agentControl": {
    "screenshotMarks": true
  }
}
```

### Usage

```json
{
  "name": "capture_screenshot",
  "arguments": {
    "tabId": 1234,
    "marks": true
  }
}
```

Response includes:
```json
{
  "ok": true,
  "dataUrl": "data:image/png;base64,...",
  "elements": {
    "1": { "tag": "button", "text": "Sign In", "center": {"x": 450, "y": 320}, "selector": "#login-btn" },
    "2": { "tag": "a", "text": "Forgot password?", "center": {"x": 450, "y": 380}, "selector": "a.forgot-link" },
    "3": { "tag": "input", "text": "Enter email...", "center": {"x": 450, "y": 260}, "selector": "input[type=email]" }
  },
  "_note": "Use element numbers to reference elements..."
}
```

The agent can then say "click element 1" instead of dealing with raw coordinates.

### Performance

- **Zero overhead when disabled** — marks rendering only runs when `marks: true` is passed
- **OffscreenCanvas** is used in the MV3 Service Worker (no DOM manipulation)
- Element collection uses a single `querySelectorAll` in the content script

## Testing & Quality

**262 automated tests** run via `npm test` (237 unit, 20 integration, 5 stress), plus 83 Playwright E2E specs (`npm run test:e2e`).

| Category | Count | Scope |
|----------|-------|-------|
| **Unit** | 237 | Server logic, WS messaging, MCP tools, state hashing / ND filter, observe settle, Canvas math |
| **Integration** | 20 | Server ↔ Client flows, error recovery, multi-tab |
| **Stress** | 5 | Large payloads (5000+ words), long sessions |
| **E2E (Playwright)** | 83 | Dashboard, interactions, MCP tools, resilience, state machine, full pipeline |

> **Note:** The Playwright E2E specs (`tests/e2e/`) exercise the dashboard, MCP tools, interactions, resilience, and a full-pipeline scenario in a real browser. They require a live environment and are not part of `npm test`; core pipeline correctness is also covered by the unit/integration suites.

**Pre-push validation:** Run `.\scripts\validate.ps1` to check YAML syntax, shared/ sync status, and file structure before committing.

## License

MIT
