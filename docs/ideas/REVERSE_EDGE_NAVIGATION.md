# Speculative reverse edges — navigation beyond URL substitution

**Status:** S0–S2 implemented (2026-07-10); S3–S4 design only

## Problem

`navigate_to_state` finds a path by BFS over the state graph's **recorded,
directed** edges (`state-navigator.js findPath`). An edge exists only because
that exact transition was once observed: `a→b via click("設定")`. Nothing about
that observation produces the reverse edge — the control that leaves a state is
almost never the control that led into it (a "設定" button opens the panel; a
"×", Escape, or the browser back button leaves it). So in practice:

- Freshly-explored graphs are almost purely forward-directed. `b→a` exists only
  if someone happened to walk back while instrumented.
- When BFS finds no path, the navigator falls back to `navigate(url)` — which
  **resets SPA state** (form contents, scroll, store) and cannot reach states
  that don't map to a unique URL at all (modal open, wizard step 3, a canvas
  arrangement).

The observable symptom: navigation "works" but is effectively URL substitution
with extra steps.

## Insight

We don't need to *know* the inverse of a transition. We need **cheap candidate
inverses with a good prior**, plus verification — and the machinery for the
second half already exists:

- edges carry a `confidence` field, and `findPath` already filters on
  `minConfidence` (0.3),
- `navigate_to_state` already verifies every step against the target hash
  (`verifyEachStep`).

So the design is: **synthesize speculative reverse edges, let navigation try
them, verify by hash as it already does, and adjust confidence from the
outcome.** Edges are earned, not assumed.

## Design

### Candidate sources (priors, cheapest first)

| Basis | Candidate reverse action | Prior | Derivable from |
|---|---|---|---|
| The forward transition changed the URL (`node[a].url !== node[b].url`) | `go_back` | ~0.5 | Graph nodes already store `url` — no new collection |
| The forward transition opened a dialog (`dialogAppeared` on the mutation records) | `press_key Escape` | ~0.35 | dom-mutations analyzer already flags it; needs the flag stored on the edge at record time |
| A dismiss-looking control exists in state `b` (label ∈ 閉じる/×/close/cancel/戻る) | `click(text)` on it | ~0.3 | ui-catalog snapshot of `b` |

All three are heuristics and all three can be wrong — that is fine, because a
wrong candidate fails hash verification on first use and demotes itself below
`minConfidence`. The worst case is one wasted step during an explicit
`navigate_to_state` call, bounded by the existing `maxSteps`/`stepTimeoutMs`.

### Lifecycle: lazy generation, earned persistence

Speculative edges are **derived at `findPath` time**, not written into the
graph when a forward transition is recorded. Reasons:

- the graph stays a record of observations, not guesses — every persisted edge
  either happened or was verified to happen;
- priors can change without migrating stored graphs.

On traversal:

- **success** (step hash matched): persist the edge as a normal transition with
  `basis: 'speculative-history' | 'speculative-dismiss'` provenance and promote
  confidence (e.g. +0.2 per success, capped ~0.95);
- **failure**: demote below `minConfidence` in a small in-memory blacklist
  (per graph, per edge) so the same guess isn't retried every call; fall through
  to the next candidate, then to the URL fallback as today.

### BFS stays untouched

`findPath` just sees more edges. Two small biases keep behaviour sane:

- at equal path length, prefer observed edges over speculative ones (add a
  fixed cost penalty to speculative edges);
- hub routing needs no new code — as speculative edges fill in, `b→hub→a`
  paths appear naturally and the URL fallback stops being the common case.

### URL fallback becomes honest

Keep it as the last resort, but mark the result: `{ fallback: 'url',
note: 'SPA state was reset — reached the URL, not the recorded state' }`.
Today it reports success indistinguishably from a real path traversal.

## Strict and fuzzy navigation coexist

Reverse edges fix *reachability*; a second, orthogonal axis is *target
tolerance*. Today navigation is strict-only: the target is an exact
`compositeHash`, and a hash that drifted (dynamic content, a changed badge
count) makes the "same place" unreachable even when every human would say the
agent arrived. Both modes have real use-cases, so they should be explicit:

| | **strict** | **fuzzy** |
|---|---|---|
| Target | exact hash | best-equivalent state: `_findSimilarStates` score (tag Jaccard + label bigram + URL proximity) ≥ threshold — the ranking that already powers failure `suggestions`, promoted from "did you mean" to target resolution |
| Step verification | every intermediate hash must match (today's `verifyEachStep`) | intermediate steps tolerate hash drift (verify URL/keyState per step, exact-or-similar check on the FINAL state only) — dynamic content must not abort a path halfway |
| Reports | success = exact arrival, anything else fails | success carries `matched: 'fuzzy'`, the similarity score, and what differed — honest, never silently pretending exactness |
| Use-cases | replay_session, dev-exec harness runs, regression verification | goal-seeking agent navigation, stale graphs, semantic targets (`query: "設定画面"` → search_states → same pipeline) |

Neither replaces the other: replay stays strict by default; agent-facing
`navigate_to_state` defaults to strict target + fuzzy *fallback resolution*
(exact hash first; if it no longer exists or is unreachable, resolve to the
best equivalent and say so). A `mode` parameter makes the choice overridable
per call.

## S0 — the graph has no nodes (prerequisite, found 2026-07-10; implemented same day)

Live inspection of a long-running instance: **all 43 on-disk graphs have
`nodeCount: 0`** with up to 246 edges each (the only graph with nodes predates
the current wiring). Three stacked causes:

1. **Nodes are only written on the explorer path** (`_recordExplorerState`,
   fed by `EXPLORER_GET_NEXT_ACTION` / `EXPLORER_STATE_UPDATE`). Normal
   browsing never creates a node.
2. **Edges ARE written during normal browsing** — `REACT_TRANSITION` →
   `addEdge` fires on every debounced react commit — but its `from`/`to` are
   **reactHash**, while nodes are keyed by **compositeHash**. The two keyspaces
   can never join: those edges are permanent orphans.
3. `__SI_CURRENT_HASH__` (composite) is only maintained while the explorer
   runs, which is also why `observe` reports hash-unavailable in normal use.

Everything in this document assumes nodes exist, so S0 comes first:

- Maintain the composite hash passively: `react.js` already keeps
  `__SI_REACT_HASH__` fresh on every commit; extract the explorer's
  domHash/composite computation into a lightweight always-on helper.
- On transition, passively record node + edge **in the composite keyspace**
  (state-reporter or a small emitter → `addNode`/`addEdge`).
- `REACT_TRANSITION` stops writing graph edges (it keeps feeding the
  correlator — that use is keyspace-agnostic).
- Startup sweep: drop node-less graphs; they are unreadable edge skeletons.

As implemented: the engine lives in `state-reporter.js` (`__SI_HASH_ENGINE__`,
loaded before `explorer.js`, which now delegates instead of keeping a fork).
It polls (700ms) and holds a changed hash as a candidate until it settles
(800ms) — one `STATE_TRANSITION` per settled state. The server
(`core.js`) records the node and attributes the edge by best evidence: a
click within 3s of the change → replayable `click` edge with the clicked
text; a URL change → replayable `navigate` edge; otherwise an
`observed` edge with `replayable:false`, which `findPath` skips.
`sweepEmptyGraphs` runs at startup. Tests:
`tests/unit/state-transition-passive.test.js`.

## Slices

0. **S0 — passive node recording** (above). Without it the graph, the map
   (`/api/sessions/:tabId/map`, TUI `map`), and every navigation slice below
   render nothing outside explorer runs.
1. **S1 — history inverses.** `go_back` candidates from `node.url` differences.
   Zero new collection; touches `state-navigator.js` only (candidate
   generation + confidence update + blacklist). Biggest win for page-level
   states.

   As implemented: candidates are derived per `findPath` call (prior 0.5,
   real edges expanded first so an observed route wins at equal length;
   generated only when steps are verified). A verified guess is persisted via
   `addEdge` with `basis:'speculative-history'` — repeat successes then
   promote confidence through the normal count lifecycle. A failed guess
   (hash miss or action error) joins an in-process blacklist and triggers a
   bounded re-plan (max 3) from wherever the tab actually landed, falling
   through to the URL fallback, which now reports `fallback:'url'` + a note
   that SPA state was reset. Submit-shaped forwards (type_text, submit
   selectors, mutation-labeled triggers) are never inverted. Dry-run
   (`get_navigation_path`) marks speculative steps and counts them. Tests:
   `tests/unit/speculative-reverse-edges.test.js`.
2. **S2 — dialog dismissal.** Store `dialogAppeared` on the transition record
   (producer signal exists already), generate Escape candidates. Reaches the
   states URL fallback can never reach (modals, overlays).

   As implemented: the passive emitter samples dialog presence
   (`dialog/[role=dialog]/[role=alertdialog]`, same boundary the
   dom-mutations analyzer flags) at settle time and sets `dialogAppeared`
   on the transition; the edge keeps the flag sticky once seen. Candidates
   are `press_key Escape` (prior 0.35, `basis:'speculative-dismiss'`),
   generated even for submit-shaped openers — Escape dismisses UI, it does
   not fake an undo. Both bases share the earn/blacklist lifecycle.
3. **S3 — fuzzy target resolution.** Promote `_findSimilarStates` to target
   resolution with a `mode` parameter and honest `matched:'fuzzy'` reporting;
   relax intermediate-step verification to final-state-or-similar.
4. **S4 — dismiss-control heuristics + explorer pre-verification.** Label-based
   close-button candidates; optionally let the explorer verify speculative
   edges proactively so agent-facing navigation rarely pays the trial cost.

## Non-goals

- No general "undo" — this inverts *navigation*, not data mutations. A
  transition that submitted a form has no safe speculative inverse; `go_back`
  candidates should be skipped when the forward action was a submit-shaped
  action (type_text with submit, click on type=submit).
- No symmetric-edge assumption anywhere: reverse edges always go through the
  same verification as forward ones.
