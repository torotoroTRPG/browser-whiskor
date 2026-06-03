# Packed Set-of-Marks capture — element-only visual for the agent

**Status:** design / proposed (2026-06-04)

## Goal

Give the agent a compact picture of *just the interactive elements* (buttons,
links, inputs) instead of a full-viewport screenshot. Each element's pixels are
cropped from the real page and packed tightly into one image, each tagged with a
Set-of-Marks number. The agent reasons over the packed image ("the Login button
looks like X") and acts by number; the server maps the number back to the real
selector/coords and clicks.

**Why:** a full screenshot spends most of its pixels (and tokens) on whitespace
and non-interactive chrome. Packing only the actionable elements is far smaller
while keeping *visual* confirmation (which plain tag+coords listings lose). It is
opt-in and the agent decides when to use it.

Scope: ordinary point-and-click flows. Out of scope: drag-and-drop and other
gestures that need true on-page geometry.

## Key idea: crop + pack in the extension via canvas

browser-whiskor is dependency-light; decoding/encoding/cropping images in Node is
heavy. We avoid it entirely: the **extension** already gets a viewport bitmap from
`chrome.tabs.captureVisibleTab`. A `<canvas>` can `drawImage(srcImg, sx,sy,sw,sh,
dx,dy,dw,dh)` to crop each element's rect from that bitmap and blit it into a
packing grid — crop and pack in one step, no Node image libs. `canvas.toDataURL`
yields the packed image. The server only ever sees the finished image + a map.

## Building blocks that already exist

- `collectElements` (extension/background/sw.js) — interactive elements + rects,
  already used for SoM marks on `capture_screenshot(marks:true)`.
- `get_ui_catalog` / text-coords — element rects + selectors server-side.
- `capture_element_screenshot` / `screenshot-manager.captureElement` — single
  element/rect capture (proves the crop path).
- `capture_screenshot(marks:true)` — the SoM number overlay + `elements` map.

## Flow (slice 1)

1. Agent calls `capture_packed_som({ tabId, max?, types? })`.
2. SW: `captureVisibleTab` once → one viewport bitmap. Read interactive elements
   (collectElements) with their viewport rects.
3. SW: for each visible element (cap at `max`, e.g. 40), `drawImage` its rect from
   the bitmap into a bin-packed grid on an offscreen canvas. Cell size ∝ the
   element's physical px size, downscaled to a low-quality target to stay small.
   Draw the SoM number in each cell.
4. SW returns `{ image: dataURL, marks: [{ n, selector, rect:{x,y,w,h}, text }] }`.
5. Server returns the image (as an MCP image block) + the marks map (no pixels in
   text). The agent says "click 7"; the server resolves mark 7 → selector/rect and
   runs the existing click action (reusing executor / coords).

Bin packing: shelf/next-fit by descending height is enough for slice 1 (elements
are small, near-uniform rows). Record each cell's packed rect only if we ever want
to map a click *on the packed image* back — but the agent clicks by **number**, so
packed geometry is internal.

## Caching + prefetch (later slices — concept 2)

- **Per-element LRU cache** (bounded): cache each element's crop keyed by a stable
  signature (selector + size + a cheap pixel hash). View-aware: drop when the
  element leaves the viewport, the session closes, or it hasn't been referenced by
  any whiskor MCP call (click/search/text-coords) for N turns. Elements beyond the
  cap are captured lazily on first reference.
- **Re-visit prefetch:** returning to the same parent URL (or a structurally
  similar screen), warm the cache in descending order of past reference frequency
  (fuzzy-search / text-coords / click counts).
- **Global usage stats (cross-session, shared):** accumulate which labels get
  acted on ("Login", "Sign up", "Start", "Continue"…) so that on a fresh page we
  anticipate where the agent is likely to go and prefetch those first. Stats are
  *common* across sessions; an identity-tagged whiskor ([[project_instance_identity]])
  may keep its own bucket. Map visible elements → stats by normalized label.

## Config

```jsonc
"capture": {
  "packedSom": {
    "enabled": false,        // opt-in; the agent chooses when to use it
    "maxElements": 40,
    "cellMaxPx": 96,         // downscale target per element (low quality)
    "cache": { "enabled": false, "maxEntries": 200 },
    "prefetch": { "enabled": false, "useGlobalStats": true }
  }
}
```

## Phasing

- **Slice 1:** `capture_packed_som` — collect elements, canvas crop+pack+number in
  the SW, return image + marks map; wire "click N". Server-side map + the SW canvas
  packer. (Pixel work is in the extension; the server side and the mark→action
  mapping are unit-testable.)
- **Slice 2:** per-element LRU cache + lazy capture beyond the cap (view-aware
  eviction).
- **Slice 3:** global usage-stats store + prefetch ordering.

## Open questions

- DPR: captureVisibleTab is CSS-px × devicePixelRatio; element rects are CSS px —
  scale source rects by dpr when cropping (the element-capture path already deals
  with this).
- Off-viewport elements: slice 1 only packs what's visible; lazy capture (slice 2)
  handles the rest, possibly by scrolling them into view first.
- Cross-browser: Firefox MV2 uses `browser.tabs.captureVisibleTab` + executeScript
  the same way — the canvas packer is plain page JS and ports directly.
- Relation to [[project_secret_guard]]: redacted regions must be masked in the
  packed crops too (reuse findRedactedRects rects, skip/black those cells).
```
