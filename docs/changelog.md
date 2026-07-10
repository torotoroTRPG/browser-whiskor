# Changelog (frozen at v0.11.0)

> This file is a historical archive. Entries from **v0.12.0 onward live in
> [/CHANGELOG.md](../CHANGELOG.md)** at the repository root — the single
> source the release workflow reads.

All notable changes to browser-whiskor.

> **Note on Versioning:** The versioning scheme was changed during development. The project transitioned from `3.x.x` (internal/development versioning) to `0.3.x` to prepare for the initial open-source release (OSS), reflecting its pre-1.0 status.

## [0.11.0] — 2026-07-02

### Added

- **Startup update check + notification** — on normal (non-MCP) startup the server fetches the published version from `docs/version.json` (served by GitHub Pages at `main:/docs`, kept in sync with `package.json` by `npm version`) and compares it with this build. A newer release surfaces in the log, `GET /health` `update`, and a dashboard banner. `updateCheck.osToast` (on by default) also fires a desktop notification via the bundled cross-platform `scripts/_notify.js`. This is a version **check only** — it never downloads or runs code. Opt-in `autoSetup` re-syncs the local bundled extension via `whk setup` on detection. Config: `updateCheck` (`enabled`/`url`/`osToast`/`notifyCommand`/`autoSetup`). A future download-and-swap updater is scoped in `docs/ideas/SELF_UPDATE.md` (`selfUpdate` seam, currently inert).
- **`press_key` element targeting** — `press_key` accepts `selector`/`text` (same resolution as `click`) and focuses the element before dispatching, instead of only hitting whatever happens to be focused.
- **Download detection on `click`** — a click that starts a file download now reports `downloadsStarted` (url/filename/state) and the diagnosis reads `download_started` instead of the misleading `no_state_change` (a download changes no page state — it is still a success). Requires the new `downloads` permission. The CDP fallback path no longer re-clicks (which would download twice).
- **`whk where`** — a new CLI command that prints the resolved, real paths (this CLI's entry + package root, the managed extension dir with each staged browser's version) and the live server (`/health` identity, version, connected extensions, sessions), including a warning when a different install is serving the port. No path is exposed over HTTP/MCP.

### Changed

- **Truthful scroll return values** — `scroll_page` now returns the *target's own* before/after position, `moved`, and `atBoundary` flags (previously it returned the window position even when scrolling an inner container, so a moved container looked stationary and a boundary was indistinguishable from success). `mouse_scroll` reports what actually moved (`scrolled`, `via`) and falls back to scrolling the nearest scrollable container directly when no wheel handler reacts, instead of always reporting success for an untrusted synthetic wheel.
- **Session cleanup on tab close** — the extension's `TAB_CLOSED` signal is now consumed server-side: the session is marked `closed` (surfaced in `get_sessions`) and swept after a short retention window, and its capture caches are evicted immediately. Fixed a latent bug where a session with a missing timestamp compared against `NaN` and was never evicted.
- **bippy** updated 0.5.40 → 0.5.42 (version label follow-through; code unchanged upstream).

### Fixed

- **React textarea `onChange` not firing** — `type_text` / `clear_input` / `select_option` selected the value setter from `HTMLInputElement.prototype` unconditionally, which threw on a `<textarea>` and fell back to a plain `el.value =` write that React's value tracker swallowed, so `onChange` never fired (text appeared to type while component state stayed empty). The setter is now chosen from the element's own interface.
- **Japanese mojibake via `mcp-client.js`** — the non-interactive MCP CLI now switches the Windows console to UTF-8 automatically on a TTY, so `chcp 65001` is no longer needed for it (data was always UTF-8; only the legacy console rendering was broken).

### Security

- **postMessage relay hardening** — the ISOLATED-world bridges now drop SW/panel-origin control types (`EXT_HELLO`, `TAB_INVENTORY`, `TAB_CLOSED`, `*_RESULT`, …) and malformed types on the page→SW path, so a page can't impersonate SW-level messages to the server, and the Chrome bridge no longer spreads `event.data.payload` onto the message envelope (parity with Firefox). The trust boundary is documented: MAIN-world collectors share the page's JS context, so postMessage cannot cryptographically authenticate the sender — but no command/debugger path is reachable via this channel (those are on the separate WebSocket channel), so impact is bounded to observation data.
- **Fail-closed origin default** — the code-side fallback for `security.allowedMcpOrigins` changed from `['*']` (allow all) to `['localhost', '127.0.0.1']`, matching the shipped `config.json`. A minimal config that omits the `security` block no longer falls open to all origins; `'*'` must be an explicit opt-in.

## [0.10.1] — 2026-06-26

### Added

- **Source-recovery hint on minified builds** — `get_framework_state` now detects a production/minified build (React `buildType`, or a minified-name ratio heuristic for other frameworks) and appends a `MINIFIED_BUILD` warning. The hint points agents to `capture_sources` (HTTP: `POST /api/source/capture`) + `get_source_context` so they recover real component names, file paths, and line numbers instead of concluding they're unobtainable. Surfaces in the same response shape over MCP, HTTP, and whk.

### Docs

- **GitHub Pages site polish** — reverted to vivid blue heading tones, removed the internal LobeHub quality plan from the public docs.

## [0.10.0] — 2026-06-25

### Added

- **MCP `resources` and `prompts` primitives** — the server now declares and implements the MCP `resources` and `prompts` capabilities. Resources expose collected sessions as readable context (`whiskor://sessions`, `whiskor://session/{tabId}`). Prompts provide canned workflow templates (`investigate_tab`, `debug_errors`, `find_and_act`, `explain_change`, `map_states`). Both work identically in standalone and proxy mode.
- **`get_layout_map` — coarse ASCII spatial map** — a new core-profile tool that renders the page's interactive elements as a compact ASCII layout map with kind-shaped references (`[n]` links, `{n}` buttons, `<n>` inputs) and a legend. Useful for spatial reasoning without a screenshot.
- **`config.local.json` layer** — git-ignored personal config that deep-merges over `config.json`. Personal settings (e.g. `security.allowExecuteJs: true`) stay out of the committed defaults. CI guard (`scripts/_check-config-defaults.js`) catches accidental leaks.
- **Shared text-target ranking (`text-rank.js`)** — `click(text:)` and `find_target` now share a UMD ranking library that scores candidates by kind priority (link/button > input/label > text), viewport visibility, accessible name, and reachability. Consistent ranking across browser and server.
- **Action namespace bridge for HTTP** — `POST /api/action` accepts MCP tool names as aliases (`type_text` → `type`, `navigate_to` → `navigate`), returns `didYouMean` for typos, and redirects read-tool names to the correct surface instead of a dead-end error.
- **`navigate_to` lifecycle waiting** — `navigate_to` gains `waitUntil` (`load`/`domcontentloaded`/`networkidle`), `thenCollect` (trigger collection after navigation), and `timeoutMs`. The extension's background layer waits for the specified lifecycle event before resolving.
- **DevTools source capture (`capture_sources`)** — agent-triggered capture of page resources via `chrome.devtools.inspectedWindow.getResources()`, bypassing CORS limits that block the page-context source fetcher. Cross-origin CDN bundles (a SPA's `main.*.js`) are now retrievable. Requires the DevTools panel to be open on the target tab.
- **Network/XHR body capture (Layer 2)** — `capture_sources` gains `includeNetwork` (default off) to also capture XHR/fetch response bodies from the DevTools HAR — the API JSON that `getResources()` never sees. With `reload: true`, reloads the page first so initial-load requests are captured too. Feature-detected; capped at 200 files and 10MB per file.
- **Source listing and ZIP export** — `GET /api/sources/:tabId` lists captured source files; `GET /api/sources/:tabId/zip` downloads them as a folder-structured ZIP. Per-session manifest (`raw/sources/files.json`) tracks all stored files. Binary assets stored as raw bytes when `includeBinary` is set.
- **TUI field-edit prefills existing values** — `→` on any command with JSON values (not just empty placeholders) opens the field-edit overlay with current values prefilled and editable. Structural keys (`type`, `tabId`) are skipped.
- **TUI numeric field stepping** — in field-edit mode, `Ctrl+↑/↓` = ±1, `Alt+↑/↓` = ±10 on numeric fields (quick scroll/delta tuning, can cross zero).
- **TUI catalog backfill** — 10 entries added: source capture/list/zip, cross-session search, text-coords/ui-catalog raw snapshots, switch/open/close_tab actions.
- **TUI `!` escape hatch** — a line starting with `!` runs in the user's local shell (`pwsh` → `powershell` → `cmd` on Windows, `$SHELL` on POSIX). Non-interactive, 30s timeout. Never exposed over HTTP/MCP. Both full-screen TUI and classic shell.
- **Dashboard keyboard tab navigation** — ←/→, Home/End, Enter/Space, and number keys 1-9 navigate between dashboard tabs. ARIA tablist with roving tabindex and focus-visible styling.

### Fixed

- **Dashboard tab hover flicker** — `.tab` used `transition: all` which could animate layout properties; now restricted to `color` + `box-shadow` only, making hover/focus layout-immobile.
- **Config propagation to MAIN world** — `source-fetcher` and `css-origin` read a dead `__SI_CONFIG__`; SW now pushes config on fresh page load.
- **`source-fetcher` honors `maxJsSizeBytes`** — was a dead config key; now actually caps JS file capture size.

### Security

- **`ws` 8.20.1 → 8.21.0** — fixes a High-severity DoS vulnerability (npm audit).

### Docs

- **README/CLAUDE.md/CLI help synced** — tool count 69→70, test count 406→628, HTTP API table expanded with 11 undocumented endpoints, CLI/TUI section added, DevTools Source Capture section added, config.local.json layering documented.
- **THIRD-PARTY-NOTICES** — added `@xenova/transformers` (Apache-2.0).
- **`setup.ps1`** — clarified that `npm link` does not modify PATH or environment variables.

## [0.9.0] — 2026-06-20

### Added

- **Native OCR — read text from pixels (`ocr_region` tool + `POST /api/ocr`)** — complements the DOM-based `get_text_coords` for text that lives only in pixels: canvas/WebGL apps (Unity, games, charts) where the DOM is one `<canvas>`, and icon-only controls with no text node. Whole-tab, or a cropped `selector`/`rect`. Output matches `get_text_coords` (Tesseract-compatible word boxes with `level/page_num/.../left/top/width/height/conf` + `x/y/w/h`). The OCR engine is **bring-your-own** — no heavy npm dependency is bundled — resolved as `intelligence.ocr.binPath` → env `WHISKOR_OCR_PATH` → `tesseract` on PATH; when none is found the tool returns `ocr_unavailable` with setup steps instead of failing. Worker-side capture+recognize (`server/services/ocr-service.js` + `index.js` `ocrCapture`) so it behaves identically over MCP stdio, HTTP, and the proxy forward. Surfaced across the `intelligence` profile (auto-loads on `ocr`/`canvas`), `whk help api`, the `whk shell` capture menu, and the HTTP skill. `GET /api/ocr` reports engine availability.
- **Optional OCR-engine install offer in the start scripts** — when no OCR engine is found, `start.ps1` / `start.bat` / `start.sh` offer to install Tesseract (global via winget/apt/brew, or manual/local how-to) on first interactive start. Skip with `-NoOcrPrompt` / `WHISKOR_OCR_NO_PROMPT=1`; dismissed once chosen (`cache/.ocr-offer-dismissed`). Never blocks startup.
- **Uninstrumented browser tabs surfaced in `get_sessions`** — tabs the browser has but whiskor has no session for (`restricted` / `reload_needed`) are reported via `GET /api/uninstrumented-tabs` and as an `UNINSTRUMENTED_TABS` warning, so an agent notices pages it cannot yet perceive.
- **WebP output for element screenshots and thumbnails** — `capture_element_screenshot` and `get_element_thumbnail` accept `format:'webp'` (usually smallest at similar quality).
- **Searchable / sortable / pageable session list + cross-tab text search** — `get_sessions` and `GET /api/sessions` gain `q` / `mode` (exact|fuzzy|semantic) / `sort` / `page` / `pageSize` (shared `server/session-list.js`). New `search_all_tabs` MCP tool and `GET /api/search` find a term across every active session at once (shared `server/session-search.js`).
- **Form-value capture** — opt-in `textCoords.includeFormValues` adds input/textarea/contentEditable values (with coordinates) to text-coords; sensitive fields (password/hidden/payment) are omitted and remaining values run through secret-guard. Agents cannot enable it (user-owned setting).
- **HTTP screenshot parity + image-serving route** — `POST /api/screenshot` now honors `format`/`quality`/`maxWidth` like the MCP tool, and `GET /api/screenshots/:file` serves saved images by name so consumers can avoid inlining base64.
- **`httpInlineImage` switch** — `agentControl.screenshot.httpInlineImage` (default true) lets the HTTP screenshot default to text-first (url/filePath only); non-breaking.

### Fixed

- **Bounded screenshot/session disk usage** — `cache/screenshots` is pruned by age/size (`agentControl.screenshot.maxDiskMB`/`maxAgeHours`) and the packed-SoM cache eviction is wired, so a long session can't grow the cache without bound.
- **Click prefers the focused/visible element on ambiguous selectors** — when a `selector` matches multiple elements, `click`/`type`/`right_click` pick the first visible one and report `selectorMatches`/`selectorPickedIndex` so the agent can tighten it; event-driven click settle reduces missed SPA transitions.
- **Full-bundle quick-start** — the release notes' `cd browser-whiskor` failed because the full zip extracts in place; now `unzip browser-whiskor-full-*.zip -d browser-whiskor`.
- **`start.bat` / `start.sh` banner version** — was hardcoded `v0.3.0`; now read from `package.json` like `start.ps1`.

## [0.8.1] — 2026-06-12

### Fixed

- **Full bundle release zip omitted `skills/`** — `release.yml`'s full-bundle build listed `server/ extension/ firefox-mv2/ scripts/ docs/ ...` but not `skills/`, so `skills/browser-whiskor-http/` (the HTTP-only agent skill shipped in 0.7.1) was missing from `browser-whiskor-full-*.zip`. Added.

## [0.8.0] — 2026-06-12

### Added

- **`whk` CLI** (`bin: whk` / `whiskor`, `server/cli.js`) — a single executable for setup, lifecycle management, and an interactive shell. `whk setup` copies `extension/`/`firefox-mv2/` into a managed directory (`~/.whiskor/`, override via `WHISKOR_MANAGED_DIR`) via a staged swap (`server/extension-installer.js`) so a crash mid-copy never leaves a half-written extension; `whk setup --no-start` only syncs files. `whk` (no args) = `whk restart`: sync extension files → ask the running server to reload the extension → stop the old server → start a new one (or just start if nothing was running). `whk stop` sends `POST /api/shutdown` for a graceful stop. `whk server` / `whk mcp` start the worker directly; `whk GET /health` etc. is a thin HTTP client. `scripts/setup.ps1` is the first-run bootstrap (`npm link` if `whk` isn't registered, then `whk setup`).
- **`whk shell`** — a zero-dependency full-screen TUI (`server/tui/`: `app.js` + `term.js` (ANSI / East-Asian width) + `editor.js` + `scrollback.js` + `highlight.js`) with an output pane, completion popup, line editor, and status bar. Categories (`action`/`capture`/`session`/`state`/`server`/`shell`) behave like folders — Enter/Tab/double-click to open, Esc/`..`/Backspace-on-empty to go back; typing at the root searches everything, inside a folder it filters. With an empty input, ←/→ navigate folders, or open a "field edit" overlay for commands with placeholder args (`detectFields()`/`substituteFields()`) — fill each field with the built-in `LineEditor`, then review the substituted command before sending. TUI-only builtins: `logs [n]`, `export [path]` (saves the transcript), `map [tabId]` (ASCII state-graph), `mouse` (toggle mouse capture so terminal text selection works). `whk shell --classic` (`server/cli-shell.js`) keeps the old inline-prompt shell and is always used for non-TTY/piped input.
- **Extension self-update via the managed directory** — the extension now sends `EXT_HELLO` (`{browser, version}`) on WS connect; if its manifest version differs from `package.json` (`extensionUpdate.autoReload`, default on), the server asks it to `chrome.runtime.reload()` once per stale version (no reload loop if the files are still old). `POST /api/extension/reload` lets `whk setup` request the same reload after refreshing the managed files while a server is running. Connected extension versions are reported in `GET /health` → `extensions`.
- **`POST /api/shutdown`** — graceful remote shutdown: flushes caches synchronously and exits 0 (so a supervisor doesn't restart it), used by `whk stop`/`whk restart`.
- **`GET /api/logs`** — the last 2000 server log lines (`core.js` ring buffer), with `?limit=` and `?level=warn|error` filters; powers the TUI's `logs` builtin.
- **`GET /api/sessions/:tabId/map`** — ASCII state-graph for a session's tab (`state-visualizer.js`, `?maxNodes=` default 40/max 200), falling back to the largest graph when the session's own `siteVersion` has no nodes.
- **`GET /api/graphs/:siteVersion/states`** and **`/states/:hash`** — list/inspect nodes of one state graph directly, without a session lookup.
- **`agentControl.autoSwitchTab`** (default on) — before an action or capture targets a non-active tab, the extension activates it first (`ensureTabActive` in both backgrounds); without this, `captureVisibleTab` photographs the wrong (active) tab. Tab-management actions (`list_tabs`/`switch_tab`/`open_tab`/`close_tab`) are exempt.
- **`press_key` chords and hold** — `"w+d"` presses multiple non-modifier keys together (all down in order, then up in reverse — previously extra keys were silently dropped); `holdMs` keeps a chord held before release (capped at 5s).
- **Selector-ambiguity reporting** — when a `selector` matches multiple elements, `click`/`type`/`right_click` pick the first *visible* one and add `selectorMatches`/`selectorPickedIndex`/`selectorNote` to the result so the agent can tighten the selector.

### Fixed

- **Timer-driven smart-delta flushes were silently dropped** — `delta-engine.js`'s `AGGREGATE_INTERVAL` timeout computed a delta but had nowhere to send it (only full-buffer flushes returning through `addFrame` reached storage); `get_delta`/`raw/delta/smart.json` stayed empty for quiet pages. `setFlushSink()` wires the timer path to `cache.storeSmartDelta` (`server/index.js`).
- **`findByText` mis-clicks on input values** — text matching now scores all label sources (`textContent`/`aria-label`/`placeholder`/`title`/`alt`/ARIA refs) plus an input's `value` as a last resort; case-exact matches outrank case-folded ones, `value` matches are penalized, and invisible elements are excluded before scoring finishes — fixes cases like `text:"NONAME"` landing on a chat input whose current value happened to be "noname".
- **`clickability` auto-unblock false positives** — after a fix step (close button / Escape / backdrop click / full-screen overlay sibling) removes the tracked obstructor, `verifyTargetClear()` re-checks the *target* itself; if something else (e.g. a lingering backdrop) still covers it, `fixResult` stays non-`success` and `obstructedBy` points at the real blocker instead of reporting a false `success`.
- **`viewport.json` never existed on non-scrolling pages** — `VIEWPORT_UPDATE` only fires on scroll/resize, but `TEXT_COORDS` carries the same viewport snapshot; the cache writer now persists it from there too.
- **`/api/sessions/:tabId/states` and state-detail siteVersion drift** — when a session's own `siteVersion` has no nodes, both endpoints now fall back across all graphs (same fallback `list_states`/`get_state_detail` already used over MCP), and `/map` picks the graph with the most nodes.

### Changed

- **`type`/`press_key` error messages** are more actionable (`No target element for type: selector "..." did not match` / `no selector given and nothing is focused`); `press_key` chord results include a `chord` array.
- Docs (`skills/browser-whiskor-http/`, `CLAUDE.md`) updated for `whk`, `autoSwitchTab`, selector ambiguity, `press_key` chords/hold, and the clickability re-verification behavior.

## [0.7.2] — 2026-06-11

### Fixed

- **MiniLM model download — missing `Xenova/` org prefix** — the startup auto-download (`server/index.js`) and the default `modelName`/`modelVersion` fallbacks in `embed-service.js` / `embed-worker-pool.js` / `embed-store.js` referenced the bare model id `paraphrase-multilingual-MiniLM-L12-v2`. `@xenova/transformers` does not infer an org for unprefixed ids, so it requested `https://huggingface.co/paraphrase-multilingual-MiniLM-L12-v2/...` (no such repo) and failed with "Unauthorized access", silently disabling semantic search on first run. All defaults now use the canonical `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, matching `config.json` and `scripts/download-model.js`; the cache-existence check path was corrected to match `@xenova/transformers`'s actual `FileCache` layout (`.model-cache/Xenova/<model>/...`, no `models/` segment). A new test (`tests/unit/embed-model-name-consistency.test.js`) pins all of these to one canonical string.

## [0.7.1] — 2026-06-11

### Added

- **`tools/list_changed` notification** — the MCP server now declares the `tools.listChanged` capability and sends `notifications/tools/list_changed` whenever a `tools/call` changes the visible toolset (profile auto-load on first use, idle unload, explicit `load_profile`/`unload_profile`). Previously no notification was ever sent, so MCP clients that fetch `tools/list` once and cache it could never see dynamically loaded tools. The transport's request handling moved into a testable `handleLine()` (`server/mcp/transport.js`).
- **Static tools mode** — `mcpServer.staticTools: true` (or `--static-tools` / `WHISKOR_MCPSERVER_STATICTOOLS=true`) exposes every tool profile permanently over MCP, with no dynamic load/unload, for clients that ignore change notifications. It widens *visibility*, never *permissions*: `requiresConfig` gates (`allowExecuteJs`, `allowAgentConfig`) and the per-tool `enabled` flags in `mcp-tools.json` still apply. `load_profile`/`unload_profile` become explicit no-ops; `profile_status` reports `staticMode: true`; duplicate-call detection still runs.
- **`skills/browser-whiskor-http/`** — a repository-shipped, self-contained agent skill (SKILL.md + reference.md) teaching the perceive→act workflow over the HTTP API alone, with every endpoint and action type verified against the current implementation (packed SoM, element thumbnails, `/export`, `secretRef` typing, `focus`/`clear_input`/`analyze_click`). Copy the folder into an agent's skill directory (`skills/README.md`); driving the browser over plain HTTP keeps tool schemas out of the agent's context window. Supersedes the `docs/ideas` prototype, which moved to `docs/archive/` with a pointer.

### Fixed

- **MCP stdout pollution** — modules logging via bare `console.log` (`cache-writer`, `cache-integrity`, …) wrote into the JSON-RPC stdout channel whenever the `--mcp` process ran standalone (no separate worker on :7892), producing repeated "Ignoring non-JSON line on stdout" warnings in MCP clients. `startMcpServer()` now reroutes `console.log`/`console.info` to stderr for the lifetime of the stdio transport.

### Added

- **Secret Guard** (`privacy.secretGuard`, default off) — server-side redaction that hides user secrets from the agent, logs, cache, and dashboard. Known values from `secrets.local.json` / `WHISKOR_SECRETS` are replaced with `[WHISKOR_REDACTED ...]` tokens at a single choke point (`core.routeMessage`); pattern detection covers email / credit card (Luhn) / JWT, with ssn / ipv4 / phone individually opt-in; key-name redaction catches unregistered values. `type_secret` lets the agent type a secret by **ref name only** — the worker resolves the value (`action-executor`), so it never appears agent-side. Screenshots are masked on the extension canvas after capture (no page overlay, no flicker). `GET /health` reports counts only; MCP `serverInfo` advertises active redaction — including under the proxy, which asks the worker's `/health` at initialize time.
- **Packed Set-of-Marks capture** — `capture_packed_som` crops only the interactive elements out of one real screenshot, shelf-packs them into a single numbered image, and lets the agent click by mark number at a fraction of a full screenshot's pixels/tokens. Includes a freshness-aware worker-side cache (invalidated by page-change signals), time-decayed usage statistics that order marks by click likelihood, per-element thumbnails (`get_element_thumbnail`, long-edge downscale in the extension canvas, view-aware cache), thumbnail pre-warming from the packed bitmap (`prefetchThumbs`), and optional capture-on-navigation (`prefetchOnNavigate`).
- **Source upload & correlation** — upload the target site's source (`POST /api/source/upload`, files or base64 zip via a dependency-free zip reader; dashboard SOURCE UPLOAD card) and query bounded slices with `get_source_context` by file/line, symbol, or observed component name. Component→source resolution prefers React `_debugSource` (exact file/line in dev builds) and falls back to symbol-name matching with an evidence-tiered confidence; observed `FRAMEWORK_DOM_MAP` data records correlations passively.
- **Real-browser E2E** — Playwright specs that load the actual extension (headed) and verify injected collection, executor round-trips, packed-SoM capture quality and caching, and secret masking against a live server.
- **Producer/consumer contract test** — statically cross-checks every injected `emit` type against a server consumer (core routing / cache-writer cases), so a new page-side producer without server wiring fails the suite instead of silently dropping data. Intentionally-unconsumed types live in an allowlist that is itself verified against the code.
- **Hollow-test CI guard** — unit tests that never import production code fail the build (`scripts/_check-hollow-tests.js`, wired into CI and `validate.ps1`); about half the unit suite previously tested inline re-implementations instead of the real modules and was rewritten.
- **React component name resolution** — the React adapter derives names through a staged resolver (displayName → host tag → memo/forwardRef/context unwrapping → dev `_debugSource` basename → fiber-tag kind labels), so trees no longer show "Unknown"; derived/kind-fallback names render dimmed in the dev panel.

### Fixed

- **Network capture field-name drift** — the page-side producer emits `reqId`/`headers`/`bodyPreview`/`ts` while the cache consumer read `requestId`/`requestHeaders`/`requestBody`/`startTime`, so every request deduplicated onto a single null id (`totalRequests: 1`). The cache now normalizes both namings; WebSocket / EventSource connections and `NETWORK_ERROR` (failed fetch/XHR) are captured too.
- **Dropped framework snapshots** — Vue 3 / Alpine / Preact / Solid adapters emitted snapshots that core/cache never consumed (4 of 9 adapters silently dead); Web Vitals observers (`PERF_LCP/CLS/FCP`) emitted to nowhere and are now folded into `PERF_METRICS`.
- **Self-capture noise** — the worker no longer records its own dashboard tab or `/export` downloads as page sessions (loopback host + own port are excluded).
- **React snapshot size** — node count is capped so giant trees can't blow up the cache or the agent's context.
- **Correlator confidence carried no information** — every causal chain scored a uniform ~0.66 under a single rule. Confidence is now evidence-based: mutating HTTP methods score higher, static-asset responses lower, and competing candidates dilute each other — with every factor recorded in a `chain.evidence` object so the number is auditable. Docs and the `why_did_this_change` description now present chains as ranked hypotheses, not proven causes.
- **Config-change-log id collisions** — `addChange` minted ids as `length + 1`, which collides after the 7-day prune shrinks the array; `markReverted` could then flip an old entry and leave the new change active, defeating the auto-revert safety net. Ids are now `max(id) + 1`. (Separately, nested patches were previously invisible to validation/auto-revert — both walkers are recursive now.)
- **Proxy-mode wiring gaps** — screenshot masking, packed-SoM cache/stats, and `type_secret` lived in the MCP layer and silently did nothing under the proxy (the production configuration). All three moved to worker-side choke points that every path (MCP stdio / HTTP / proxy) goes through; the serverInfo redaction notice now reaches the proxy too.
- **Windows cache rename failures** — the atomic-write `rename` occasionally hits transient `EPERM`/`EBUSY` (AV/indexer locks); it now retries with a short backoff and silently gives up only when the destination is gone.
- **`npm test` on Node 24** — `node --test <dir>` resolves the directory as an entry module on newer Node and crashes; the npm scripts now go through `scripts/_run-tests.js`, which expands directories to explicit file lists (works on every Node version; CI runs per-file and is unaffected).

### Security

- **HTTP API localhost CSRF** — `Access-Control-Allow-Origin` only blocked a page from *reading* the response; a `Content-Type: text/plain` + `mode:'no-cors'` request skipped preflight and was still dispatched, so any webpage the instrumented browser visited could drive `/api/action` (click/navigate/type_text/execute_js) on the user's other tabs (`appIsolation` is off by default and was a no-op here). `server/http-origin-guard.js` now rejects with 403 before the body is read whenever `Origin` is present and outside the allowed set; requests without an `Origin` header (same-origin GET, the MCP proxy, curl) are unaffected.

### Changed

- **Dashboard framework display is data-driven** — framework dirs are created on demand instead of pre-created empty, and the dashboard shows what actually arrived (fixes silently empty Console / Perf tabs and missing preact/alpine/solid/vue2 panels).
- **Repository housekeeping** — merged work branches deleted (local + remote, `main` only remains); release history trimmed to the latest version per user request (private repository).

## [0.6.0] — 2026-06-03

### Added

- **Instance identity** — a new `identity` config section gives each server a descriptive label (not security), surfaced on `GET /health` (`identity: {instanceId, name}`) and in MCP `serverInfo` (`instanceId` / `instanceName`). It exists for one job: telling multiple whiskor servers apart when several run on different ports/machines (e.g. a per-project whiskor alongside another). A single default instance needs no setup — `instanceId` auto-derives to `whiskor-<hostname>-<httpPort>` when unset, which is unique per host:port (two servers can't share a port), so there is no shared-default collision. Override via `config.json` → `identity` or `WHISKOR_IDENTITY_INSTANCEID` / `WHISKOR_IDENTITY_NAME`. Deliberately *not* encryption/auth — local loopback needs none; `appIsolation` tokens remain the tool for LAN exposure.

### Fixed

- **Stale MCP `serverInfo` version** — `serverInfo.version` was hardcoded `3.0.0`; it now reports the real `package.json` version (`server/mcp/transport.js`), consistent with the rest of the project's single-source-of-truth versioning.

## [0.5.4] — 2026-06-02

### Fixed

- **`stop` / `restart` are now supervisor-aware** — making the supervisor the default in 0.5.3 broke both: `npm run stop` killed only the port-listening worker, which the supervisor (no port, so untouched) immediately restarted; `npm run restart` then double-launched into a port conflict. `stop.ps1` now stops the supervisor (matched by `scripts/supervisor.js` in its command line) *first* so it can't respawn the worker, then stops the worker as before. `restart.ps1` relaunches under the supervisor by default (`-NoSupervisor` for the raw worker). Stopping a raw `start:raw` worker is unaffected.

## [0.5.3] — 2026-06-02

### Added

- **Crash resilience / auto-restart** — the server now recovers on its own when the worker crashes. `npm start` and `start.ps1` run under a new zero-dependency supervisor (`scripts/supervisor.js`) by default, which restarts the worker on an *unclean* exit with backoff and a crash-loop guard (gives up after 5 crashes in 60s); a clean signal exit (code 0) is not restarted. Run the raw worker with `npm run start:raw` / `start.ps1 -NoSupervisor`. The `--mcp` process is intentionally not supervised (its lifecycle belongs to the agent).
- **No lost instructions during a restart** — in Proxy Mode the worker (heavy process: ports + cache + embeddings) and the MCP/stdio process the agent talks to are separate, so a worker crash never reaches the agent. `requestServer()` now retries connection-level forward failures (`ECONNREFUSED`/`ECONNRESET`/…) while the worker restarts (`config.json` → `resilience.proxyRetry`, default up to 15s), turning a restart into a brief pause instead of a dropped tool call. Only connection failures are retried — a refused connection never reached the worker, so re-sending cannot double-execute an action; HTTP error responses are returned as-is.

### Fixed

- **No corrupted cache on crash** — `cache-writer` now writes atomically (temp file → `rename`), so a crash mid-write leaves the previous file intact instead of a half-written JSON. On startup the integrity check additionally sweeps orphaned `*.tmp` files left by a crash (`cache-integrity.cleanupTempFiles`).
- **Clean shutdown handoff** — `uncaughtException` / `unhandledRejection` / `SIGTERM` / `SIGINT` now route through a single `shutdown()` that flushes in-memory network/console buffers synchronously (`cache.flushAllSync()`) before exiting (non-zero on crash so the supervisor restarts). Also lifts `httpServer` to module scope so the signal handlers no longer reference an out-of-scope binding.

## [0.5.2] — 2026-06-02

### Added

- **Related-input detection** — `analyze_click` and `get_ui_catalog` now surface `relatedInputs` (+ a `relatedInputsTip`) for action buttons: the input fields a button likely depends on (e.g. a code field that must be filled before a "join" button works), so the agent fills them first instead of hitting a validation alert. Association is layered — shared `<form>` / ARIA `aria-controls`|`aria-describedby` (confidence `high`) and a bounded nearest-common-container heuristic (confidence `low`). `confidence` is evidence-tiered with the `basis` exposed (not a fabricated number), and the tip hedges for low-confidence matches.

### Fixed

- **Stale version strings** — `start.ps1` banner now reads the version from `package.json`; `mcp-server.js` header and the README/CLAUDE.md titles no longer hardcode a version (which kept drifting each release).

### Docs

- Clarified that `shared/injected/` is **partial** coverage: 7 analyzers (`text-coords`, `network`, `css-origin`, `source-fetcher`, `ui-catalog`, `framework-dom-map`, `clickability`) plus `plugin-system.js` and `bridge.js` live outside `shared/` and must be edited in both `extension/` and `firefox-mv2/`. `sync-shared.ps1` only touches files present in `shared/`, so it does not overwrite those.

## [0.5.1] — 2026-06-02

### Fixed

- **Manual collect re-runs analyzers** — `MANUAL_COLLECT` with no plugin list called `registry.runAt('manual')`, which matched zero plugins (all register at `DOMContentLoaded`/`load`). The DevTools panel's Collect button, `refresh_data`, `trigger_collect`, and the adaptive scheduler therefore re-collected nothing but storage. It now re-runs the `DOMContentLoaded`+`load` phases.
- **Set-of-Marks marker drift** — Dashboard SoM markers drifted because the marks layer covers the preview container while the screenshot `<img>` is centred inside it (`margin:0 auto`); markers are now anchored to the image's rendered offset so they line up regardless of the target viewport's aspect ratio.

### Added

- **`GET /export`** — Downloads the session cache as a ZIP (optional `?tabId=` scopes to one session), fixing the panel's "ZIP" button which pointed at a nonexistent route. Uses a dependency-free `server/zip-writer.js` (zlib deflate + CRC32).

## [0.5.0] — 2026-06-02

### Added

- **CDP high-fidelity input** — `agentControl.input.highFidelity` (`off` | `fallback` | `always`) routes `click`/`type_text`/`press_key` through the Chrome DevTools Protocol (`chrome.debugger`) so events are `isTrusted:true`, reaching widgets gated on trusted input or user activation (popups, clipboard, file pickers, some payment/OAuth). Synthetic events stay the default; Chrome only (Firefox ignores the setting and stays synthetic). Requires the `debugger` permission (Chrome manifest).
- **Physical-fidelity synthetic input** — Synthetic keys now carry `code`/`keyCode`/`which` (pages gating on those no longer ignore the keystroke) and emit IME `composition` events for CJK / rich-text editors; typing uses `InputEvent` (`beforeinput`/`input`).
- **Screenshots as MCP image blocks** — `capture_screenshot` / `capture_element_screenshot` return the image as a viewable MCP image content block (not base64 inside JSON text) when `returnImage=true`; the default omits it (`filePath` only) to save tokens.

## [0.4.5] — 2026-06-02

### Added

- **Native dialog guard** — `window.alert/confirm/prompt` are overridden in the page (MAIN world) so a native dialog never blocks the event loop — which previously froze the click handler and timed the action out (the classic "click hangs because a modal popped"). The dialog's content is captured, auto-answered (alert dismissed; confirm/prompt per policy, overridable per call via a `dialog: {confirm, prompt}` option on `click`/`type_text`), and returned in `result.dialogs` with causal attribution (`direct` / `indirect` / `none`) to the triggering action.

### Fixed

- **Multi-browser action routing** — Actions and screenshots are now sent only to the service worker that owns the target tab (`core.sendToTab`) instead of being broadcast to every connected browser. Previously, when more than one browser ran the extension, a browser lacking the tab could answer "No tab with id" first and win the result race — causing flaky failures and hangs. Falls back to broadcast only when no connected SW is known to own the tab.
- **Tab-gone recovery** — When an action or capture targets a tab that was closed or reloaded into a new id, the service worker now returns a structured `tabGone` error with a `liveTabs` list (id/url/title) so the agent can retarget by URL or use `list_tabs` / `switch_tab`, instead of the raw Chrome "No tab with id". Capture also fails fast rather than silently grabbing the active tab.

## [0.4.4] — 2026-06-02

### Added

- **WAI-ARIA signals in `submit:"auto"` inference** — Beyond `enterkeyhint`, submit inference now reads `aria-keyshortcuts` (an authoritative declared shortcut, e.g. "Control+Enter"), `role="searchbox"` / `type="search"` (Enter submits), and `role="textbox"` + `aria-multiline` (`false` → single-line submit, `true` → newline), plus a `role="search"` landmark ancestor. Reported with `confidence:"aria"`. This resolves the Enter-vs-newline ambiguity on many contenteditable editors that set no `enterkeyhint`.
- **`find_target` live verification (`verify`)** — Set `verify:true` to re-check the top candidate(s) clickability live via `analyze_click` at call time instead of relying on the collection-time hint. It attaches a `live{exists,inViewport,obstructed,recommendedStrategy}` report and corrects `clickable` accordingly. Bounded by `verifyTop` (default 1) and prefers selector/text over coordinates so an overlay isn't mistaken for the target.

## [0.4.3] — 2026-06-02

### Changed

- **`find_target` deprioritizes obstructed candidates** — Ranking now demotes covered (`clickable:false`, −0.2) and offscreen (`clickable:null`, −0.05) candidates so a reachable target outranks a covered one of similar score, without overriding a clearly better text match. The reported `score` stays the true fuzzy score.
- **Wider `submit:"auto"` hint dictionary** — Submit inference now recognises `return` / `↵` / `⏎` as Enter, more modifier spellings (`ctrl`/`control`/`⌃`, `cmd`/`command`/`⌘`, `shift`/`⇧`), and more phrasings ("press/hit enter", "enterで送信", "return to send", "そうしん", …).
- **Stronger Svelte adapter** — `get_framework_state` (svelte) now also returns `metaComponents` (real component names/files from `__svelte_meta`, dev builds), `componentFingerprints` (per scoped-CSS-hash element counts + a sample — which work in production where instances are gone), and a `summary` of how many components each path found, so a production Svelte app reports useful context instead of an empty `components` list.

## [0.4.2] — 2026-06-02

### Added

- **`find_target` tool (core)** — A one-shot "where do I act for X?" resolver. It combines `get_ui_catalog` (buttons / links / inputs, with accessible-name labels) and `get_text_coords`, fuzzy-ranks them (MiniLM when available), and returns ranked candidates with click coordinates (`center`), a selector hint, `kind`, `score`, and — for inputs — the inferred `enterKey`. It finds an icon control by its label/tooltip (e.g. "送信") at the control's own coordinates rather than a floating tooltip overlay, and the returned `center` can be passed straight to `click(x, y)`. (61 → 62 tools; `core` profile 13 → 14.)
- **Clickability hints in `get_ui_catalog` / `find_target`** — Each interactive element now carries a collection-time `clickable` hint (`true` / `false` / `null` when offscreen) with `obstructedBy` (the covering element's selector) when something sits on top. Surfaced through `find_target` candidates so an agent can spot an obstructed target up front instead of after a failed click.
- **contenteditable / rich-text editors in `get_ui_catalog`** — Chat boxes and other `contenteditable` / `role="textbox"` editors are now catalogued among inputs (`type:"contenteditable"`) with an accessible-name `label` and inferred `enterKey`, so they're findable via `search` / `find_target` — not just native form fields.

## [0.4.1] — 2026-06-02

### Added

- **`type_text` submit inference (`submit:"auto"`)** — Infers the submit gesture from observable signals (`enterkeyhint`, a single-line `<input>` in a `<form>`, `<textarea>` = newline, hint text such as "Ctrl+Enter" / "送信"). It cannot read a page's JS keydown handlers, so it returns `submitInference {key, confidence, evidence}` with `key:null` (an honest "unknown") rather than guessing. `onFail` — `agentControl.submitInference.onFail` plus a per-call override — chooses `type-only` (default: type the text, skip submit) or `abort` (type nothing, return).
- **Pre-typing submit hint in `get_ui_catalog`** — Form inputs now carry `enterKey` (the same inference) so an agent knows how to submit before typing; inputs also gained a `label` (accessible name).
- **Fuzzy suggestions by default** — `get_text_coords` and `get_ui_catalog` now return MiniLM semantic `_suggestions` automatically when an exact `search` finds nothing (opt out with `includeSuggestions:false`); previously this required `includeSuggestions:true`. Search descriptions now point to fuzzy (`match:` / suggestions) when the exact wording is unknown.
- **`type_text` target echo** — The response reports the element actually typed into (`target:{tag,id,name,label,selector}`), so a wrong-target type (e.g. when `selector` is omitted and `activeElement` was unexpected) is caught immediately.

## [0.4.0] — 2026-06-01

### Added

- **Profile auto-load on tool call** — Calling a tool whose profile isn't loaded now auto-loads the owning profile and proceeds (reported via `_autoLoaded`) instead of bouncing the call back as unavailable — which agents repeatedly misread as "not implemented". Permission-gated profiles (`allowExecuteJs` / `allowAgentConfig`) are **not** auto-loaded and instead return a precise reason so the agent can ask the user. (`tool-manager.ensureToolVisible`, `mcp/registry.js`)
- **Configurable, token-light screenshots** — `capture_screenshot` no longer inlines the base64 image by default (large token cost); `filePath` is always returned and the image is saved to disk. New `agentControl.screenshot` config (`returnImageByDefault`, `format`, `quality`, `maxWidth`); when returned, the full screenshot is JPEG-encoded and downscaled to `maxWidth`. Per-call overrides: `returnImage` / `format` / `quality` / `maxWidth`. `capture_element_screenshot` is unaffected (already small).
- **`type_text` submit gestures** — New `submit` option (`enter` / `shift-enter` / `ctrl-enter` / `cmd-enter` / `none`) so the right submit/newline gesture can be chosen per app. `text` is now optional — submit an already-filled field with just `submit:"enter"` without loading the `press_key` profile. `pressEnter` kept as a legacy alias.
- **Accessible-name search** — `get_ui_catalog` buttons/links now carry a `label` resolved from `aria-label` / `title` / `alt` and the text of `aria-labelledby` / `aria-describedby` targets (e.g. a Material tooltip "送信") **at the element's own coordinates**. `click(text:)` matches the same — so an icon control is found by its label/tooltip rather than the floating tooltip overlay.

### Fixed

- **Proxy-mode read tools** — Read tools now `await` the proxy cache (which returns Promises over HTTP) instead of assuming a synchronous cache. Fixes `cache.freshnessInfo is not a function`, `getSessionList(...).find is not a function`, and `get_framework_state` falsely reporting "Available: none". Added `freshnessInfo` / `getConsoleLogs` proxy shims; the proxy `readSessionFile` now returns `null` for a missing file (404) instead of leaking `"File not found"` (fixes `get_viewport`).
- **`type_text` on contenteditable** — Rich-text editors (Gemini, Notion, …) have no `.value`; typing crashed with "Cannot read properties of undefined". They are now detected and driven via `execCommand('insertText')`.
- **`capture_element_screenshot`** — Replaced `new Image()` (undefined in MV3 service workers → "Image is not defined") with `createImageBitmap`; the crop now scales by the page's real `devicePixelRatio`.
- **Click diagnostics** — A click that triggers a full-page navigation no longer times out (the service worker reports soft success on main-frame `webNavigation.onCommitted`). A click whose target is removed/replaced by a re-render is no longer mislabeled `click_intercepted`.

## [0.3.4] — 2026-05-27

### Added

- **Coexistence Proxy Mode** — Resolves port binding conflicts (`EADDRINUSE`) when spawning multiple browser-whiskor instances (e.g., manually running a standalone server and editor-launched MCP clients).
  - Automatically checks `http://localhost:7892/health` on startup.
  - If active, switches to **Proxy Mode** where it skips binding HTTP/WebSocket ports and proxies all MCP commands to the running instance via HTTP requests.
  - Overrides the local `embed-service` to route semantic embedding requests to the remote instance (`POST /api/embed`), avoiding heavy local ONNX model loads or duplicate workers.

### Fixed

- **Firefox Extension Runtime Bugs**:
  - `css-origin.js` — Removed a syntax-breaking trailing backslash `\` at line 322.
  - `ui-catalog.js` — Fixed a `TypeError` by adding checks for `SVGAnimatedString` class types on SVG elements (aligning with Chrome's implementation).
- **Session Diagnostics**:
  - `get_sessions` MCP tool — Added warnings and detailed user notes when the active sessions list is empty, helping identify missing extension connections rather than returning a silent empty list.

## [0.3.3] — 2026-05-27

### Performance

- **VLQ Decoder Optimization** — Replaced `B64.indexOf()` with `B64_MAP.get()` for O(1) character lookups in source map parsing. Critical performance improvement for large production bundles: parsing time reduced from seconds to milliseconds. Applied to both browser-side (`css-origin.js`) and server-side (`source-map-resolver.js`) implementations.

### Security

- **MCP Origins Restriction** — Changed `allowedMcpOrigins` default from `["*"]` to `["localhost", "127.0.0.1"]`. Secure-by-default configuration prevents potential security risks in future HTTP-based integrations. Users must explicitly opt-in to allow external origins.

### Added

- **Disk Size Management** — Added LRU-based disk cache eviction to `cache-integrity.js`:
  - `calculateDiskUsage()` — Recursive directory size measurement
  - `getAllSessions()` — Enumerate sessions with metadata (path, updatedAt, size)
  - `enforceDiskLimit()` — Automatic cleanup of oldest sessions when exceeding `stateGraph.maxDiskMB`
  - Prevents unbounded disk growth in long-running deployments

### Documentation

- **Correlator Window Guidance** — Added comprehensive documentation to `correlator.js` explaining:
  - Correlation windows (Network→DOM: 500ms, Framework→DOM: 100ms)
  - Confidence scoring and decay curves
  - Adjustment guidance for heavy SPAs and slow networks
  - Priority rules (MutationObserver > TEXT_COORD_DELTA)
- **v0.3.3 Improvements Guide** — Created `docs/v0.3.3-improvements.md` with detailed explanations, testing recommendations, and migration guide

### Changed

- **Config Comments** — Added bilingual (EN/JA) warning comments for `allowedMcpOrigins` security setting

## [0.3.2] — 2026-05-27

### Added
- **Semantic Search (MiniLM ONNX)** — Upgraded text search to use a local `paraphrase-multilingual-MiniLM-L12-v2` model running in a background worker thread. Provides high-quality multilingual semantic similarity and fuzzy matching.
- **Model Pre-fetching** — Added `npm run download-model` to `postinstall` to automatically download the MiniLM model (approx 50MB) from Hugging Face Hub (no login required) and cache it in `.model-cache/`.
- **Search Services & Worker Pool** — Introduced new service layer (`embed-service.js`, `embed-worker-pool.js`, `embed-worker.js`, `load-monitor.js`) to handle asynchronous background embedding without blocking the MCP event loop.
- **Documentation Updates** — Updated `docs/architecture.md` and `README.md` to reflect the new semantic search architecture and `services/` directory.

## [0.3.1] — 2026-05-27
- Fix versioning issues.

## [3.11.0] — 2026-05-24

### Added
- **CSS Origin @layer Cascade 5 spec compliance** — `css-origin.js`: `buildLayerRegistry()` tracks `@layer` declaration order, `flattenRules()` recursively flattens `@layer`/`@scope`/`@media`/`@supports`/`@container`, unlayered rules treated as `Infinity` priority (always beats layered at equal specificity)
- **Sourcemap VLQ decoder** — `css-origin.js`: Pure JS `vlqDecode()`, `fetchSourceMap()` (data: URI + HTTP), `resolveSourceLine()` maps generated line → `{originalFile, originalLine, originalColumn}`. Session-scoped cache for maps.
- **Level 1 CSS Origin bridge** — `css-origin.js` sends `postMessage(CSS_ORIGIN_RESOURCE_REQUEST)` → `bridge.js` (reqId forwarding) → `sw.js` (routing) → `panel.js` (`chrome.devtools.inspectedWindow.getResources()` + `getContent()`) → reverse path via `scripting.executeScript` injection into MAIN world. 500ms timeout fallback.
- **Framework snapshots to correlator** — `server/core.js`: `REACT_SNAPSHOT`, `VUE_SNAPSHOT`, `VUE2_SNAPSHOT`, `VUE3_SNAPSHOT`, `ANGULAR_SNAPSHOT`, `SVELTE_SNAPSHOT` now feed `correlator.addMessage()` for improved Rule 2/3 causal chain accuracy (without chain persistence).

### Changed
- **css-origin.js acquisitionLevel default** — `|| 4` → `?? 4` (nullish coalescing) so `acquisitionLevel: 0` correctly disables Level 1 instead of falling back to 4.
- **source-fetcher.js dependencies** — `[]` → `['css', 'css-origin']` so SourceFinder runs after both CSS analyzers.
- **devtools.js simplified** — Removed 69-line polling loop (`collectLevel1Css`, `startL1Polling`, `__SI_DEVTOOLS_CSS_CACHE__`). Level 1 bridge moved to `panel.js` where `getResources()` is available.
- **core.js message routing refined** — Generic DOM snapshots (cache + dashboard only) separated from framework snapshots (cache + dashboard + correlator). `STATE_HASH_REPORT` and `TRANSITION_HISTORY` correlator calls removed (they added no causal value). `_persistCausalChains` argument fixed.

### Fixed
- **bridge.js reqId lost** — `CSS_ORIGIN_RESOURCE_REQUEST` correlation ID (`reqId`) now forwarded in `postMessage`→`runtime.sendMessage` conversion.
- **Old Level 1 polling removed** — `devtools.js` no longer uses `chrome.devtools.inspectedWindow.eval()` for CSS extraction. Replaced by on-demand `getResources()` + `getContent()` bridge.

### Firefox MV2
- All above in `firefox-mv2/`: css-origin.js, source-fetcher.js, panel.js, background.js, bridge.js, devtools.js synced.

---

## [3.10.0] — 2026-05-22

### Added
- **3 new analyzers** — `shadow-dom.js` (Shadow DOM perception: 60 roots, 600 nodes/root, per-root MutationObserver, closed root handling, slot resolution, 80ms delta debounce), `dom-mutations.js` v2 (content recording with before/after attribute values & characterData, bigram-based batching with 80ms debounce, per-element caps: 40 structural/30 text/10 attributes, overflow counter), `dom-snapshot.js` (3000-node budget structural snapshot, same-origin iframe recursion, form state capture, targeted mode via SNAPSHOT_ELEMENT, real-time delta stream)
- **Element-level screenshot capture** — `capture_element_screenshot` MCP tool with selector/rect/padding/format/quality options; `cropImage()` added to both Chrome MV3 (`sw.js` via OffscreenCanvas) and Firefox MV2 (`background.js` via `<canvas>`); `ELEMENT_CAPTURE_RESULT` routed through server core
- **File splitting** — `react.js` → `react-hooks.js` (classifyHook, getHooks) + `react-state-managers.js` (detectStateManagers) + `react.js` (main adapter); `state-store.js` → `state-persistence.js` (persistGraph, loadGraph, save/loadSnapshot)
- **`read.js` split into 4 files** — `read-helpers.js` (fuzzy matching helpers), `read-basic.js` (tools 1–5), `read-data.js` (tools 6–13), `read-state.js` (tools 14–21)
- **Dev tooling** — `.eslintrc.json`, `.prettierrc`, bash scripts (`scripts/sync-shared.sh`, `scripts/validate.sh`) alongside existing PowerShell scripts
- **Archive tests** — `tests/archive/mcp-capture.test.js` (element capture tool logic), `tests/archive/sw.test.js` (cropImage geometry clamping)

### Changed
- **react.js split** — Maintains backward-compatible IIFE; new files register on `window.__SI_REACT_HOOKS__` and `window.__SI_REACT_STATE_MANAGERS__` globals
- **state-store.js split** — Persistence functions extracted to `state-persistence.js`; `persistGraph` calls updated to pass `graphs` Map parameter to avoid circular requires
- **cache-writer.js hot-path I/O** — `getSession` and `updateIndex` converted from sync `fs` to await `fs.promises` (`fsp.mkdir`, `writeJsonAsync`)
- **React adapter loading order** — `manifest.json` (both Chrome & Firefox) updated: `bippy.iife.js` → `react-hooks.js` → `react-state-managers.js` → `react.js`
- **Content scripts** — Both manifests now include `shadow-dom.js` and `dom-snapshot.js` after `dom-mutations.js`; all shared/ files synced to extension/ and firefox-mv2/
- **Test count** — 308 tests pass (277 unit, 20 integration, 11 stress)

### Fixed
- **README.md naming** — References to `state-machine.js` corrected to `state-store.js`
- **Archive stub tests** — `mcp-capture.test.js` and `sw.test.js` updated from stubs to proper assertions

---

## [3.9.0] — 2026-05-22

### Added
- **Navigate lock** (`state-navigator.js`) — tab-level `navigating` Map prevents concurrent `navigate()` calls on the same tab, returning `CONCURRENT_NAVIGATION` error instead of corrupting state.

### Changed
- **Async I/O in WS handler** — `handleMessage()` in `cache-writer.js` now uses `fs.promises` for all file writes/reads. TEXT_COORDS read→merge→write no longer blocks the event loop.
- **CORS restricted** — HTTP API `Access-Control-Allow-Origin` changed from wildcard `*` to localhost-only by default. Respects `allowedMcpOrigins` config when set to specific origins.
- **Console.error → console.log** — Info-level cache events (PAGE_NAVIGATED, TEXT_COORDS, etc.) now log to `console.log` instead of `console.error`. Actual errors (I/O failures, path traversal) remain on stderr.
- **Test counts** — 277 unit / 299 total (was 282 / 313). Two inline-implementation stubs archived to `tests/archive/` with documentation notes.

### Fixed
- **`readSessionFile` path traversal** — Added `path.resolve()` + `startsWith(dir)` validation. Blocks `../../etc/passwd` style attacks even though `relPath` is currently hardcoded.
- **Dashboard viewport jitter on page navigation** — `cache-writer.js` now deletes stale `text-coords.json` on `PAGE_NAVIGATED`. Dashboard explicitly clears `S.words` and calls `resetCanvasView()`.

---

## [3.8.0] — 2026-05-22

### Added
- **WhiskorCore** (`server/core.js`) — Extracted core server logic (socket management, message routing, broadcast, config push, HTTP handling) into a testable class. Enables real code coverage measurement without starting full server.
- **Server fixture integration** — `tests/helpers/server-fixture.js` now wraps `WhiskorCore` with injected stubs, providing accurate coverage of routing logic.
- **`_route()` test alias** — Added to `ServerFixture` for direct message routing in unit tests.

### Changed
- **server/index.js** — Refactored to instantiate `WhiskorCore` with real modules (cache, actions, screenshots, state-machine, etc.). Reduced from 484 → 210 lines. All routing logic delegated to core.
- **Test coverage** — 273 unit tests now measure real server routing logic instead of mock implementations.

### Fixed
- **`_pendingActions` closure bug** — Fixed `this` reference in `actions.handleResult` stub within `server-fixture.js`.
- **Default stub syntax errors** — Fixed `getSessionList() []` → `getSessionList() { return []; }` and similar in `core.js`.

---

## [3.7.0] — 2026-05-22

### Added
- **Shared Code Infrastructure** (`shared/injected/`) — 19 common files extracted from Chrome/Firefox extensions into a single source of truth. Eliminates manual sync overhead.
- **Auto-Sync CI** (`.github/workflows/ci.yml`) — Automatically copies `shared/` changes to both `extension/` and `firefox-mv2/` on push. Verifies sync integrity via hash comparison.
- **Sync Script** (`scripts/sync-shared.ps1`) — Local tool to propagate `shared/` changes to both extensions (`-CheckOnly`, `-DryRun` modes supported).
- **Scroll-Triggered Text Collection** — `IntersectionObserver` in `text-coords.js` now triggers `collect()` when new text elements enter the viewport, ensuring offscreen texts are cached.
- **11 unit tests** for IntersectionObserver scroll-triggered collection (`seen-text-tracker.test.js`).

### Fixed
- **HOST binding security issue** — `WebSocketServer` and `httpServer` now bind to configured `HOST` (default: `127.0.0.1`) instead of `0.0.0.0`.
- **CI flaky tests on Linux** — WebSocket disconnect tests now use polling (`waitFor`) instead of event waiting, fixing timeout failures on GitHub Actions runners.
- **Scroll-triggered collection not working** — Added debounced `api.emit()` call when `IntersectionObserver` detects new elements.

### Changed
- **CI report format** — Per-file test results with ASCII-formatted summary, pass rate, and sync status.
- **Test timeout** — `waitEvent` default timeout increased from 2s to 5s for CI stability.
- **Documentation**: Archived `DESIGN_V2.md` to `docs/archive/`, updated `update-report.md` to v3.6.0.
- **`.gitignore`** — Added temporary directories (`.idea/`, `cache/`, `playwright-report/`, `test-results/`).

### Removed
- **Duplicate files** — 19 identical files removed from `extension/injected/` and `firefox-mv2/injected/`. Now sourced from `shared/injected/`.
- **Stale test archive** — `tests/archive/` (5 skeleton tests) removed; full versions exist in `integration/` and `stress/`.

---

## [3.6.0] — 2026-05-22

### Added
- **Dynamic Tool Profile Manager** (`tool-manager.js`) — Manages MCP tool visibility based on context, auto-detection, and AI requests. Core tools (12) are always available. Other profiles load on demand or auto-trigger, and auto-unload after idle turns.
- **Tool Profiles** (`configs/tool-profiles.json`):
  - `core` (12 tools) — Basic perception and interaction. Always loaded.
  - `debug` (+6) — Console, storage, perf, CSS, DOM, accessibility. Auto-loads on debug triggers.
  - `state-nav` (+7) — State graph navigation. Auto-loads on state-related calls.
  - `delta` (+3) — UI change tracking. Auto-loads after page interactions.
  - `advanced-actions` (+10) — Drag, hover, select, etc. Auto-loads when needed.
  - `admin` (+4) — Server config. Requires `allowAgentConfig`.
  - `power` (+2) — JS execution, explicit waits. Requires `allowExecuteJs`.
- **4 new MCP tools:**
  - `load_profile` — Load a tool profile dynamically
  - `unload_profile` — Unload a profile to free context
  - `search_tools` — Discover available tools without loading them
  - `profile_status` — Check active profiles and idle turns
- **Auto-detection**: Server infers intent from tool calls and loads relevant profiles automatically.
- **Idle unloading**: Profiles not used for N turns are automatically removed to keep AI context lean.
- **Usage warnings**: AI receives warnings when a profile has been active for many turns, encouraging load→use→unload→reload best practices.
- **Session reset**: All profiles reset on MCP reconnect for clean state.
- **14 unit tests** for tool manager (session management, profile loading, auto-detection, idle unload, warnings).

### Changed
- **MCP tool count: 45 → 49**
- **Tool filtering**: Registry now uses tool manager for dynamic visibility.
- **Server integration**: Tool manager initialized on MCP startup with session ID.

---

## [3.5.0] — 2026-05-21

### Added
- **Smart Delta Engine** (`delta-engine.js`) — Aggregates `TEXT_COORD_DELTA` frames into semantic events. Motion clustering groups elements with identical movement vectors. Scroll detection classifies bulk movement (70%+ threshold). Decorative CSS animations (opacity/color/shadow-only) are filtered out.
- **Pattern Registry** (`pattern-registry.js`) — UI patterns are hashed and stored on first appearance. Subsequent appearances are sent as compact reference IDs (`pat-xxxx`). Supports `lookup_pattern` for lazy detail retrieval when AI needs to "remember" a pattern.
- **3 new MCP tools:**
  - `get_delta` — Get latest aggregated UI changes (scroll, motion groups, content updates, appearances)
  - `list_patterns` — List all known UI patterns for a tab
  - `lookup_pattern` — Look up full definition of a pattern by reference ID
- **Delta integration in server** — `TEXT_COORD_DELTA` and `VIEWPORT_UPDATE` messages feed into the delta engine. Aggregated deltas are stored in cache for MCP access.
- **22 unit tests** for delta engine and pattern registry (motion clustering, scroll detection, pattern hashing, frame buffering).

### Changed
- **MCP tool count: 42 → 45**
- **`TEXT_COORD_DELTA` handling** — Now feeds delta engine in addition to dashboard broadcast.

---

## [3.2.0] — 2026-05-20

### Added
- **State graph with semantic labels** — Each recorded UI state has an auto-generated label ("Cart page (2 items, $49.99 total)"), semantic tags (`["authenticated", "cart-open"]`), and keyState (important values extracted from Redux/Zustand stores).
- **Unified composite hash** — Three-layer hash system: `reactHash` (component tree + router + store keys), `domHash` (URL + interactive elements), `compositeHash` (FNV32 combination). Non-deterministic values (timestamps, UUIDs, loading flags) are excluded from hash computation.
- **State navigation** — `navigate_to_state` replays recorded actions via BFS shortest path with per-step hash verification. Falls back to URL navigation if no recorded path exists.
- **6 new MCP tools:**
  - `list_states` — List all recorded states with labels, tags, visit counts
  - `search_states` — Fuzzy-search states by label, tags, URL, or keyState
  - `get_state_detail` — Full metadata for a state, optionally with snapshot
  - `pin_state` — Bookmark states with custom labels and tags
  - `navigate_to_state` — Navigate to a target state by replaying actions
  - `get_navigation_path` — Dry-run path check without executing actions
- **Non-deterministic filter** — Excludes timestamps, UUIDs, long random strings, and configurable keys from state hash computation for stable identification.
- **Multi-layer storage** — L1 in-memory graph, L2 gzip-compressed disk persistence, L3 LRU eviction with protected tags.
- **REACT_TRANSITION handler** — Previously swallowed events now recorded as state graph edges.
- **state-reporter.js** — Extension-side module for REQUEST_STATE_HASH handling and watchMode during navigation replay.
- **Edge confidence scoring** — Based on observation count, recency, and transition consistency.

### Changed
- **Explorer uses unified hash** — `explorer.js` now computes `compositeHash` from `reactHash` + `domHash` instead of its own independent hash.
- **react.js writes `__SI_REACT_HASH__`** — React adapter exposes its hash globally for composite hash calculation.
- **state-machine.js is now a wrapper** — Delegates to `state-store.js` for backward compatibility.
- **EXPLORER_STATE_UPDATE payload extended** — Now includes `reactHash` and `domHash` alongside `compositeHash`.

### Fixed
- **REACT_TRANSITION events were swallowed** — Added handler in `server/index.js` to record React state transitions as graph edges.
- **Hash inconsistency between explorer and React adapter** — Unified to FNV32 algorithm with same input structure.

---

## [3.1.0] — 2026-05-20

### Added
- **Set-of-Marks (SoM) screenshots** — `capture_screenshot(marks=true)` overlays numbered red circles on interactive elements. Returns an `elements` map so agents can reference elements by number instead of coordinates. Uses `OffscreenCanvas` (MV3) or `document.createElement('canvas')` (MV2).
- **Fuzzy text matching** — `get_text_coords(match="query")` performs token Jaccard + character bigram similarity search. Returns results sorted by score (0.0–1.0). Server-side implementation mirrors extension-side `text-coords.js` logic.
- **`contextHint` on text coordinates** — Each text item includes a role description (e.g. "navigation link", "form label", "button") for better agent understanding.
- **`get_config_changes` MCP tool** — Returns a log of config changes made during the session, with severity levels and auto-revert status.
- **Explorer v2** — Rewritten with fuzzy element matching, hash-based loop detection (`computeStateHash`), configurable `maxDepth`, and framework-agnostic state hashing.
- **Agent config control** — `agentControl` section in `config.json`:
  - `allowAgentConfig` — gate for `set_config` MCP tool (default: `false`)
  - `autoRevertConfig` — auto-revert non-recommended config changes on startup (default: `false`)
  - `screenshotMarks` — enable SoM markers by default (default: `false`)
- **Config change audit** — `config-change-log.js` tracks every config modification with `{keyPath, oldValue, newValue, severity, timestamp}`. Severity: `safe`, `warning`, `danger`.
- **Response warnings** — MCP responses include `_warnings` array with codes: `STALE_DATA`, `ADAPTER_LIMITED`, `PARTIAL_TREE`, `NO_MATCH`.

### Changed
- **Framework adapters synchronized** — All 9 Firefox MV2 adapters updated to match Chrome MV3 versions (React, Vue 3, Vue 2, Angular, Svelte, Preact, Alpine, Solid, DOM-generic).
- **README updated** — Added "eyes not hands" positioning, framework depth table, Chrome/Firefox parity table, Explorer limitations, SoM usage, agent config control docs.

### Fixed
- `injector.js` syntax error (escaped quotes from copy-paste).
- `archive_project.ps1` — strict analysis with unused variable detection, empty catch flagging, shadowing detection, redundant comparison removal.

---

## [3.0.0] — 2026-05-20

### Added
- Initial browser-whiskor v3 release.
- Chrome MV3 extension with service worker background.
- Firefox MV2 extension with event page background.
- MCP server with 29 tools (read, write, capture, control).
- 9 framework adapters (React, Vue 3, Vue 2, Angular, Svelte, Preact, Alpine, Solid, DOM-generic).
- 9 analyzers (text-coords, network, CSS, UI catalog, perf, DOM mutations, accessibility, console, storage).
- Autonomous page explorer (BFS/DFS/random strategies).
- State-transition graph builder.
- Config system with `.env` overrides.
- Cache layer with freshness tracking.
- DevTools panel for manual inspection.
- WebSocket bridge between extension and server.
- Zero npm dependencies beyond `ws`.
