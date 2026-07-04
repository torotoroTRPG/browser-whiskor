# Post-mortem: page actions timed out on every call (v0.4.0 – v0.11.2)

**Date:** 2026-07-04
**Fixed in:** v0.12.0 (`6f386b7`)
**Severity:** high — every page action was unusable, but silently
**Introduced in:** v0.4.0 (`592ab78`, 2026-06-01)

## Summary

From v0.4.0 through v0.11.2, every page action routed through `executeInPage`
— `click`, `type_text`, `execute_js`, scroll, `press_key`, and later
`exec_module` — appeared to fail with `Page action timeout` after 15 seconds,
**even though the action actually ran in the page.** Only the acknowledgement was
lost; the click/type had already taken effect.

## How an action round-trips

```
server ──WS──▶ background (EXECUTE_ACTION)
                 │  executeInPage(): chrome.scripting.executeScript(world:MAIN)
                 ▼  injects window.postMessage({ type:'EXECUTE_ACTION_IN_PAGE', payload, listenerId })
        MAIN-world executor.js  ── runs the handler ──▶
                 │  window.postMessage({ type:'ACTION_COMPLETE', payload:{ listenerId, ok, result, error } })
                 ▼
        ISOLATED-world bridge.js ── chrome.runtime.sendMessage({ from:'collector', type, payload }) ──▶
                 ▼
        background executeInPage() listener  ── match on listenerId, resolve/reject
```

The executor runs in the **MAIN world**, where `chrome.runtime` is unavailable, so
it can only reply via `window.postMessage`. `bridge.js` (ISOLATED world) relays
that to the background, forwarding **`event.data.payload`** as `message.payload`.

## Root cause: a fix that was silently reverted during a refactor

The relevant fields (`listenerId`, `ok`, `result`, `error`) live inside
`payload`, so the background listener must read `message.payload.listenerId`.

This was **already understood and correctly handled**:

- `233f03c` (2026-05-22) — *"Fix ACTION_COMPLETE relay: … SW reads payload.listenerId"*
  changed the listener to `message.payload?.listenerId === listenerId` and read
  `message.payload.ok/result/error`. Correct.
- `679210f` (2026-05-26) — nested the executor's reply fields inside `payload`
  (with a comment: *"bridge.js forwards event.data.payload … so we must nest …"*).
  Both ends now agreed: reply nested in `payload`, background reads `payload`.

Then it regressed:

- `592ab78` (2026-06-01, **v0.4.0**) refactored `executeInPage` to add a shared
  `finish()` helper and a `navListener` (treat an in-flight main-frame navigation
  as a soft success). While rewriting the `listener()` body, the condition was
  re-typed as `message.listenerId` / `message.ok` / `message.result` — **dropping
  the `.payload` accessor that `233f03c` had added.** This was collateral of the
  rewrite, not a deliberate change: the diff's intent was navigation handling.

From that commit on, `message.payload.listenerId` was undefined at the top level,
so `ACTION_COMPLETE` never matched a pending action and every action waited out
`PAGE_ACTION_TIMEOUT`.

## Why it went unnoticed for ~5 weeks

1. **The action still executed.** Only the reply matching broke, so a human
   watching the browser saw the click/type happen — the failure was only in the
   tool's return value.
2. **`navListener` masked the common case.** v0.4.0 added a soft-success path for
   actions that trigger a navigation. A click on a link/router target resolves via
   that path (`onCommitted`), *not* via `ACTION_COMPLETE` — so the most-demoed
   action (click that navigates) "worked", hiding the broken non-navigating path.
3. **No round-trip test.** Unit/integration tests cover server logic and page-side
   logic in isolation; nothing exercises background ↔ page ↔ background end to end,
   so the mismatch was invisible to CI.

## The fix (v0.12.0, `6f386b7`)

Read the reply fields from `message.payload`, tolerating a flat shape too so the
two ends cannot silently drift apart again:

```js
function listener(message) {
  if (message.type !== 'ACTION_COMPLETE') return;
  const r = message.payload || message;      // nested (current) or flat (defensive)
  if (r.listenerId !== listenerId) return;
  if (r.ok) finish(true, r.result);
  else finish(false, new Error(r.error || 'Action failed'));
}
```

Applied identically to the Firefox background listener.

## Follow-ups

- [x] Add a background↔page round-trip test (or an e2e action assertion) so a
      reply-shape mismatch fails CI. Done as `tests/unit/action-complete-envelope.test.js`
      — a source-driven contract test (same style as
      `tests/unit/injected-server-contract.test.js`) that asserts the executor keeps the
      reply fields nested under `payload`, that `bridge.js` forwards only `payload`, and
      that each background listener reads them from `<msg>.payload` and reads only fields
      the producer emits. Negative-verified: reverting the producer to the v0.4.0 flat
      shape fails the checks. A live Playwright e2e that drives a real click/type and
      asserts success-not-timeout remains a nice-to-have on top of this.
- [x] Consider a single shared constant/helper for the `ACTION_COMPLETE` envelope shape
      so the executor (producer) and background (consumer) can't disagree. Considered —
      a *runtime* shared constant isn't feasible without a build step: the MAIN-world
      injected executor and the two extension backgrounds (service-worker / background
      page) can't `require()` a common module, and each browser keeps its own copy. The
      static contract test above is the enforcement point instead: the envelope shape is
      declared once (its `CONTRACT`) and every copy is checked against it. Same class of
      "producer/consumer drift" the contract tests already guard for collector emits.
