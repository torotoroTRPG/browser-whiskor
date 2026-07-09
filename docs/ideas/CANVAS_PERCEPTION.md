# Canvas perception — declaring the DOM/pixel boundary, and a state-first canvas map

**Status:** Slice 1 (boundary flags) implemented (2026-07-04). Slice 2 (state-first
canvas map) implemented (2026-07-09): `server/canvas-map.js` + MCP `get_canvas_map`
(intelligence profile) + `GET /api/sessions/:tabId/canvas-map`. Slice 3 (synthetic
image) is design notes only.

## The problem

A `<canvas>` is a hole in every DOM-based sense whiskor has. Inside it there are no
elements, no text nodes, no mutations — `get_index`, `get_text_coords`,
`get_ui_catalog`, DOM-mutation deltas all go silent. The failure mode is not "the
agent gets an error"; it is *misreading silence*: the agent clicks into a canvas,
sees no DOM change, and concludes the click did nothing — when in fact it landed in
a region where DOM senses simply cannot report. Canvas-heavy apps (game boards,
whiteboards, editors, Unity/WebGL) make this the common case, not the corner case.

## Principle: declare the boundary, consistently, on every channel

Rather than one convenience field on one tool, this is a single rule applied
everywhere: **whenever a response touches the DOM/pixel boundary, say so.** The
flag is the action-side analogue of the viewport in/out signal — both are cheap,
verifiable redirections of the agent's next tool choice:

- viewport in/out → "can I act on it *now*?" (if out: scroll first)
- canvas in/out → "which *sense* observes this?" (if in: DOM senses end here —
  switch to framework state, `ocr_region`, or a screenshot)

The two axes are orthogonal; together they keep the agent from wasting turns on
tools that structurally cannot answer.

**Multiple canvases are first-class.** Pages routinely carry several (main board +
minimap + effect layers). Every check below scans *all* canvases, identifies each
one (document-order `index`, id/class selector, size), and reports every canvas
stacked at the probed point — never just "a canvas".

## Slice 1 — boundary flags (implemented)

Four touch points, one rule. Fields appear **only when they carry signal** (same
convention as `selectorAmbiguity` / `matchedBy`): no `canvas: false` noise on
normal pages.

### 1. Producer: `ui-catalog` emits `canvases[]`

`extension/injected/analyzers/ui-catalog.js` + `firefox-mv2/.../ui-catalog.js`
(**not** in `shared/` — edit both, see CLAUDE.md) collect every `<canvas>`:

```json
{ "index": 0, "id": "board", "classes": "…", "rect": {"x":0,"y":64,"w":800,"h":600},
  "bitmap": { "w": 1600, "h": 1200 } }
```

`rect` is CSS page px (same convention as buttons/inputs/links); `bitmap` is the
drawing-buffer size (`el.width`/`el.height`) — a large bitmap behind a small rect
hints at a high-DPI or zoomable surface. `counts.canvases` is added. The data
flows through the existing `UI_CATALOG` → `raw/ui/elements.json` path; no new
message type, so the producer/consumer contract is unchanged.

### 2. Actions: `canvas` note on click / right_click / hover

`shared/injected/executor.js` (`canvasNote()`), attached to success returns:

- **`hit: 'direct'`** — the resolved target *is* a canvas. The click was a
  coordinate shot into pixels; the response says so and points at the working
  senses (framework state / `ocr_region` / element screenshot).
- **`hit: 'overlay'`** — the target is a DOM element stacked **on top of** one or
  more canvases. Detected via `document.elementsFromPoint()` at the target's
  center (true z-order, not rect intersection — an element merely *near* a canvas
  does not fire). `under` lists every canvas in the stack.

`totalCanvases` is included when the page has more than one, so "which canvas" is
never ambiguous.

### 3. Layout map: canvas regions as shaded blocks

`server/layout-map.js` renders each canvas that intersects the viewport as a `░`
fill (its quantized rect) with a `#n` ref token at the region's top-left, and a
legend line `#n canvas 800×600 @cx,cy`. Interactive tokens draw **over** the fill
— matching reality, where HTML controls float above the canvas. This is the "gross
spatial awareness" channel doing exactly its job: *this part of the screen is
pixel-land* is a first-order fact about a page. Old catalogs without `canvases`
render exactly as before.

Note the inversion against LAYOUT_ASCII_MAP.md's borderless finding: for DOM
elements, a drawn box is redundant chrome (the ref token already carries
existence/kind/position). For a canvas region the extent **is** the information —
there is no DOM to fall back on — so here the region is drawn. Same principle
("spend characters only on signal"), opposite conclusion.

### 4. `find_target`: `overCanvas` + honest empty results

Candidates whose center sits inside a canvas rect get `overCanvas: [selector…]`.
When a query returns **zero** candidates and the page has canvases, the note says
so — "no match" and "the answer is inside a canvas where text search cannot see"
are different situations and the agent should not have to guess which one it is in.

### Limitations (v1)

- Canvases inside shadow DOM / iframes are not enumerated (same scope as the rest
  of ui-catalog).
- The overlay check probes the target's center point only.
- `find_target` uses collection-time rects (like every other hint it reports);
  the executor-side note is live.

## Slice 2 — state-first canvas map (implemented 2026-07-09)

The boundary flags say *where DOM senses end*. The next slice is a sense that works
past the boundary — an ASCII map of what is *inside* the canvas.

**State first, OCR as audit.** Canvas apps draw from structured state that already
sits in reach: a React/Redux store holding board objects with `x/y/w/h` (the
board app used for live verification is exactly this). whiskor already reads it (`get_framework_state`,
react-state-managers adapter). So the primary pipeline is:

```
framework state → spatial-object extraction → scale → quantize-and-place (existing renderer)
```

This beats OCR as the primary sense on every axis: cost (no capture/recognition),
and above all **identity** — state knows *which* piece sits at (x,y), who owns it,
and its non-visual attributes. OCR only ever sees pixels-that-are-text.

OCR's role is **verification**: when the computed placement is in doubt, `ocr_region`
(whose output is already `get_text_coords`-compatible words+boxes) checks that the
render agrees with the state — the same baseline/observed evidence pattern dev-exec
uses. Structured data is the truth for *existence*; pixels are the truth for
*presentation*.

**Scaling.** Crop to the content bounding box first (empty board margins are the
main whitespace source), then map to a fixed output width (layout-map's 40w
convention) preserving aspect ratio, with the CHAR_ASPECT (≈0.5) correction for
character cells being ~twice as tall as wide.

**Density ladder.** The space-RLE rejection in LAYOUT_ASCII_MAP.md was measured on
dense, fixed-width DOM grids; a px-scaled canvas map can be far sparser, which is a
different regime. Even there, the moves in order:

1. **Crop to content** — removes most whitespace, alignment untouched.
2. **Skip empty rows** with explicit labels (`rows 12–19: empty`) — column
   alignment intact within remaining rows.
3. **Coordinate list instead of a grid** — below some density, `[3] piece @12,8 2×2`
   per object (essentially a light projection of the state itself) beats any grid.
4. **Intra-row RLE** — last resort only: it is the one move that destroys the
   column-alignment read. In a sparse regime the loss is smaller (pieces are far
   apart, adjacency matters less), so it stops being categorically wrong — but
   crop + row-skip usually get there first.

A grid earns its cost precisely when the question is 2D gestalt — adjacency,
clusters, enclosure. Sparse → list; dense → grid; switch by measured density (the
generalization of LAYOUT_ASCII_MAP's "auto-pick width by density" open question).

### What shipped (v1)

`server/canvas-map.js` (pure, zero-dep) + MCP `get_canvas_map` (intelligence
profile) + `GET /api/sessions/:tabId/canvas-map` — one pipeline for both
surfaces, reading the framework snapshot via `server/framework-state.js`.

- **Discovery is a generic heuristic, app knowledge lives in the call.** The
  scanner walks the snapshot (node-budgeted; big production snapshots stop
  honestly) for three collection shapes: arrays of objects with a numeric
  coordinate pair, id-keyed maps (entity-adapter style; keys become fallback
  labels), and componentTree groups (≥3 same-named components whose props carry
  x/y). Score = count × field completeness × coverage. The best candidate is
  rendered; the rest come back as `candidates` for the agent to re-query with
  `path`. Per-app schema knowledge is a tool argument (`hints:
  {path, x, y, w, h, label}`, dotted accessors) — never server config, so the
  calling agent can learn it by exploration.
- **The store snapshot truncates; component props don't.** The extension's
  serializer cuts objects nested past its depth cap (`'[deep]'`), so a slice
  like `entities.<slice>.<id>.x` often arrives unreadable — but primitives pass
  the cut at any depth, so the same coordinates survive in per-piece component
  props. That is why `components.<Name>` is a first-class path dialect, and why
  truncation is reported (`STORE_DEPTH_TRUNCATED` warning / error hint naming
  the cut paths) instead of silently finding nothing.
- **Density ladder as designed**: crop to content bbox → auto grid/list by
  measured cell occupancy (sparse → coordinate list `[n] label @x,y w×h`,
  dense → grid with the same refs in a legend) → runs of ≥3 empty grid rows
  collapse to `(rows a-b empty)`. Explicit `form: grid|list` overrides;
  collinear/single-point layouts refuse the grid (no 2D signal to read).
- **Coordinates stay in store units** — cropped and normalized, so relative
  placement is faithful without the app's view transform. Every response says
  so. Applying the pan/zoom projection is a later hints extension.
- **Which canvas?** The agent says (`canvasIndex`, Slice-1 vocabulary); default
  annotation is the page's largest canvas. Identification only in v1 — the map
  is store-space, unprojected.
- When state is unreachable the tool returns an honest error pointing at the
  remaining pixel senses (`ocr_region` / screenshot); the OCR audit loop
  (baseline/observed comparison) is not built yet.

Live verification (a production React+Redux board app) exposed two extractor
preconditions that were fixed in the extension adapters, not worked around in
the map:

- **Store detection was name-matched, so production builds hid the store.**
  The Redux Provider fallback compared `getDisplayName(fiber.type)` against
  `'Provider'` — minified builds never match. Now duck-typed: any composite
  fiber whose `store` prop carries the getState/dispatch/subscribe trio.
- **Store serialization was too shallow for entity adapters.** `safeVal`
  capped object nesting at 3; Redux Toolkit keeps spatial state five levels
  down (`entities.<slice>.entities.<id>.x`). `safeVal` gained a
  backward-compatible `maxDepth` parameter (default 3 = old behaviour) and
  store captures start at 5, backing off per 2MB size guard. The map's
  truncation report is what located this: 38 `'[deep]'` paths before the fix,
  1 after.

One freshness caveat worth knowing: the React snapshot is commit-driven
(debounced `onCommitFiberRoot`), so right after a server restart an idle page
has no react file in the new session until something re-renders — and `auto`
may fall through to a lesser framework's false-positive snapshot. Any state
change (or a tab reload) delivers it.

## Choosing the representation — ride the priors, not the entropy

Design notes on the encoding itself, prompted by the obvious question: if a text
grid, why ASCII at a fixed width? Why not something denser — braille-pattern
graphics, run-length-encoded blanks, a custom binary-ish dialect — or no text at
all? The analysis keeps landing on one ground truth:

**The model never sees glyphs. It sees tokens.** A representation is only as
readable as the *token→spatial-meaning* association pretraining happened to build.
Human-visual density and model-visible density are unrelated axes. This single
fact settles most of the design space:

- **Braille patterns (U+2800–28FF)** carry a 2×4 dot matrix — 8 bits/char, the
  densest "text pixels" there are (cf. `drawille`). But the dot-matrix meaning of
  each codepoint has near-zero pretraining presence, and recovering it from the
  codepoint is bit arithmetic — the operation class LLMs are structurally worst
  at. Verdict: **write-only compression.** The model can emit it, never read it.
  (Quadrant blocks ▘▝▖▗ fail the same way; the shade ramp ░▒▓█ survives because
  progress bars gave it a real "density" prior — which is why Slice 1 fills
  canvas regions with `░`.)
- **ASCII pictures are weaker than they look, too.** Models are demonstrably poor
  at recognizing *shapes drawn in* ASCII art (the ArtPrompt jailbreak worked
  precisely because recognition is weak). What the monospace prior actually
  supports is reading **labeled tokens at aligned positions** — tables, code,
  "`[3]` sits row 3, right side". The layout map draws no shapes and places ref
  tokens: that is the readable half of the ASCII prior, kept deliberately.

### The FEN lesson — custom RLE, revisited

Chess FEN (`rnbqkbnr/8/…`) **is a blank-run-length-encoded grid**, and models read
it usably well. So RLE is not inherently unreadable — *RLE without a pretraining
prior* is unreadable. FEN works because millions of FEN strings taught the
association; a homegrown `{143}` dialect has zero presence, so the model must
simulate the decoder in-context: a per-turn reasoning tax, paid silently and
error-prone, exactly the cost the grid was supposed to avoid.

Base64 sharpens the boundary. It has *plenty* of pretraining presence, yet models
decode it unreliably — because decoding is bit-regrouping arithmetic, not symbol
lookup. FEN's `8` is consumed as the *meaning* "eight empty squares" (lookup);
base64 demands reconstruction (arithmetic). And `{143}` is the bad half: its whole
purpose is to let the reader *reconstruct 2D alignment*, i.e. arithmetic. Hence:

> **A custom convention is admissible when it reads as natural language + small
> numbers (lookup-shaped); inadmissible when it requires the reader to run a
> decoder (arithmetic-shaped).**

"rows 12–19: empty" passes. `{143}` fails. Fixed grid width, likewise, is not
intrinsically optimal — it is optimal *conditional on the alignment prior*, the
only prior that makes 2D relations readable for free; leave alignment (list/SVG
forms) and "width" stops being a concept at all.

### Inventory of usable priors

What pretraining actually carved in, deepest first:

1. **Numeric coordinates** — CSS, SVG, game code, math; saturated, and the model
   can do arithmetic on them. This is why the coordinate-list rung of the density
   ladder is strong.
2. **Monospace alignment of labeled tokens** — tables/code. The current map.
3. **SVG vocabulary** — `rect x= y= w= h=` / `circle cx= cy= r=`: enormous
   presence; effectively a coordinate list with a shape vocabulary. The canvas
   map's list form should borrow this dialect rather than invent one. (Spreadsheet
   A1 addressing is another deep prior, usable for naming grid cells.)
4. **Real images through the vision encoder** — see below.

### The synthetic-image channel (Slice 3 candidate)

For a multimodal client, the vision encoder is the one input path *actually tuned
for pixels* — so "render our data as an image and send that" is not a strange
idea; it is using the tuned channel. The cost is concrete: Claude vision costs
roughly `(w×h)/750` tokens, so a clean synthetic 512×512 map (white background,
black rects, large labels, zero noise) ≈ **350 tokens — the price of a fine ASCII
grid**, with genuinely better gestalt (adjacency, enclosure, clusters).

Honest caveats, and the shape they force:

- **Precision is lossy** — reading exact numbers/labels back off an image is
  unreliable. So the image never travels alone: **image = gestalt, coordinate
  list = precision**, the same pairing whiskor already uses for packed SoM +
  ui-catalog.
- **Rendering without dependencies** — the server is zero-dep and cannot rasterize
  SVG. But the renderer we already ship is *the browser*: draw the synthetic map
  into an offscreen canvas in the extension and capture it through the existing
  screenshot plumbing. No new dependency, one new draw call.
- Requires a multimodal client; the text forms remain the fallback.

### Decision table

| form | prior it rides | strength | verdict |
|---|---|---|---|
| labeled ASCII grid | monospace alignment | mid-density 2D relations | current; keep |
| coordinate list / SVG dialect | numbers, SVG | sparse, high precision | primary for canvas map |
| synthetic image (vision) | the vision encoder itself | dense gestalt | Slice 3; ~350 tok @512² |
| braille / quadrant blocks | (none) | — | rejected: write-only |
| custom RLE `{n}` | (none — FEN's prior is FEN's) | — | rejected unless lookup-shaped |

One-line summary of the whole section: **design to the model's inductive biases,
not to information theory** — and the biases point at numbers, SVG, alignment,
and real images, not at denser glyphs.

Related: [[project_layout_ascii_map]] (LAYOUT_ASCII_MAP.md — grid economics this
builds on), `ocr_region` (`server/services/ocr-service.js` — the audit sense),
[[project_local_vlm_element_labeling]] (a possible future extractor for non-text
canvas objects).
