---
name: browser-whiskor-http
description: >
  Perceive and control a browser tab through the browser-whiskor HTTP API
  (http://127.0.0.1:7892) without MCP. Use when asked to look at a page, click,
  type, fill a form, take a screenshot, read the DOM / network / console, or
  automate the browser, and browser-whiskor is installed locally. Covers the
  pure HTTP path only — for MCP-based workflows the whiskor MCP server is the
  right entry point. ブラウザの認知・操作 / ページを見る / クリック / フォーム入力 /
  スクリーンショット / ネットワーク確認。
---

# browser-whiskor — HTTP API (MCP不使用)

browser-whiskor は Chrome/Firefox 拡張機能 + Node.js サーバーで構成される、AI向けのブラウザ認知・操作ツール。
このスキルは MCP を使わず **HTTP REST API（`http://127.0.0.1:7892`）だけ**でブラウザを知覚・操作する手順を定義する。
全エンドポイント・全アクションtype・キャッシュパスの一覧は同ディレクトリの [reference.md](reference.md) を参照。

```
AI エージェント
    │  HTTP (fetch / curl)
    ▼
http://127.0.0.1:7892   ← browser-whiskor サーバー
    │  WebSocket :7891
    ▼
ブラウザ拡張機能 → 実際のタブ（認知・操作）
```

## 前提条件チェック（必ず最初に実行）

```javascript
const health = await (await fetch("http://127.0.0.1:7892/health")).json();
// health.ok === true            … サーバー起動済み
// health.wsConnections >= 1     … 拡張機能が接続済み
// health.sessions >= 1          … 操作対象のタブが存在
```

失敗時の対処:
- `fetch` 自体が失敗 → リポジトリで `npm start`（supervisor付き起動）をユーザーに依頼
- `wsConnections === 0` → ブラウザで拡張機能を読み込み、対象ページを開いてもらう

## Step 1: タブ（セッション）の特定

```javascript
const sessions = await (await fetch("http://127.0.0.1:7892/api/sessions")).json();
// 各エントリの tabId / url / title / isStale を見て対象を選ぶ。以降の全操作で tabId が必要。
```

複数タブで迷う場合は URL/title をユーザーに確認する。

## Step 2: ページの知覚

```javascript
const BASE = "http://127.0.0.1:7892";
const post = (path, body) => fetch(BASE + path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(r => r.json());

// スクリーンショット（marks: true で要素番号オーバーレイ + セレクタ一覧）
const { dataUrl, elements } = await post("/api/screenshot", { tabId, marks: true });

// パックド Set-of-Marks（インタラクティブ要素だけを詰めた画像 — トークン効率重視）
const som = await post("/api/packed-som", { tabId });

// 構造データ（テキスト座標 / UIカタログ / ネットワーク / コンソール等）
const ui = await fetch(`${BASE}/api/sessions/${tabId}/raw/ui/elements.json`).then(r => r.json());
```

データが古い場合（`isStale: true`）は再収集してから読む:

```javascript
await post("/api/collect", { tabId });
```

## Step 3: ページの操作

全アクションは `POST /api/action` に統一。`{ ok }` を確認し、操作後は Step 2 で結果を検証する。

```javascript
await post("/api/action", { tabId, action: { type: "click", text: "ログイン" } });
await post("/api/action", { tabId, action: { type: "type", selector: "input[type=email]", text: "user@example.com", clear: true } });
await post("/api/action", { tabId, action: { type: "wait_for_element", selector: ".dashboard", timeoutMs: 5000 } });
```

主な type: `click` / `type` / `press_key` / `hover` / `scroll` / `drag` / `select_option` / `check` /
`navigate` / `go_back` / `go_forward` / `reload` / `wait_for_element` / `focus` / `clear_input` /
`analyze_click`（クリック前のドライラン）/ `execute_js`（要 `security.allowExecuteJs: true`）。
引数の詳細は [reference.md](reference.md)。

## 基本サイクル

```
1. GET  /health                          → サーバー・拡張機能の確認
2. GET  /api/sessions                    → tabId 取得
3. POST /api/screenshot { marks: true }  → 画面とインタラクティブ要素の把握
4. POST /api/action { ... }              → 操作
5. POST /api/collect { tabId }           → データ更新
6. 3〜5 を繰り返す
```

## エラー早見表

| 症状 | 原因 | 対処 |
|---|---|---|
| `fetch` 失敗 | サーバー未起動 | `npm start` |
| `404 Session not found` | tabId が無効 | `/api/sessions` で再取得 |
| `Action timed out` | 要素なし・遷移中 | `wait_for_element` 後に再試行 |
| `execute_js is disabled` | `allowExecuteJs: false`（既定） | ユーザーに有効化を確認 |
| `_warnings: STALE_DATA` | データが古い | `POST /api/collect` |
| 値が `[WHISKOR_REDACTED ...]` | secret guard 有効 | 実値は見えない仕様。入力は `type` + `secretRef` で |
