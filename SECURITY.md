# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's **"Report a
vulnerability"** (Security → Advisories) on this repository, or open an issue
asking for a private contact if that is unavailable. Do not include
exploit details in public issues.

Supported version: the latest release / `main`.

## Security model — what this tool assumes

browser-whiskor is a **local development tool**. The HTTP (:7892) and
WebSocket (:7891) servers bind for local use and have **no authentication**:

- **Do not expose the ports to untrusted networks.** Anyone who can reach
  :7892 can read collected page data and drive the browser. For LAN setups,
  use `appIsolation` tokens, but treat them as scoping, not hardened auth.
- `identity` (instanceId/name) is a **label, not security**.

## Built-in safety mechanisms

- **`execute_js` is off by default** (`security.allowExecuteJs: false`).
  Arbitrary JS execution in the page must be opted into.
- **Agent config control is off by default**
  (`agentControl.allowAgentConfig: false`); when enabled, non-recommended
  changes are logged and can be auto-reverted on restart.
- **Secret Guard** (`privacy.secretGuard`, opt-in) redacts registered secret
  values, common secret patterns, and secret-named keys **server-side** before
  data reaches the agent, logs, cache, or dashboard. Secret values are never
  sent into the page; `type_secret` resolves ref names worker-side. Screenshot
  regions containing redacted text are masked on the extension canvas.
  Threat model and design: `docs/ideas/REDACTION_SECRET_GUARD.md`.
- **High-fidelity input (CDP)** uses the `debugger` permission only while
  enabled (`agentControl.input.highFidelity`, default `off`), and Chrome shows
  its standard debugging banner while attached.

## Data handling

Collected page data (DOM, text, network metadata, screenshots) is stored
unencrypted under `cache/` on the local machine. Treat that directory as
sensitive if you browse sensitive pages — or enable Secret Guard, and delete
sessions via the dashboard or `DELETE /api/sessions/:tabId` when done.
