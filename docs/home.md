# browser-whiskor

Agent-grade browser perception and state navigation. A Chrome/Firefox extension + MCP server that gives AI agents structured visibility into what's happening inside a browser tab.

<div class="card-grid">
  <a href="#/changelog">
    <strong>Changelog</strong>
    <span>Release history and what changed</span>
  </a>
  <a href="#/http-api-reference">
    <strong>HTTP API Reference</strong>
    <span>All endpoints, request/response shapes</span>
  </a>
  <a href="#/architecture">
    <strong>Architecture</strong>
    <span>Server, extension, cache, state graph</span>
  </a>
  <a href="#/agent-knowledge">
    <strong>Agent Knowledge</strong>
    <span>What an AI agent needs to know</span>
  </a>
  <a href="#/理想機能メモ">
    <strong>Roadmap (理想機能メモ)</strong>
    <span>Prioritized TODO — 15 items with status</span>
  </a>
  <a href="#/ideas/">
    <strong>Ideas & Proposals</strong>
    <span>Design docs, future directions</span>
  </a>
</div>

## Quick Start

```bash
npm install && npm start     # server on :7892
whk shell                    # interactive TUI
```

Load the extension: Chrome → `chrome://extensions` → Load unpacked → `extension/`.

## For AI Agents

- **MCP**: `node server/index.js --mcp` — 70 tools with dynamic profiles
- **HTTP**: `skills/browser-whiskor-http/` — ready-to-use agent skill over plain HTTP
- **Raw docs**: [`llm.txt`](llm.txt) — all key docs concatenated for LLM ingestion
