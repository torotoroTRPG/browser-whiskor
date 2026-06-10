# browser-whiskor — Tests

## Current Status

**406 automated tests** via `npm test` (all green), plus 9 Playwright E2E spec files that drive a real browser with the extension loaded.

| Category | Tests | Files | Scope |
|----------|-------|-------|-------|
| **Unit** | 373 | `tests/unit/` (43) | Server logic, WS routing, MCP tools, state hashing, secret guard, packed SoM, correlator, config safety |
| **Integration** | 28 | `tests/integration/` (6) | Server ↔ client flows, error recovery, multi-tab, secret-guard flow, source correlation |
| **Stress** | 5 | `tests/stress/` (1) | Large payloads, long sessions |
| **E2E (Playwright)** | 9 spec files | `tests/e2e/` | Real browser + loaded extension: injected collection, executor round-trip, packed SoM, secret masking, dashboard, full pipeline |

> Counts shift as tests are added; `npm test` output is the source of truth.

## Running

```bash
npm test                  # unit + integration + stress
npm run test:unit
npm run test:integration
npm run test:stress
npm run test:coverage     # with --experimental-test-coverage
npm run test:e2e          # Playwright (live environment required, see below)
```

The npm scripts go through `scripts/_run-tests.js`, which expands the test
directories into an explicit file list before handing them to `node --test`.
This is deliberate: bare directory arguments crash on Node 24
(`MODULE_NOT_FOUND`) and quoted glob patterns only work from Node 21, so the
explicit list is the only form that works on every Node version.

## Structural Guards

Two guards keep the suite honest (both run in CI and `scripts/validate.ps1`):

- **Hollow-test guard** (`scripts/_check-hollow-tests.js`, npm `check-tests`) —
  a unit test that never imports production code fails the build. Historically
  about half the unit suite tested inline re-implementations instead of the
  real modules; this prevents that from coming back. A test that legitimately
  needs no import (e.g. static source analysis) must carry a
  `// @allow-no-prod-import: <reason>` annotation.
- **Producer/consumer contract test**
  (`tests/unit/injected-server-contract.test.js`) — statically cross-checks
  every injected `emit` type against a server consumer (core routing /
  cache-writer cases). Adding a page-side producer without wiring the server
  fails immediately instead of silently dropping data. Intentionally
  unconsumed types live in an allowlist that is itself verified against the
  code (a stale entry also fails).

## Framework

**Node.js built-in `node:test` + `node:assert`** — zero dependencies, matches
project philosophy. Test files are ESM (`import`) that load the CommonJS
production modules via `createRequire`.

MCP tool tests use the `captureTools(registerFn)` pattern: register the real
tool handlers, then drive them with mock callbacks — the real handler code
runs, only the I/O boundary is mocked.

## Directory Layout

```
tests/
├── unit/            # *.test.js — one module/feature per file
├── integration/     # server fixture based flows
├── stress/          # load tests
├── e2e/             # Playwright specs (*.spec.mjs / .js) + helpers/
├── helpers/         # server-fixture, ws-client, mock-extension, port-pool, …
├── fixtures/        # static test data
└── archive/         # retired tests kept for reference
```

Integration tests run an in-process server on test ports (WS 17891 / HTTP
17892, via `helpers/port-pool.js`) with the cache redirected to `tests/tmp/`.

## E2E Notes (real browser)

- **Headed is required** — classic headless does not load MV3 extensions.
- Long E2E runs are best started **in a separate terminal** with
  `--reporter=list` so progress is visible live.
- Known pitfalls are documented in `docs/ROADMAP.md` (section D): per-document
  `window` state across navigations, `<all_urls>` not injecting into `data:`
  URLs (use http + route fulfill), and the dashboard WS path requirement.
- A stale `--mcp` process holding port 7892 makes tests talk to old code —
  kill the port holder and restart (`npm run stop`).
