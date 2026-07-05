# Premise-change feed — "the page moved while you weren't looking"

**Status:** design + v1 implemented (2026-07-05)

## Problem

An agent's mental model of a page is a snapshot: whatever the last read tool
returned. Pages keep living between tool calls — a websocket pushes a new row, a
timer opens a modal, another user scrolls a shared board. The agent then acts on
a premise that silently expired, and the failure surfaces two turns later as a
mysterious "clicked the wrong thing".

Two constraints shape the design:

1. **Attribution.** Changes *caused by the agent's own action* are already
   reported in that action's result (diagnosis, observed, dialogs). The feed
   must carry only what the agent did NOT cause — otherwise it duplicates every
   action report and drowns the signal.
2. **Delivery.** MCP is pull-only: the server cannot push a notification into
   the agent's context. The only channel that reliably reaches the agent is the
   response to the *next* tool call it happens to make.

## Design

### Attribution: the action-window rule

The worker (action-executor) knows exactly when an agent action is in flight:
from dispatch until ACTION_RESULT resolves, plus a short trailing grace window
(default 1500ms — the same indirect-attribution window the dialog guard uses)
for effects that land just after the result (fetch → re-render).

- Change arrives **inside** an action window (or its trail) → attributed to the
  agent's own action → **not** recorded. The action's own report covers it.
- Change arrives **outside** every window → external → recorded.

This is deliberately coarse. It cannot distinguish "the page reacted late to
your click" from "a websocket fired at the same moment" — no observer could
without page cooperation. Coarse-but-honest beats clever-but-wrong: the worst
failure mode is one redundant feed line, never a missed external change.

### Sources (v1)

All already flow into the worker in realtime; the feed adds no new collection:

| Signal | WS message | Feed entry |
|---|---|---|
| Scroll | `VIEWPORT_UPDATE` | **Coalesced**: one line with the FINAL position (and the position the agent last knew). A 40-event scroll burst is one entry. |
| Modal open/close | `DOM_MUTATION` records flagged by the analyzer | `[role=dialog]`/`[role=alertdialog]`/`<dialog>` appearing or disappearing — the page-level premise change that invalidates the most plans. |
| Navigation | `PAGE_NAVIGATED` | URL changed under the agent. |

The dom-mutations analyzer (shared/) sets `dialogAppeared` / `dialogRemoved` on
childList records; the server-side feed reads the flags. Everything else is
consumed as-is.

Not in v1 (candidates, same plumbing): console error bursts, network failures,
large DOM churn summaries, title changes.

### Buffer: per-tab ring, read-clears, dies with the tab

- Per-tab ring buffer, capped (default 50; overflow drops oldest and marks the
  feed truncated).
- **Drain-on-read**: delivering the feed clears it — "since your last look" is
  literal. Peek (non-destructive) exists for the pre-action premise check.
- `TAB_CLOSED` discards the buffer. No persistence — a premise is only a
  premise for a live tab someone is looking at.

### Delivery: piggyback on the next tool response

Precedent: `_systemMessage` (already attached to read-tool results). The feed
rides the same way: any MCP tool call whose args carry a `tabId` gets

```jsonc
"_sinceYourLastLook": [
  "[32s ago] modal opened: div.confirm-dialog",
  "[8s ago] scrolled: viewport now at (0, 1840), was (0, 300)"
]
```

attached to its result **when the tab's feed is non-empty** — zero footprint on
quiet pages. Attachment is central (registry.callTool), not per-tool, so every
current and future tool participates. In proxy mode the MCP process drains the
worker over `GET /api/changes/:tabId?drain=1`; standalone drains in-process.

HTTP-only agents poll the same endpoint directly.

### Pre-action premise check

The delivery above is retrospective; write actions also get a prospective gate.
`click` / `type_text` / `drag` accept `abortOnPremiseChange: true`: at dispatch
time the worker peeks the tab's feed, and if external changes are pending, the
action returns `aborted: 'premise_changed'` **without executing** — the changes
ride back on the same response. Off by default: most changes don't invalidate
most actions, and only the agent knows which premise its click depends on.
(Without the flag, pending changes still arrive on the action's response via
the piggyback — acting is never blind either way.)

## Config

`agentControl.changeFeed`: `{ enabled: true, maxEntries: 50, actionTrailMs: 1500 }`.
Enabled by default — the whole point is ambient awareness the agent didn't ask
for; the cost when nothing changed is zero bytes.

## Implementation map

- `server/change-feed.js` — ring buffer + action windows + coalescing (pure, unit-tested)
- `server/core.js` — source wiring (VIEWPORT_UPDATE / DOM_MUTATION / PAGE_NAVIGATED / TAB_CLOSED) + `GET /api/changes/:tabId`
- `server/action-executor.js` — action-window marking + `abortOnPremiseChange`
- `server/mcp/registry.js` — central `_sinceYourLastLook` attachment
- `server/index.js` — `_drainChanges` callback (in-process / proxy HTTP)
- `shared/injected/analyzers/dom-mutations.js` — dialog appear/disappear flags

## Related

- `docs/ideas/CLICK_EVIDENCE_AND_SOM_SCOPE.md` — plan/observed two-layer action
  reports: what YOUR action did. This feed is the complement: what you didn't do.
- `docs/ideas/VOICE_AND_NOTIFICATIONS.md` — same pull-only constraint, human
  direction: agent→human toast is push (host duty), page→agent stays piggyback.
