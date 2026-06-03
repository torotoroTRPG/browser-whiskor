# Secret Guard — Redaction of sensitive data from the agent

**Status:** design / proposed (2026-06-03)
**Threat model:** *the user does not necessarily trust the agent.* browser-whiskor
gives an AI agent deep perception into a real browser session, which may contain
the user's own secrets (passwords, email, tokens, PII) that happen to be on
screen, in the DOM, in network bodies, console, or storage. The agent — and any
log or cache file the agent could later read — must not receive those secrets.

## Core principle: redact on the server, never put secrets in the page

All detection and substitution happens in the **Node server**, never in the
page (MAIN world). Consequences:

- **XSS / hostile-page exfiltration is impossible by construction** — the secret
  values never enter the browser, so a malicious page cannot read them.
- **The agent can't reach them** — the agent talks to the server; the server
  redacts before emitting.
- **Logs and cache stay clean** — redaction happens at ingestion, before
  persistence or logging.

The page is only ever told *geometry* (for screenshot masking), never *what* or
*why*.

## The one chokepoint

Every collected-data message funnels through a single line in
`server/core.js#handleMessage`:

```
case 'TEXT_COORDS': case 'UI_CATALOG': case 'DOM_SNAPSHOT':
case 'NETWORK_REQUEST': case 'NETWORK_RESPONSE': case 'CONSOLE_LOG':
case 'STORAGE_SNAPSHOT': case 'REACT_SNAPSHOT': ... :
    await this.cache.handleMessage(msg);     // <-- redact msg.payload right here
```

Redacting `msg` at the **top of `handleMessage`**, before logging / dashboard
broadcast / persistence, makes cache + agent + logs clean in one place. A new
module `server/secret-guard.js` owns the logic; `core.js` calls
`secretGuard.redactMessage(msg)` once on entry.

## Detection sources (phased)

1. **Known-value blacklist (phase 1, MVP).** The user pre-registers exact
   strings (their email, password, tokens). The server loads them from a
   git-ignored source the server reads but never emits — `.env`
   (`WHISKOR_SECRETS=...`) or `secrets.local.json` — into memory only. Match by
   substring over collected text/values and replace.
2. **Pattern detection (phase 2).** Email regex, credit-card (Luhn), etc. — no
   pre-registration; catches incidental PII. `type=password` fields are masked
   by field type (the value is never collected to begin with).

## Replacement token

A detected secret is replaced with a structured, value-free token so the agent
can still *reason about* it without learning it:

```
[WHISKOR_REDACTED type=email hint=@gmail.com reason=user-blacklist]
```

- `type`  — email / password / token / pii
- `hint`  — a non-sensitive fragment chosen per type (email → domain only)
- `reason`— user-blacklist / pattern

The agent reads this as "there is a real email here; the live screen has the
actual value; I just don't get to see it."

## Scope (MVP covers all of these)

| Surface | How |
|---|---|
| Text (text-coords, dom-snapshot, ui-catalog) | substring replace in payload strings at the chokepoint |
| network / console / storage | same chokepoint, recurse through payload bodies/strings |
| **screenshots** | server detects sensitive boxes via text-coords overlap, sends **only the rectangles** to the page; the page draws an opaque CSS overlay (reusing the Set-of-Marks overlay layer), captures, then removes it. Real screen keeps the value; the agent's screenshot shows a box. (v2 option: server-side pixel blackout to avoid the brief on-screen overlay.) |
| **write side — `type_secret`** | new MCP write tool. The agent passes a `ref` name (e.g. `user_password`), not a value; the server injects the real registered value through the existing char-by-char executor path (works on per-char password fields; CDP high-fidelity for trusted events). The agent never sees the value. |

## Config (`config.json` → new `privacy` section)

```jsonc
"privacy": {
  "secretGuard": {
    "enabled": false,            // opt-in
    "knownValues": "env",        // "env" | "file" | "off"  (values never inline in config)
    "patterns": { "email": true, "creditCard": true },
    "redactScreenshots": true,
    "dashboardSeesRaw": false    // local human dashboard: redacted by default
  }
}
```

Secrets themselves live in `.env` / `secrets.local.json` (git-ignored), **never
in `config.json`** (which is tracked).

## Phased delivery

- **Slice 1 (MVP core):** `secret-guard.js` + known-value substring redaction at
  the `core.js` chokepoint + config wiring + `.env`/`secrets.local.json` loader
  (git-ignored) + token format. Unit tests against the real module (recurse over
  nested payloads; never emit the raw value). No screenshots/write yet.
- **Slice 2:** pattern detection (email/credit-card).
- **Slice 3:** screenshot box-masking via text-coords + CSS overlay.
- **Slice 4:** `type_secret` write tool.

## Open questions

- Should the **local dashboard** (the user's own monitoring view) see raw values?
  Default: no (safe). Toggle: `dashboardSeesRaw`.
- Token format stability — agents may pattern-match it; keep it documented + fixed.
- Performance: substring scan over every payload. Bound by payload size already
  capped in collection config; phase-1 known-value set is small.
```
