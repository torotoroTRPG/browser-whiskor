# browser-whiskor

[![MCP Badge](https://lobehub.com/badge/mcp/torotorotrpg-browser-whiskor)](https://lobehub.com/mcp/torotorotrpg-browser-whiskor)

Browser perception and state navigation for AI agents. A Chrome/Firefox extension + MCP server that lets an agent see what is happening inside a browser tab — framework state, DOM structure, text coordinates, network traffic — and navigate between recorded UI states.

> Most of this project — code, tests, and documentation — is written with an AI coding agent, directed and reviewed by the maintainer. It is pre-1.0 software: interfaces still change between releases, and an update may break existing behavior.

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

### Compared to CDP-based tools (chrome-devtools-mcp, Playwright MCP)

CDP-driven MCP servers are good at *driving* a browser: trusted input, performance traces, DevTools-grade network inspection — usually against a browser instance they launch and own. browser-whiskor sits on a different axis:

- **Framework state, not just the DOM** — component trees, hooks, and store contents (Redux / Pinia / Zustand / …) via 9 in-page adapters. CDP sees the rendered DOM; the adapters read what the app itself holds.
- **Your live browser, not a driven one** — an extension inside the browser you already use (Chrome and Firefox), sharing tabs with you. The agent doesn't launch or own a browser instance.
- **Recorded, queryable sessions** — observations persist to a cache with cross-session search, and a state graph grows passively as you browse; `navigate_to_state` replays verified paths through it.
- **Token-lean representations** — text coordinates, ASCII layout maps, packed Set-of-Marks, delta aggregation with pattern references, instead of full screenshots and DOM dumps.

They compose rather than compete: use a CDP tool or Playwright to drive, and browser-whiskor to perceive and remember. (For widgets that demand trusted input, whiskor has its own optional CDP path — see High-Fidelity Input below.)

## Framework Support

Not all frameworks are supported equally. The current depth of each adapter:

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

## Maintenance Policy

This is a one-person project instrumenting 9 framework adapters across 2 browsers plus 15 page-side analyzers — more surface than one maintainer can keep equally fresh. Support is split into two tiers, building on the depth ratings above:

- **Repair-guaranteed**: React, Vue 3, and the framework-agnostic DOM/analyzer layer (text coordinates, UI catalog, accessibility, network, DOM snapshot, etc. — these run on every page regardless of framework). Reports against these are treated as priority bugs.
- **Best-effort**: Vue 2, Angular, Svelte, Preact, Alpine.js, SolidJS — the "Medium"/"Medium-Light" rows above. These work today, but a breaking change in the underlying framework may sit unfixed until someone (maintainer or contributor) hits it. PRs are reviewed promptly.

**A caveat on React's "Deep" rating**: Fiber-tree traversal is delegated to [Bippy](https://github.com/aidenybai/bippy) (bundled — see `THIRD-PARTY-NOTICES.md`). React's repair guarantee assumes Bippy keeps tracking React's internals; if a future React release breaks Bippy before Bippy ships a fix, browser-whiskor's React depth degrades with it — there is no independent fallback Fiber walker. Vue 3 and the DOM-generic layer are implemented directly against stable/public APIs and don't carry this dependency.

## Architecture

```
AI Agent (Claude / Cursor / etc.)
    │ MCP stdio (JSON-RPC 2.0)
    ▼
┌─ server/mcp/ ──────────────────────────────────────────────────┐
│  MCP Layer (72 tools, configurable visibility)                 │
│                                                                │
│  mcp-server.js          ← Entry point, wires layers together   │
│  mcp/registry.js        ← Tool registration, filtering, presets│
│  mcp/transport.js       ← stdio JSON-RPC transport             │
│  mcp/tools/read*.js     ← 24 read tools (sessions, DOM, layout)│
│  mcp/tools/write.js     ← 18 write tools (click, type, type_secret — observe opt.) │
│  mcp/tools/tabs.js      ← 4 tab tools (list/switch/open/close) │
│  mcp/tools/capture*.js  ← 5 capture tools (screenshot, element,│
│                           packed SoM, thumbnail, refresh)      │
│  mcp/tools/control.js   ← 10 control tools (config, explorer, profiles)  │
│  mcp/tools/intelligence.js ← 7 intelligence tools              │
│  mcp/tools/ocr.js       ← ocr_region (pixel OCR, bring-your-own)│
│  mcp/tools/source.js    ← get_source_context + capture_sources │
│  mcp/tools/replay.js    ← replay_session                       │
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
│  screenshot-manager.js ← Screenshots + element crops + packed SoM │
│  secret-guard.js       ← Server-side secret redaction (opt-in) │
│  som-stats.js / som-cache.js / som-thumbnails.js ← packed-SoM  │
│                          usage stats, freshness cache, thumbs  │
│  source-index.js       ← Uploaded source storage + slicing     │
│  source-store.js       ← Source content persistence (hash/dedup)│
│  source-correlation.js ← Runtime ↔ source correlation          │
│  zip-writer.js / zip-reader.js ← dependency-free ZIP I/O       │
│  layout-map.js         ← Coarse ASCII spatial map renderer     │
│  config-change-log.js  ← Config audit, validation, auto-revert │
│  config-loader.js      ← config.json + .env + mcp-tools.json   │
│  delta-engine.js       ← Smart delta aggregation, motion clustering │
│  pattern-registry.js   ← UI pattern storage + lookup (ref IDs) │
│  correlator.js         ← Time-series causal-candidate chains   │
│                                                                │
│  state-store.js        ← State graph + LRU + gzip + backward compat wrapper │
│  state-fingerprint.js  ← FNV32 hash engine                     │
│  state-semantic.js     ← Labels, tags, keyState, search        │
│  state-navigator.js    ← BFS + speculative reverse edges + replay │
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
│   raw/perf/        │    │ injected/analyzers/ (15 analyzers)   │
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

See `docs/archive/v0.3.6-improvements.md` for the rationale and the dual-hash implementation note.

## Setup

### Installation

**From npm** (package name is `whiskor`):

```bash
npm install -g whiskor
whk setup           # copies the bundled extension into ~/.whiskor and starts the server
whk where           # shows the managed extension path to load in the browser
```

Then load the extension once (see the browser steps below) from `~/.whiskor/extension`
(Chrome) or `~/.whiskor/firefox-mv2` (Firefox). Future `whk setup` runs update those
files in place and ask the browser to reload them — no re-install.

**From a git clone:**

```bash
cd browser-whiskor
npm install

# Option A — npm start (manual extension load from extension/ in the repo)
npm start          # supervised (auto-restart); raw worker: npm run start:raw

# Option B — whk CLI (recommended: manages extension + server together)
.\scripts\setup.ps1     # first time: registers `whk` on PATH (npm link) → whk setup
whk                     # after that: refresh extension files → restart server
whk shell               # interactive TUI shell (type to search, arrows, Enter to run)
```

> **Note on Machine Learning Models:** 
> On first startup, the server will automatically download the ONNX model (~50MB) for Semantic Search from Hugging Face Hub (`intelligence.miniLM.downloadOnStart`, on by default). This is a one-time download and takes 30-60 seconds depending on your connection. **No Hugging Face account or login is required.** The model is cached in `.model-cache/`.
> 
> If the automatic download fails, you can manually run: `npm run download-model`

### Chrome/Edge (MV3)
1. `chrome://extensions` → Developer mode ON
2. "Load unpacked" → select `extension/` folder

### Firefox (MV2)
1. `about:debugging` → This Firefox → Load Temporary Add-on
2. Select `firefox-mv2/manifest.json`

## MCP Configuration (Claude Desktop)

With the npm global install (`whiskor` is on PATH):

```json
{
  "mcpServers": {
    "browser-whiskor": {
      "command": "whiskor",
      "args": ["mcp"]
    }
  }
}
```

From a git clone:

```json
{
  "mcpServers": {
    "browser-whiskor": {
      "command": "node",
      "args": ["/path/to/browser-whiskor/server/index.js", "--mcp"]
    }
  }
}
```

### Dynamic vs Static Tool Exposure

By default the MCP toolset is **dynamic**: only the `core` profile (plus 5 meta tools) is visible, and other profiles load/unload on demand. The server declares the `tools.listChanged` capability and sends `notifications/tools/list_changed` whenever a call changes the visible toolset, so spec-compliant clients stay in sync.

For MCP clients that fetch `tools/list` once and ignore change notifications, enable **static tools mode** — every profile is permanently visible and nothing loads or unloads:

```jsonc
// config.json
"mcpServer": { "staticTools": true }
// or: node server/index.js --mcp --static-tools
// or: WHISKOR_MCPSERVER_STATICTOOLS=true
```

Static mode widens *visibility*, never *permissions*: security gates (`security.allowExecuteJs`, `agentControl.allowAgentConfig`) and the per-tool `enabled` flags in `server/configs/mcp-tools.json` still apply, so anything you switched off stays hidden.

### Proxy Mode (Coexistence with Standalone Server)

If you manually start a standalone Whiskor server (e.g., `node server/index.js` to view the dashboard and manage browser extension connections) and then launch an editor or client that spawns browser-whiskor via MCP, a port conflict (`EADDRINUSE`) would normally occur.

To prevent this, browser-whiskor automatically detects if another instance is already running on port `7892`. If detected, the MCP process automatically switches to **Proxy Mode**:
- It bypasses WebSocket/HTTP port binding (preventing socket conflicts).
- It transparently proxies all tool actions, screenshots, data collection, and semantic embeddings to the running standalone server.

This allows seamless coexistence of a global browser instrumentation dashboard and local editor-based AI agents.

### Crash Resilience (Auto-Restart)

The server occasionally crashes under load. **`npm start` (and `start.ps1`) run under the supervisor by default**, so it comes back on its own — no separate command to remember:

```bash
npm start                  # supervised (auto-restart) — node scripts/supervisor.js
npm run start:raw          # raw worker, no auto-restart (start.ps1 -NoSupervisor)
```

The same two-process split that powers Proxy Mode is what makes the restart clean. The **worker** (the heavy process that owns WS:7891 + HTTP:7892 + cache + embeddings) is what crashes; the **MCP proxy** the agent talks to is a separate, long-lived process. So a worker crash never reaches the agent:

- **Auto-restart** — `scripts/supervisor.js` runs the worker as a child and restarts it on an *unclean* exit (a clean signal exit returns 0 and is not restarted). Backoff + a crash-loop guard (gives up after 5 crashes in 60s).
- **No corrupted cache** — `cache-writer` writes atomically (temp file → rename), so a crash mid-write leaves the old file intact instead of a half-written JSON. The startup integrity check repairs dangling refs and sweeps orphaned temp files.
- **Clean handoff** — on crash/exit the worker flushes in-memory network/console buffers synchronously before exiting non-zero.
- **No lost instructions during the restart** — the proxy retries connection-level failures (`resilience.proxyRetry`, default up to 15s) while the worker restarts, so a tool call that arrives mid-restart just waits a beat and still returns a real result. Only *connection* failures are retried — a refused connection never reached the worker, so re-sending cannot double-execute an action; HTTP error responses (the worker handled it) are returned as-is.

This covers the common case — the *worker* falling over. The MCP proxy process itself is owned by the agent (Claude/Cursor) and is a thin HTTP forwarder, so it rarely crashes. Start the server (`npm start`) before the agent so the agent's `--mcp` process attaches in Proxy Mode. (The `--mcp` process is intentionally *not* supervised — its lifecycle belongs to the agent.)

### Instance Identity

When you run **several whiskor servers** (e.g. a per-project instance on a different port), a descriptive `identity` lets a client/agent — or a human reading logs — tell them apart. It's surfaced on `GET /health` (`identity: {instanceId, name}`) and MCP `serverInfo` (`instanceId`/`instanceName`).

It's a **label, not security** (local loopback needs no encryption; use `appIsolation` tokens for LAN exposure). A single default instance needs no setup: `instanceId` auto-derives to `whiskor-<hostname>-<httpPort>` when unset — unique per host:port, so no shared-default collision. Override in `config.json` → `identity`, or via `WHISKOR_IDENTITY_INSTANCEID` / `WHISKOR_IDENTITY_NAME`.

---

## Explorer

The autonomous exploration engine (`explorer.js`) uses a unified composite hash for state identification, fuzzy element matching, loop detection, and depth limiting. Current status:

- **Unified hashing:** React state (when available) + DOM signature ensures accurate state deduplication across SPA navigations
- **Element matching:** Token overlap + character bigram similarity for fuzzy text matching
- **Loop detection:** Revisits the same state hash N times → backtracks
- **Depth limiting:** Configurable max depth (default: 20)
- **State graph:** All transitions recorded with confidence scores based on observation count and recency

**What it does:** Builds a navigable state graph of the application. The graph can be queried and traversed by agents using `navigate_to_state`. (Since v0.15, normal browsing also records states passively — the explorer is the denser variant of the same write path.)

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

## MCP Tools (72 tools)

### Dynamic Tool Profiles

Instead of exposing all 72 tools at once, browser-whiskor uses **dynamic profiles** to keep AI context lean:

| Profile | Tools | Auto-Trigger | Idle Unload |
|---------|-------|-------------|-------------|
| **core** (18) | get_sessions, search_all_tabs, get_index, get_text_coords, get_viewport, get_layout_map, get_framework_state, get_ui_catalog, get_network, find_target, refresh_data, capture_screenshot, capture_element_screenshot, capture_packed_som, get_element_thumbnail, click, type_text, navigate_to | Always loaded | Never |
| **debug** (+6) | get_console_logs, get_storage, get_perf_metrics, get_css_analysis, get_dom_snapshot, get_accessibility | "console", "debug", "error" | 10 turns |
| **state-nav** (+9) | get_state_map, list_states, search_states, get_state_detail, pin_state, navigate_to_state, get_navigation_path, get_state_map_visual, replay_session | "state", "graph", "navigate", "replay" | 8 turns |
| **delta** (+3) | get_delta, list_patterns, lookup_pattern | "delta", "change", "scroll" | 6 turns |
| **advanced-actions** (+13) | drag, hover, unhover, select_option, check_box, mouse_scroll, right_click, press_key, type_secret, go_back, go_forward, reload_page, scroll_page | "drag", "hover", "select" | 5 turns |
| **tabs** (+4) | list_tabs, switch_tab, open_tab, close_tab | "switch tab", "new tab", "popup", "redirect" | 6 turns |
| **intelligence** (+8) | explain_element, why_did_this_change, get_source_file, detect_site_updates, get_source_context, capture_sources, ocr_region, get_canvas_map | "explain", "why", "source", "cause", "ocr", "canvas" | 5 turns |
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
| `search_all_tabs` | Cross-session text search (exact, fuzzy, or semantic) |
| `get_index` | Session file listing with summaries |
| `get_text_coords` | Text + absolute coordinates with fuzzy search and similarity scoring |
| `ocr_region` | Read text from **pixels** via a native OCR engine (Tesseract, bring-your-own) — for canvas/WebGL apps (Unity, games, charts) where the DOM is one `<canvas>`, or icon-only controls with no text node. Whole-tab or a cropped selector/rect; output matches `get_text_coords` (Tesseract-compatible word boxes). Returns `ocr_unavailable` with setup steps if no binary is installed |
| `find_target` | Resolve a description ("search box", "送信") to ranked click candidates — combines UI catalog + text-coords, fuzzy-ranks (MiniLM when available), returns click coordinates, selector hint and clickability |
| `get_viewport` | Current viewport size and scroll position |
| `get_framework_state` | Component tree + state for detected framework |
| `get_network` | Captured HTTP requests/responses |
| `get_ui_catalog` | Buttons, links, forms listing. Action buttons carry `relatedInputs` (+ a `relatedInputsTip`) when the button likely depends on a field being filled first — each related input lists `selector/label/required/empty` and a `confidence`/`basis` (form/aria = high, same-container = low) |
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
| `navigate_to_state` | Navigate to a target state by replaying recorded actions. BFS over recorded edges plus speculative reverse candidates (go_back / Escape / close-labels — verified per step, persisted only on success). `mode: strict\|auto\|fuzzy` controls target tolerance; results report `matched: "exact"\|"fuzzy"` and mark the URL fallback as `fallback:"url"` (it resets SPA state) |
| `get_navigation_path` | Dry-run: check if a path exists without executing actions (speculative steps are marked as such) |

### Action (WRITE)

> These work but are not the focus of this project. For serious browser automation, use Playwright/Puppeteer alongside browser-whiskor.

> **`observe` option:** `click`, `type_text`, `press_key`, `hover`, `scroll_page`, `mouse_scroll`, `drag`, `select_option`, `check_box`, and `right_click` accept `observe: true` (plus optional `observeTimeoutMs`, default 3000). After the action, the server watches the page state hash until it settles and returns `_observation: { available, fromHash, toHash, hashChanged, settled, reads, mode, elapsedMs }` — letting you check whether the action changed the UI state without a separate `refresh_data` round-trip. The settle loop uses **adaptive polling** (fast first reads to catch brief SPA transitions, then back-off) plus a **quiescent window** so a fast A→B→A flip doesn't settle early; tune via `config.json` → `observe`, or set `adaptive: false` for fixed-interval legacy behaviour. Requires the page to report a composite state hash (state graph / explorer active); otherwise `_observation.available` is `false` and the action still runs normally.

| Tool | Description |
|------|-------------|
| `navigate_to` | Navigate to URL (+ `waitUntil`, `thenCollect`, `timeoutMs` for waiting on page lifecycle and triggering post-navigate collection) |
| `click` | Click by selector, text, or coordinates. A click that starts a file download reports `downloadsStarted` + diagnosis `download_started` (success — a download changes no page state) |
| `right_click` | Right-click (context menu) by selector, text, or coordinates |
| `type_text` | Text input (React synthetic-event aware; physical `code`/`keyCode` + CJK/IME composition; trusted via CDP when high-fidelity input is enabled) |
| `type_secret` | Type a registered secret by **ref name only** — the agent never sees the value; the worker resolves it from `secrets.local.json` and injects it directly (see Secret Guard) |
| `press_key` | Keyboard shortcuts — to the focused element, or to a specific one via `selector`/`text` (focused first; trusted via CDP when high-fidelity input is enabled) |
| `hover` | Hover (dropdowns, tooltips) |
| `unhover` | Clear a hover state (move the pointer away, close hover-opened UI) |
| `scroll_page` | Scroll to position or element; returns the target's own before/after positions, `moved`, and `atBoundary` (a `{0,0}` move at a boundary is the edge, not a failure) |
| `mouse_scroll` | Fire wheel event at specific coordinates; reports what actually moved (`scrolled`, `via`) and falls back to scrolling the container directly when no wheel handler reacts |
| `drag` | Drag from coordinates/selector to coordinates |
| `select_option` | `<select>` value |
| `check_box` | Checkbox toggle |
| `execute_js` | Arbitrary JavaScript |
| `wait_for_element` | Wait for element |
| `go_back` / `go_forward` | Browser history |
| `reload_page` | Reload |

> **Input fidelity:** `click`, `type_text`, and `press_key` default to **synthetic DOM events** (zero-permission, no banner, identical on Chrome/Firefox). Synthetic keys now carry physical-keyboard fields (`code`/`keyCode`/`which`) and emit IME **composition** events for CJK/rich-text editors. For widgets that require *trusted* events or a user gesture (popups, clipboard, file pickers, some payment/OAuth flows), enable **High-Fidelity Input (CDP)** — see below.

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
| `why_did_this_change` | Candidate causal chains for a recent DOM change, correlated from preceding network responses and framework transitions. Each chain carries an `evidence` object explaining its confidence — chains are ranked hypotheses, not proven causes |
| `analyze_click` | Analyze a click target's React/Vue event handlers before clicking; also reports `relatedInputs` / `relatedInputsTip` — input fields the action likely depends on (so you fill them first instead of hitting a validation alert) |
| `get_source_file` | Retrieve source file content by URL or hash |
| `detect_site_updates` | Cross-session: detect which CSS/JS files have changed |
| `get_source_context` | Slice context out of user-uploaded project source: by file/line range, by symbol, or by observed component name (see Source Upload & Correlation) |
| `capture_sources` | Capture the page's JS/CSS/HTML via DevTools `getResources()` (CORS-free, bypasses page-context limits). Opt-in `includeNetwork` adds XHR/fetch response bodies from the HAR; `reload` captures the initial page load too. Requires the DevTools panel to be open on the target tab |
| `get_canvas_map` | Render what is *inside* a canvas from framework state (auto-discovers numeric x/y in stores/props, crops to the content bbox, picks grid/list form by density). For canvas/WebGL apps where the DOM is one `<canvas>` |

### Capture

| Tool | Description |
|------|-------------|
| `capture_screenshot` | Screenshot — always saved to disk (`filePath`); returns a **viewable image content block** when `returnImage=true` (default off to save tokens, configurable via `agentControl.screenshot.returnImageByDefault`). Optional numbered markers (SoM) |
| `capture_element_screenshot` | Element-level screenshot by selector or rect with padding |
| `capture_packed_som` | Crop **only the interactive elements** out of one real screenshot, shelf-pack them into a single numbered image (Set-of-Marks), and click by number — far fewer pixels/tokens than a full screenshot. Freshness-aware server cache; marks are ordered by usage statistics |
| `get_element_thumbnail` | Low-res thumbnail of a single element by selector (long-edge cap, default 96px), with a view-aware cache. A packed capture can pre-warm these (`agentControl.packedSom.prefetchThumbs`) |
| `refresh_data` | Trigger data collection + wait for completion |

### Control

| Tool | Description |
|------|-------------|
| `set_config` | Change extension settings |
| `get_config_changes` | Review config changes made during session |
| `trigger_collect` | Manual data collection |
| `trigger_explorer` | Start/stop autonomous exploration |

### MCP Resources & Prompts

Beyond tools, the server also implements the MCP **`resources`** and **`prompts`** primitives (declared in the `initialize` capabilities and answered over the same stdio transport). They work identically in standalone and proxy mode.

**Resources** — collected sessions exposed as readable context:

| URI | Description |
|-----|-------------|
| `whiskor://sessions` | List of all instrumented tabs (tabId, title, url). Always present. |
| `whiskor://session/{tabId}` | Full collected perception data for one tab (template + dynamic listing). |

**Prompts** — canned workflows (`prompts/list` / `prompts/get`):

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `investigate_tab` | `tabId?` | Survey a tab end to end (framework state, UI catalog, text coords, network) and summarize. |
| `debug_errors` | `tabId?` | Hunt console + network errors and explain the likely cause. |
| `find_and_act` | `target`, `action?`, `value?` | Locate an element by visible text and act on it, disambiguating first. |
| `explain_change` | `description?` | Explain what changed on the page and why, via delta + correlation. |
| `map_states` | `tabId?` | Render the recorded UI state graph and describe navigation paths. |

---

## High-Fidelity Input (CDP)

Browser actions (`click`, `type_text`, `press_key`) use **synthetic DOM events** by default. These are `isTrusted: false`, so widgets gated on trusted input or user activation (popups, clipboard, file pickers, some payment/OAuth flows) may ignore them. To reach those, enable **CDP high-fidelity input**, which drives the mouse/keyboard via the Chrome DevTools Protocol (`chrome.debugger`) to produce `isTrusted: true` events.

Set in `config.json`:
```json
{ "agentControl": { "input": { "highFidelity": "fallback" } } }
```

| Mode | Behaviour |
|------|-----------|
| `off` (default) | Synthetic events only |
| `fallback` | Synthetic first; if a `click` lands but nothing changes (`no_state_change`), retry **that click** via CDP |
| `always` | Route `click` / `type_text` / `press_key` through CDP every time |

- **Chrome only.** Firefox has no `chrome.debugger`, so it ignores the setting and always uses synthetic events (parity is best-effort).
- Requires the `debugger` permission (already in the Chrome manifest).
- **Banner:** while CDP is attached, Chrome shows a "*… is debugging this browser*" notice bar. A short idle keep-alive batches operations to minimise how often it flashes.
- Any CDP failure (e.g. DevTools already open on the tab) **falls back to the synthetic path**, so the action still does its best.

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
GET  /health                          → Connection status (identity, extensions, secretGuard)
GET  /api/config                      → Current config
POST /api/config                      → Change config
GET  /api/sessions                    → Session list (?q=&sort=&page=)
GET  /api/sessions/:tabId            → Session detail (DELETE removes it)
GET  /api/search?q=<term>            → Cross-session text search (?mode=exact|fuzzy|semantic)
GET  /api/logs?limit=N               → Server log ring buffer (?level=warn)
POST /api/collect                     → Manual collection
POST /api/screenshot                  → Screenshot
POST /api/packed-som                  → Packed Set-of-Marks capture
POST /api/element-thumbnail           → Per-element thumbnail
GET  /api/ocr                         → OCR engine availability
POST /api/ocr                         → Read text from pixels (canvas/WebGL); bring-your-own Tesseract
POST /api/source/capture              → Capture page sources via DevTools (panel must be open)
POST /api/source/upload               → Upload project source (files or base64 zip)
POST /api/source/context              → Query uploaded source slices
GET  /api/sources/:tabId             → List captured source files
GET  /api/sources/:tabId/zip         → Download captured sources as a folder ZIP
POST /api/action                      → Execute action (+ MCP tool name aliases)
POST /api/embed                       → Text embedding (MiniLM)
GET  /api/graphs                      → State graph listing
GET  /api/sessions/:tabId/states     → State nodes seen by a session
GET  /api/sessions/:tabId/map        → ASCII state-graph visualization
POST /api/extension/reload            → Ask connected extension(s) to self-reload
POST /api/shutdown                    → Graceful stop (flushes → exit 0)
GET  /api/uninstrumented-tabs        → Tabs without whiskor sessions
GET  /export                          → Download session cache as ZIP (?tabId= to scope)
GET  /                                → Dashboard
```

All endpoints on `http://localhost:7892`.

Full request/response details: `docs/http-api-reference.md`.

**Agent skill (MCP-free path):** `skills/browser-whiskor-http/` ships a ready-to-use skill that teaches an AI agent the perceive→act workflow over this HTTP API alone. Copy the folder into your agent's skill directory (e.g. `~/.claude/skills/` or a project's `.claude/skills/`) — see `skills/README.md`. Driving the browser over plain HTTP from a CLI agent is often more token-efficient than MCP, since no tool schemas occupy the context window.

> **PowerShell / Windows note:** When using the HTTP API from PowerShell, be aware that `curl` is an alias for `Invoke-WebRequest` and backslash escaping in double-quoted strings works differently than bash. Use single quotes for the JSON body, or use `Invoke-RestMethod` instead:
> ```powershell
> # ✓ Works
> Invoke-RestMethod -Uri http://localhost:7892/api/action -Method Post -ContentType application/json -Body '{"tabId":1234,"action":{"type":"navigate","url":"https://example.com"}}'
> # ✗ May fail — \" inside "..." is not an escape in PowerShell
> curl -d "{\"tabId\":1234,...}"
> ```

## Dependencies

**Server (2 runtime dependencies):**
- **`ws`** (^8.18.0) — WebSocket server for browser extension communication
- **`@xenova/transformers`** (^2.0.0) — ONNX-based semantic search pipeline (MiniLM model). Handles model loading, tokenization, inference, and HuggingFace Hub caching. Runs entirely locally in a dedicated worker thread — no external API calls or authentication

**Dev only:**
- **`@playwright/test`** (^1.60.0) — E2E testing (`npm run test:e2e`); not required for runtime

**Extension side:** Zero-dependency vanilla JS. React Fiber traversal uses the bundled [bippy](https://github.com/aidenybai/bippy) library.

Full license texts in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

> **Note:** The semantic search feature uses a local ONNX model (~50MB), downloaded automatically on first server start (`intelligence.miniLM.downloadOnStart`) or manually via `npm run download-model`. No external API calls or authentication required. Model is cached in `.model-cache/`.

## Agent Config Control

Agents can modify server settings via `set_config`, but this is **disabled by default** for safety.

### Enabling agent config control

Configuration is layered: `config.json` (committed defaults) → `config.local.json` (git-ignored personal overrides, deep-merged) → `.env` / `WHISKOR_*` env vars. Personal settings (e.g. `security.allowExecuteJs: true`) go in `config.local.json` so the committed defaults stay clean.

Set in `config.json` (or `config.local.json`):
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

Response includes (the image itself is returned as a viewable image content block when `returnImage=true`; the JSON carries `filePath` + the elements map):
```json
{
  "ok": true,
  "filePath": "cache/screenshots/1234-1716000000000.jpg",
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

## Packed Set-of-Marks (`capture_packed_som`)

A full screenshot spends most of its pixels (and the agent's tokens) on whitespace. `capture_packed_som` crops **only the interactive elements** out of one real `captureVisibleTab` bitmap, shelf-packs the crops into a single compact image, and numbers them — the agent clicks by mark number, same as regular SoM, at a fraction of the size.

- **Server-side cache**, invalidated by page-change signals (navigation, DOM mutations), so repeat calls on an unchanged page are instant (`_cached: true`).
- **Usage statistics** (`som-stats.js`, time-decayed) reorder the marks list by click likelihood; image numbering stays stable.
- **Per-element thumbnails**: `get_element_thumbnail({selector, maxPx})` crops + downscales a single element in the extension canvas, with its own view-aware cache. A packed capture can pre-warm this cache from the same bitmap (`agentControl.packedSom.prefetchThumbs`) — zero extra captures.
- **Prefetch on navigation** (`agentControl.packedSom.prefetchOnNavigate`, default off): capture shortly after each navigation so the agent's first call returns instantly.

## Secret Guard (opt-in redaction)

Threat model: *you don't necessarily trust the agent.* Secret Guard hides user secrets (passwords, emails, tokens) from the agent, logs, cache, and dashboard. Detection and replacement happen **server-side only** — secret values are never sent into the page, so XSS or a malicious site cannot steal the redaction list.

- **Known values**: secrets registered in `secrets.local.json` (git-ignored) or `WHISKOR_SECRETS` are replaced with `[WHISKOR_REDACTED type=.. hint=.. reason=..]` tokens at a single choke point before anything is cached, broadcast, or returned.
- **Patterns**: email, credit card (Luhn), JWT by default when enabled; ssn / ipv4 / phone are individually opt-in (`privacy.secretGuard.patterns`) because they false-positive easily. Key-name based redaction (`password`, `api_key`, …) catches unregistered values.
- **`type_secret`**: the agent sends only a **ref name**; the worker resolves the real value and types it into the page. The value never appears in tool results, logs, or cache.
- **Screenshot masking**: redacted text rectangles are blacked out on the extension canvas after capture (no page overlay, no flicker).
- **Observability**: `GET /health` reports counts only; MCP `serverInfo` advertises active redaction so the agent knows to expect tokens and use `type_secret`.

Enable with `privacy.secretGuard.enabled: true` (default off). See `secrets.local.json.example` and `docs/ideas/REDACTION_SECRET_GUARD.md`.

**Always-on baseline (separate from Secret Guard):** credential-bearing HTTP
header *values* — `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, and
kin — are redacted to `[redacted len=N]` at **collection time**, before
anything is written to the cache, shown on the dashboard, included in
`/export`, or returned to an agent. This is name-based (works for every site,
nothing to keep in sync), on by default (`network.redactAuthHeaders`), and
guarded as a committed public default. Turn it off only when you are debugging
an API and need the raw header. It does not cover request/response *bodies* or
form values — that is Secret Guard's job (opt-in, above).

## Source Upload & Correlation

Upload the target site's source (frontend, backend, or any slice of it) and whiskor correlates it with runtime observation, so the agent can pull **just the relevant source lines** instead of the whole project:

1. **Upload**: `POST /api/source/upload` with files or a base64 zip (dependency-free zip reader; node_modules/binaries excluded, size-capped), or the dashboard's SOURCE UPLOAD card.
2. **Correlate**: component names from `get_framework_state` resolve to source files — dev builds via React `_debugSource` (exact file/line), otherwise by symbol-name match with a confidence tier. Observed `FRAMEWORK_DOM_MAP` data records correlations passively as you browse.
3. **Query**: `get_source_context({component})` / `({file, line})` / `({symbol})` returns a bounded excerpt (line range, symbol surroundings, or capped full text).

See `docs/ideas/SOURCE_UPLOAD_CORRELATION.md` for the design notes.

## DevTools Source Capture (`capture_sources`)

A separate path from the upload API: `capture_sources` reads the page's resources directly from the browser's DevTools cache, so it captures cross-origin CDN bundles (a SPA's `main.*.js`) that the page-context `fetch()` cannot reach. Requires the browser-whiskor DevTools panel to be open on the target tab.

- **Layer 1** (default): `chrome.devtools.inspectedWindow.getResources()` — JS, CSS, HTML, JSON from the browser cache. Deduplicates by content hash against the page-context source-fetcher.
- **Layer 2** (`includeNetwork: true`): also captures XHR/fetch response bodies from the DevTools network HAR — the API JSON that `getResources()` never sees. With `reload: true`, reloads the page first so the initial load's requests are captured too (**destroys current page state** — opt in deliberately).
- Stored files land in the tab's source cache. Download via `GET /api/sources/:tabId/zip` (folder-structured ZIP) or the dashboard export.

```json
{ "name": "capture_sources", "arguments": { "tabId": 1234, "includeNetwork": true } }
```

## CLI (`whk`)

The `whk` command manages the extension and server together. First-time setup: `.\scripts\setup.ps1` registers `whk` globally via `npm link`, then copies the extension into `~/.whiskor/` and starts the server. After that, `whk` (bare) refreshes extension files, asks the browser to reload, and restarts the server.

```bash
whk                  # = whk restart: refresh extension → reload → restart server
whk setup            # first-time install or update the managed extension, then start
whk stop             # graceful shutdown (POST /api/shutdown)
whk shell            # full-screen interactive TUI (type to search, arrows, Enter)
whk shell --classic  # original inline prompt (no alt-screen)
whk GET /health      # direct HTTP client
whk help api         # detailed endpoint reference
whk skills           # list bundled agent skills
```

### TUI shell (`whk shell`)

A zero-dependency full-screen shell: scrollable output, incremental-search popup with folder navigation (`action/`, `capture/`, `session/`, …), live completion of tabIds and siteVersions, and a real line editor.

- **`→`** on a command opens field-edit: each JSON value (strings, numbers) is prefilled and editable. `Ctrl+↑/↓` = ±1, `Alt+↑/↓` = ±10 for numeric fields (quick scroll tuning).
- **`!<command>`** runs in your local shell (`pwsh` / `$SHELL`), output below. Local-only, never exposed over HTTP/MCP.
- **`logs [n]`** pulls server logs, **`map [tabId]`** shows an ASCII state graph, **`export [path]`** saves the transcript.

## Testing & Quality

876 automated tests run via `npm test` (841 unit, 30 integration, 5 stress), plus Playwright E2E specs (`npm run test:e2e`) that drive a real browser with the extension loaded.

| Category | Count | Scope |
|----------|-------|-------|
| **Unit** | 841 | Server logic, WS messaging, MCP tools, state hashing / ND filter, observe settle, secret guard, packed SoM, correlator, TUI field-edit, shell escape, layout map, session search/list, source capture, passive state recording, speculative reverse edges |
| **Integration** | 30 | Server ↔ Client flows, error recovery, multi-tab, source correlation, shutdown |
| **Stress** | 5 | Large payloads (5000+ words), long sessions |
| **E2E (Playwright)** | spec files | Real-browser: injected collection, executor round-trip, packed SoM, secret masking, dashboard |

Two structural guards back these numbers:
- **Hollow-test guard** (`scripts/_check-hollow-tests.js`, in CI and `validate.ps1`): a unit test that never imports production code fails the build — tests must exercise the real modules.
- **Producer/consumer contract test** (`tests/unit/injected-server-contract.test.js`): statically cross-checks every injected `emit` type against a server consumer, so adding a page-side producer without wiring the server fails immediately instead of silently dropping data.

> **Note:** The Playwright E2E specs require a live environment (headed browser + extension) and are not part of `npm test`.

**Pre-push validation:** Run `.\scripts\validate.ps1` to check YAML syntax, shared/ sync status, version consistency, file structure, and test integrity before committing.

## License

MIT
