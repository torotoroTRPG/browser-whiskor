# Click evidence buffer + packed-SoM scope — fresh capture vs cached composition

**Status:** design / proposed (2026-06-17) — §"Two-layer action reports" implemented (2026-07-05)

## Two ideas, one decision

Two related capture ideas came up together, and the useful answer ties them:

- **A. Click-time evidence buffer** — on each click (or only on a failed click),
  auto-capture a tiny image of the click target and keep a short rolling history,
  so the agent can look back at *what it clicked* without issuing a separate
  capture call (which would be too late — the page has already changed).
- **B. Packed-SoM scope/target** — let `capture_packed_som` target a subset
  (a container/region, not just element `types`), and the question behind it:
  should packed SoM be **captured fresh from the current UI** each time, or
  **assembled from separately-captured, cached element thumbnails** (updatable)?

The decision: these are **not** "which is better" — they serve different goals
and should coexist. The dividing line is **freshness — "as of when?"**

## Decision: packed SoM stays fresh; the cache is a separate retrospective layer

### Packed SoM must be captured fresh (current design is correct)
Packed SoM exists to show *the elements you can act on, as they are now*. Click
accuracy depends on **every element being cropped from the same instant and the
same viewport** — one coherent snapshot. `capturePackedSom` already does this:
one `captureVisibleTab` bitmap, crop all interactive elements from it, pack. The
`som-cache` freshness layer reuses it only while the page is unchanged, so cost
is already bounded.

Assembling the packed image **from cached thumbnails** is the wrong trade:
- **Temporal Frankenstein** — element 3's crop is 2 minutes old, element 5 is
  current. If an element moved, was relabeled, or disappeared meanwhile, the
  image *lies about the current state* and the agent clicks on stale info.
- Separately-captured selectors/coords may no longer be valid.

So for the live action map, **fresh > composed**.

### The cache wins for a different job: retrospection (= idea A)
Caching individual element crops shines for *history and looking back* — "what
did the thing I clicked look like." The infrastructure already exists:
- `server/som-thumbnails.js` — per-element thumbnail cache (selector+size key,
  view-aware invalidation via `markChanged`, TTL 5 min, LRU 200).
- `server/screenshot-manager.js` `_storePackedThumbs` — a fresh packed capture
  already warms the per-element cache when `agentControl.packedSom.prefetchThumbs`
  is on.

Relationship: **one-directional** — a fresh packed capture *feeds* the
retrospective cache; the packed image is never *built from* the cache. That keeps
the live map honest while still populating history cheaply.

## Idea A in detail — click-time evidence buffer

Directly solves the documented `no_state_change` debugging pain
(`local_issues/2026-06-13_click-stateChanged-false-after-navigation.md`): by the
time the agent notices a click "failed" and wants to look, the UI has already
changed, so a fresh capture can't show the moment of the click. **Capturing at
click time freezes the evidence** — it cannot be reconstructed server-side later.

Design points:
- **Timing:** capture at/just-before the click, while the executor still holds
  the target rect — before any navigation tears the page down. This is the whole
  point and the part only the extension can do.
- **Size:** a small thumbnail (low-quality jpeg/webp). Small enough that "always
  capture" is affordable. Per-tab **rolling buffer of the last N** (e.g. 5),
  same discipline as the network/console ring buffers in `core.js`.
- **Always vs on-failure:** you can't know in advance which clicks you'll want to
  inspect, so *cheap + always-buffered* is the ideal. **MVP: failure-only**
  (`no_state_change` etc.), piggybacking the existing `observe` option on `click`.
- **Retrieval:** a read tool / HTTP endpoint (e.g. `get_click_history`), or fold
  a link to the latest evidence thumbnail into the click response so the agent
  doesn't issue a second call. **Return a link, not inline base64** (see the
  image-return discussion in
  `local_issues/2026-06-17_capture-image-cache-and-disk-leak.md`) so text-only
  agents never pay for pixels they can't use.

## Two-layer action reports (plan vs observed) — implemented 2026-07-05

The evidence buffer above answers "what did it *look* like"; a cheaper, structural
form of the same idea answers "what did the action *attempt* vs what *happened*" —
and it needs no pixels, so it ships on every action result unconditionally.

The report has two layers, and **the mismatch between them is the most important
information an action can return** — a completed synthetic event sequence over a
page that ignored it is the common silent failure, and `ok:true` alone hides it.

- **`drag`** now returns `plan` / `observed` explicitly:
  - `plan` — resolved *before* any event fires: `grabbed` (element descriptor),
    `from`/`to`, `dropTargetUnderPoint` (what sat under the destination).
  - `observed` — measured after an event-driven settle: `moved` (grabbed rect
    actually changed), `grabbedDetached` (re-render replaced the node — common
    for successful list reorders), `mutations` (MutationObserver count across
    the action), `stateChanged` (url/title/dialog fingerprint), and
    `dropReceivedBy` (what actually received the drop events).
  - Nothing observed → `_hint` says the page likely needs HTML5 DnD with a real
    DataTransfer / pointer events / trusted input.
- **`click`** already had this shape before it had the name: `clickability`
  (pre-flight analysis + strategy = the plan layer) and `diagnosis`
  (post-click fingerprint diff = the observed layer). No structural change —
  the two-layer reading applies as-is.

The click-time **evidence buffer** (idea A) remains the future pixel-layer
complement: plan/observed tells you *that* the page ignored a drag; the evidence
thumbnail would show *what the target looked like* at that moment.

## Idea B in detail — packed-SoM scope

A cheap addition to the fresh-capture path; does not touch freshness.
`capture_packed_som` already takes `types: button|link|input`. Add:
- `withinSelector` / `region` — restrict to elements inside a container or rect.

Implementation is a **client-side filter of the interactive-element list before
cropping** — the single-bitmap consistency is untouched. Also helps big pages
that overflow the 40-element cap drop the wrong elements.

## Summary

|                          | Fresh capture | Cached composition |
|--------------------------|:---:|:---:|
| Live action map (packed SoM) | ✅ consistent + fresh | ❌ Frankenstein / lies |
| Retrospection (click evidence) | ❌ too late to re-shoot | ✅ frozen evidence |

- Packed SoM: **keep fresh**; add scope filter (`withinSelector`/`region`).
- Add a **click-time evidence buffer** as a separate retrospective layer (MVP:
  failure-only; ideal: cheap always-on rolling buffer).
- Wire them **one-directionally**: fresh packed capture feeds the per-element
  cache (`_storePackedThumbs` already does); never build packed from the cache.

Not a from-scratch build — it opens the existing `som-thumbnails` cache to a
retrospective use and adds a click-time capture hook.

## Related
- `docs/ideas/PACKED_SOM_CAPTURE.md` — the fresh packed-SoM design this builds on.
- `docs/ideas/IMAGE_ASSET_CORRELATION.md` — retrospective image↔structure linking.
- `docs/理想機能メモ.md` item 10 (webp/AVIF) — thumbnail format; webp viable,
  AVIF not (canvas can't encode it).
