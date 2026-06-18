# ASCII layout map — size/structure samples

> Canonical write-up & design rules: `../LAYOUT_ASCII_MAP.md`. This folder is the
> lab notebook — the raw samples and the measurements behind that note.

A cheap, every-turn spatial channel: render the page as a coarse ASCII grid with
ref-numbered interactive elements, so the agent always has rough spatial awareness
("search box top-center, filters left, results center, paging bottom") without
paying for a screenshot each turn. Not a screenshot replacement — a persistent
low-cost layout sense, with real screenshots reserved for when pixels matter.

This folder holds hand-drawn samples of the same two pages at decreasing grid
resolutions, to see how small the grid can get before structure breaks, and what
it actually costs in tokens.

## Measured sizes

Token estimates are ~chars/4 (BPE ballpark; treat as approximate). "grid-only"
excludes the legend.

| sample              | grid | full file | grid-only |
|---------------------|------|-----------|-----------|
| 01 search fine 58w  | 58×20 | ~376 tok | ~271 tok |
| 02 search medium 40w| 40×14 | ~171 tok | ~129 tok |
| 03 search coarse 24w| 24×9  | ~109 tok |  ~81 tok |
| 04 search ultra 16w | 16×7  | ~128 tok |  ~48 tok |
| 05 login medium 36w | 36×14 | ~178 tok | ~148 tok |
| 06 login coarse 22w | 22×9  |  ~99 tok |  ~82 tok |

Reference points:
- **Claude screenshot**: ~1,100–1,600 tokens per image (tile-based, size-dependent).
- **Full `get_text_coords` words[] dump** of a busy page: often 2,000–8,000+ tokens.

So a medium grid is ~1/8 of a screenshot and a fraction of a raw text dump.

## What the samples show

1. **The sweet spot is 40w (medium): ~130–170 tokens.** Cheap enough to attach
   every turn, and every result/control is still individually labelled and
   ref-clickable. This is the "毎ターン大雑把な位置関係" target.

2. **24w (coarse) ~100 tokens is the floor for "which item is which".** Region
   layout and ref markers survive; long titles truncate but stay distinguishable.

3. **16w (ultra) keeps only the zones.** "Search top / filters left / results
   center / paging+footer bottom" still reads, but individual result labels
   collapse. Answer to *"もう少し荒くても?"* — yes for *where are the regions*,
   no for *which result is the third one*. Below ~24w you're navigating by zone.

4. **Surprise: at coarse sizes the legend dominates, not the grid.** The ultra
   grid is only ~48 tokens but its file is ~128 — the ref→label legend is 60%+ of
   the payload. So the compression lever isn't the ASCII (it's already tiny); it's
   the legend. And the legend is essentially `ui-catalog` data. If the agent has
   already pulled `get_ui_catalog`, the grid can reference those same ref numbers
   and **ship without a legend** (the 48–130 "grid-only" column), making the
   per-turn map genuinely cheap.

5. **Whitespace rule is mostly free already.** These grids carry no trailing
   padding (right edge is the box border, not spaces). Interior space runs could
   be RLE'd, but at <150 tokens it costs legibility for little gain — the model
   reads the 2D arrangement better than a run-length encoding of it. Keep the grid
   literal; spend the compression budget on deduping the legend against ui-catalog.

## Design implication (if built)

- **viewport-relative, ~40w default**, dropping to ~24w on request for a cheaper tick.
- **interactive elements rendered as their `[n]` ref** (shared numbering with
  ui-catalog / packed SoM), so the map doubles as a spatial index: see layout →
  `click ref:n` with no coordinate lookup.
- **legend optional**, omitted when the caller already holds ui-catalog refs.
- **server-side renderer** (sibling of `state-visualizer.js`), built from data that
  already exists: `text-coords.json` (positions) + `ui-catalog` (refs/roles). No new
  collection, no extension change — just a quantize-and-place pass.
- **honest collisions**: two elements landing in one cell resolve by priority
  (interactive > text); overflow noted rather than silently dropped.

Related ideas: packed SoM (`[[project_packed_som_capture]]`), click-evidence /
SoM scope, MiniLM click-text matching.
