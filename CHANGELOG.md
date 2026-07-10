# Changelog

All notable changes to browser-whiskor are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for v0.3.x–v0.11.0 live in [docs/changelog.md](docs/changelog.md)
(frozen); earlier releases are in the
[GitHub Releases](https://github.com/torotoroTRPG/browser-whiskor/releases)
and the git history.

<!--
  Entry template — release.yml extracts the `## [x.y.z]` section verbatim into
  the GitHub release notes, and FAILS a minor/major (x.y.0) release that has
  no section (patch releases only warn). Keep entries short: what a user
  notices, not the commit log.

  ## [x.y.z] - YYYY-MM-DD

  ### Added       (new capability)
  ### Changed     (existing behavior is different)
  ### Fixed       (it was broken, now it isn't)
  ### Security    (trust-boundary changes)
-->

## [0.16.1] - 2026-07-10

### Changed
- **Automated npm publish on release** — tagging a release now publishes
  `whiskor` to npm via OIDC Trusted Publishing (no stored token; provenance
  recorded). Idempotent (skips a version already on npm) and independent of
  the GitHub release step. Requires a one-time Trusted Publisher setup on
  npmjs.com.

### Security
- **Credential headers redacted by default** — `Authorization`, `Cookie`,
  `Set-Cookie`, `X-Api-Key` and kin now have their values replaced with
  `[redacted len=N]` at collection time, before anything is cached, shown on
  the dashboard, exported, or seen by an agent. Name-based, on by default
  (`network.redactAuthHeaders`), pinned as a committed public default. This is
  separate from (and independent of) the opt-in `privacy.secretGuard`, which
  also covers bodies and known values.

## [0.16.0] - 2026-07-10

### Added
- **`whk config preset dev`** — writes the enumerated developer-capability
  keys (`allowExecuteJs`, `allowAgentConfig`, `dev.exec.enabled`,
  `highFidelity=fallback`, `captureAllWorlds`, `actionDiff.auto`, packed-SoM
  prefetches) into `config.local.json`, printing every key it sets. Existing
  values win (`--force` to override), and newly added keys are only adopted
  when the command is re-run — deliberately not a master flag. Never touches
  `privacy.*` or dev-mode activation. A commented `config.local.json.example`
  ships alongside.

- **npm package** — published as [`whiskor`](https://www.npmjs.com/package/whiskor):
  `npm i -g whiskor && whk setup` installs the server + bundled extensions
  (loaded once from `~/.whiskor/`). The package ships an explicit `files`
  whitelist, pinned by tests.

### Changed
- Release notes are generated from this file's version section; a minor/major
  release without an entry now fails the release workflow (patches warn).

## [0.15.1] - 2026-07-10

### Changed
- README: pre-1.0 notice (interfaces move, updates may break behavior), a
  section comparing browser-whiskor with CDP-driven MCP servers, and stale
  counts fixed (72 tools, 876 tests). `whk help` catches up with the dev-mode
  commands and newer HTTP endpoints.

## [0.15.0] - 2026-07-10

### Added
- **Passive state recording** — the state graph now grows during normal
  browsing, not just explorer runs. An always-on hash engine in
  `state-reporter.js` reports settled composite-hash transitions; the server
  records nodes and evidence-attributed edges (recent click → replayable
  click edge, URL change → navigate edge, otherwise observation-only).
  Node-less orphan graphs from the old react-keyspace writer are swept at
  startup.
- **Speculative reverse edges** — `navigate_to_state` can go *back*.
  `findPath` derives verified-on-first-use reverse candidates: `go_back`
  (URL-changing transitions), `Escape` (dialog-opening transitions), and
  dismiss-looking close buttons. A guess that survives hash verification is
  persisted with `basis` provenance; a failed one blacklists itself and
  triggers a bounded re-plan. Submit-shaped transitions are never inverted.
- **Navigation modes** — `navigate_to_state({mode})`: `strict` (exact hash or
  nothing), `auto` (default; resolve an unreachable target to the best
  reachable equivalent, reported as `matched:"fuzzy"` with similarity), or
  `fuzzy` (also accept a similar final state). The URL fallback is now marked
  `fallback:"url"` — it resets SPA state and no longer masquerades as arrival.
- **`get_canvas_map`** — render what is inside a `<canvas>` from framework
  state (auto-discovers numeric x/y in stores, grid/list by density).
- **Action-anchored diff** — `diff:true` on page actions attaches `_diff`,
  the element-level change since the agent's last look
  (`agentControl.actionDiff`).
- TUI: popup rows get a full-width background band (readable over a
  translucent terminal); `→` field-edit opens on already-filled values with
  `Ctrl/Alt+↑↓` numeric stepping.

### Fixed
- Delta pipeline field drift (`get_delta` content updates/appearances were
  always empty); production-build Redux store detection in the React adapter;
  orphaned content scripts after an extension reload no longer spam
  "Extension context invalidated" into the page console.

## [0.14.0] - 2026-07-09

### Added
- **Interaction lifecycle batch** — `unhover` (close hover-opened UI),
  `while:{keys}` declarative holds on `click`/`drag`, a two-layer
  plan/observed report on `drag`, and the **premise-change feed**: external
  page changes (scroll, modal open/close, navigation) that happen outside
  your own action window ride along on the next tool response as
  `_sinceYourLastLook`; `abortOnPremiseChange:true` turns it into a
  precondition gate. HTTP: `GET /api/changes/:tabId`.
- `GET /api/sessions/:tabId/layout-map` — the ASCII layout map over plain HTTP.

## [0.13.0] - 2026-07-09

### Added
- **Canvas perception, slice 1** — DOM/pixel boundary flags: responses warn
  when the visible content lives in a `<canvas>` the DOM tools cannot see.
- **All-worlds console tap** (`agentControl.console.captureAllWorlds`,
  Chrome, off by default) — capture console/exceptions from every extension
  world via CDP, closing the blind spot around other extensions' content
  scripts.

### Changed
- GitHub Pages deploys via a path-filtered workflow (`docs/**`).

## [0.12.0] - 2026-07-04

### Fixed
- **Page actions timed out on every call (regression since v0.4.0).**
  `click`, `type_text`, `execute_js`, scroll and other page actions ran in the
  page but always came back as a 15 s `Page action timeout`. The page's reply
  (`ACTION_COMPLETE`) nests its fields inside `payload`, but the background
  listener in `executeInPage()` matched `message.listenerId` / `message.ok` at the
  top level, so the reply never matched its pending action. Fixed on both Chrome
  (`extension/background/sw.js`) and Firefox (`firefox-mv2/background/background.js`)
  by reading from `message.payload` (tolerating a flat shape too). See
  [docs/postmortems/2026-07-04-action-timeout.md](docs/postmortems/2026-07-04-action-timeout.md).
- dev-exec verdict engine: the settle `MutationObserver` now starts at baseline
  (before the module evaluates), so a module's own synchronous DOM changes count
  toward its verdict instead of being scored `clean`.

### Added
- **dev-exec (experimental, off by default).** Run a pre-bundled, self-contained
  ES module on the real page runtime and get a 5-value verdict back
  (`clean | effect | regressed | blocked | inconclusive`) with evidence.
  - Operator-gated dev mode: `whk dev on|off|status`, TTL expiry, toolbar badge,
    and absence from `tools/list` while off ("absence principle").
  - Three intake paths: inline `code`, a file `path` confined to
    `dev.exec.fileRoots`, or a pushed artifact (`POST /api/dev/artifact`).
  - Verdict evidence: new console errors, uncaught exceptions, state transition,
    DOM mutation count; persisted to `cache/sessions/{tabId}/dev/verdicts.jsonl`.
  - Audit-before-ack log per tab (`dev/audit.jsonl`); artifact bodies are never
    stored (hash + name only).
  - Inert unless you set `dev.exec.enabled: true` in `config.local.json` **and**
    run `whk dev on`. Design: `docs/vision/whiskor-for-dev/dev-exec.md`.

[0.12.0]: https://github.com/torotoroTRPG/browser-whiskor/releases/tag/v0.12.0
