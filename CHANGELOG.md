# Changelog

All notable changes to browser-whiskor are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before v0.12.0 are recorded in the
[GitHub Releases](https://github.com/torotoroTRPG/browser-whiskor/releases) and
the git history; this file starts at the point a curated changelog was added.

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
