# ASCII layout map — a cheap every-turn spatial channel

**Status:** v1 implemented (2026-06-24) — `server/layout-map.js` + MCP `get_layout_map` (core profile).

**v1 が満たすもの:** viewport 相対グリッド、interactive 要素を kind 形状の ref トークンで配置（`[n]`=button / `{n}`=input / `<n>`=link）、reading 順の安定番号、borderless 既定（`border:true` で枠）、legend 任意（ref→kind+label+中心座標）、衝突は右シフト→収まらなければ legend で `⚠offgrid` 明示、viewport 外は除外してカウント。`width` 既定40（12-120）。データは既存の `raw/ui/elements.json`＋`raw/visual/viewport.json` のみ（新規収集なし）。テスト: `tests/unit/layout-map.test.js`（8）。
**v1 で見送り（将来）:** grid 内ラベル（今は legend のみ）、text-coords によるテキスト領域アンカー、ui-catalog との共有 ref（現状は地図内ローカル番号）、scroll above/below-fold ヒント、密度に応じた width 自動選択。

---

（以下は当時の設計メモ。Status: design / proposed (2026-06-17)）

## The idea

Give the agent a coarse text rendering of the page each turn: a monospace ASCII
grid where regions sit roughly where they are on screen, and interactive elements
appear as their `[n]` ref number. The point is *gross spatial awareness* —
"search box top-center, filters left, results center, paging bottom" — not pixel
fidelity.

This is **not a screenshot replacement.** A screenshot is ~1,100–1,600 tokens and
carries real visual detail; a full `get_text_coords` words[] dump of a busy page
is 2,000–8,000+ tokens. The layout map aims for ~80–170 tokens — cheap enough to
attach on *every* turn as a persistent sense of "where things are," reserving real
screenshots for when pixels actually matter (visual bugs, exact rendering).

The value multiplier is the **ref numbering**. If each interactive element renders
as the same `[n]` ref used by `ui-catalog` / packed SoM, the map doubles as a
*spatial index*: the agent sees the layout and acts with `click ref:n`, no
coordinate lookup. It ties three existing systems (ui-catalog refs, text-coords
positions, packed-SoM numbering) together with a render pass — no new collection.

Worked samples at several resolutions live in `layout-ascii-samples/`.

## How small can the grid get? (measured)

Token figures are ~chars/4 (BPE ballpark; approximate). "grid-only" excludes the
ref→label legend.

| resolution      | grid  | full | grid-only |
|-----------------|-------|------|-----------|
| fine    58w×20  | dense | ~376 | ~271 |
| medium  40w×14  | comfy | ~171 | ~129 |
| coarse  24w×9   | tight | ~109 |  ~81 |
| ultra   16w×7   | zones | ~128 |  ~48 |

- **40w (medium) ≈ 130–170 tok is the sweet spot.** Every result/control is still
  individually labelled and ref-clickable, cheap enough for every turn.
- **24w (coarse) ≈ 100 tok is the floor for "which item is which".** Region layout
  and refs survive; long titles truncate but stay distinguishable.
- **16w (ultra) keeps only the zones** — "search top / filters left / results
  center / paging+footer bottom" still reads, but individual labels collapse.
  Below ~24w you navigate by zone, not by item.

A surprise from the measurements: **at coarse sizes the legend dominates, not the
grid.** The ultra grid is ~48 tokens but its file is ~128 — the ref→label legend
is 60%+ of the payload. The legend is essentially `ui-catalog` data, so when the
caller already holds ui-catalog refs the map can ship **without a legend** (the
grid-only column). That, not character tricks, is the real compression lever.

## Rendering rules — what to compress, and what not to

The instinct to "compress repeated spaces" is the one optimization that *backfires*.
Grounded in how BPE tokenizes and in char-share measurements of a 40w grid:

**Whitespace is already cheap.** BPE merges runs of spaces into a few tokens, so
"1 space = 1 token" is false; an 8-space run is ~1–2 tokens. There is little to
reclaim by RLE-ing it.

**RLE of spaces backfires twice:**
- *Tokens* — replacing `········` (one whitespace token) with `{8}` swaps a merged
  token for digits + delimiters, which **don't** merge (~3 tokens). Fewer chars,
  same-or-more tokens.
- *Comprehension (the bigger loss)* — the grid's whole value is the monospace **2D
  alignment**; the model infers "A is left of B" from literal column positions. Any
  reflow/RLE destroys that alignment → you keep the tokens and lose the spatial
  signal. Worst of both.

**The fat is the borders, not the spaces.** Char-share of a 40w grid:

| | share |
|---|---|
| spaces | 22% (and BPE-cheap) |
| border `+-\|` | **35% (largest)** |
| content | 41% |

Borders are the biggest chunk and carry almost no spatial signal. Dropping them
(blank-line / indentation separation instead) measured **−38% chars on the grid
with alignment unchanged** (sample `07-search-borderless-40w.txt`: 515→319 chars,
~129→~80 tok). That recovers what space-RLE was chasing, without breaking the 2D
read.

**So the optimization order is:**
1. Strip trailing whitespace (free, no alignment loss — grids already do this).
2. Drop / lighten borders (−38%, no alignment loss). This replaces space-RLE.
3. Lower the resolution — fewer cells is the true lever, alignment preserved.
4. Dedup the legend against ui-catalog (the dominant cost when coarse).

All four cut tokens while keeping — or improving — the model's spatial read.
Character-level RLE is the only candidate that trades comprehension for nothing,
so it is explicitly **out**.

## If built

- **Server-side renderer**, sibling of `state-visualizer.js`, fed by data that
  already exists: `text-coords.json` (positions) + `ui-catalog` (refs/roles).
  No new collection, no extension change — a quantize-and-place pass.
- **viewport-relative, ~40w default**, droppable to ~24w for a cheaper tick.
- **borderless by default** (zones separated by blank lines / indentation).
- **interactive elements as their shared `[n]` ref** → map is also a click index.
- **legend optional**, omitted when the caller already holds ui-catalog refs.
- **honest collisions** — two elements quantizing to one cell resolve by priority
  (interactive > text); overflow is noted, never silently dropped.
- **z-order / nesting flatten** — accepted loss; this is a map, not a DOM.

Exposed either as an option on an existing read (e.g. a `layout: ascii` mode) or a
small dedicated tool; the renderer is the same either way.

## Open questions

- Best default width, and whether to auto-pick by element density.
- Label budget per cell vs always-ref-only + legend.
- Whether to mark the current scroll position / above-and-below-fold hints.
- Whether a borderless grid still reads cleanly when regions are irregular (the
  samples are tidy; real pages are messier — needs a check on a few live pages).

Related: packed SoM ([[project_packed_som_capture]]), click-evidence + SoM scope
(`CLICK_EVIDENCE_AND_SOM_SCOPE.md`), MiniLM click-text (`MINILM_CLICK_TEXT_MATCHING.md`).
