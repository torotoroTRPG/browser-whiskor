# Contributing to browser-whiskor

## Setup

```bash
npm install
npm start          # server (supervised) — HTTP :7892 + WS :7891
```

Load the extension: Chrome → `chrome://extensions` → Developer mode → "Load
unpacked" → `extension/`. Firefox → `about:debugging` → Load Temporary Add-on →
`firefox-mv2/manifest.json`.

## Project rules that will save you a bad day

### `shared/injected/` is the canonical source — but only partially

Files that exist under `shared/injected/` (collector / executor / explorer /
state-reporter / all adapters / 8 analyzers / lib) must be edited **there**,
then synced to both extensions:

```powershell
.\scripts\sync-shared.ps1
```

Files **not** in `shared/` — 7 analyzers (`text-coords`, `network`,
`css-origin`, `source-fetcher`, `ui-catalog`, `framework-dom-map`,
`clickability`), `plugin-system.js`, `bridge.js`, and everything under
`background/` — must be edited **directly in both** `extension/` and
`firefox-mv2/`. The two sides have diverged in places; read both before
editing.

### The proxy is the production configuration

In real use the agent talks to a thin MCP **proxy** process that forwards over
HTTP to the worker. Anything wired only into the MCP layer
(`setXxx` callbacks in the non-proxy branch of `server/index.js`) silently
does nothing in production. Features that must work everywhere belong at a
**worker-side choke point** (`action-executor.execute`,
`screenshot-manager`, `core.routeMessage`) that every path goes through. This
class of bug has happened repeatedly — check both branches of `index.js`.

### Producer/consumer contract

If injected code `api.emit(NEW_TYPE, …)`s something, the server must consume
it (`core.routeMessage` + `cache-writer`). The contract test
(`tests/unit/injected-server-contract.test.js`) fails otherwise — that is it
working as intended, not an obstacle.

### Adapter support tiers

See [Maintenance Policy](README.md#maintenance-policy) for which framework
adapters are repair-guaranteed (React, Vue 3, the DOM-generic layer) vs.
best-effort (Vue 2, Angular, Svelte, Preact, Alpine.js, SolidJS). Bug reports
against a best-effort adapter are welcome, but a fix isn't guaranteed on any
timeline — a PR is the fastest path.

## Coding style

- **CommonJS** (`'use strict'`, `require`/`module.exports`). No ESM in
  production code (tests are ESM).
- **Extension side is zero-dependency** vanilla JS.
- ESLint: `ecmaVersion: 2022`, `no-var`, `prefer-const` (warnings).
- Comments are often bilingual (`_comment_en` / `_comment_ja` in JSON).

## Tests

```bash
npm test                  # unit + integration + stress — must be green
npm run test:e2e          # Playwright, needs a headed browser + extension
```

- Unit tests must exercise the **real modules** — the hollow-test guard
  (`npm run check-tests`) fails tests that never import production code.
- See `tests/README.md` for structure and patterns.

## Before pushing

```powershell
.\scripts\validate.ps1
```

This checks YAML lint, `shared/` sync, version consistency, file structure,
and test integrity. CI runs the same checks plus the full test suite.

## Versioning & releases

`package.json` is the single source of truth. Never edit manifest versions by
hand — use:

```bash
npm version patch   # or minor / major; syncs both manifests, commits, tags
git push --follow-tags   # the v* tag triggers release.yml
```

## Documentation

`docs/ROADMAP.md` tracks done/remaining work with file pointers.
`docs/changelog.md` keeps an `[Unreleased]` section — add your change there.
Keep doc tone factual and free of self-promotion.
