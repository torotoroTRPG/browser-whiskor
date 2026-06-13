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
// 各エントリの tabId / url / title / isStale / summary を見て対象を選ぶ。以降の全操作で tabId が必要。
// 既定は軽量。各プラグインの収集時刻（freshnessMap）も要るときは ?verbose=1 を付ける。
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

// フォームの入力値（textarea/input の value）は既定では収集されない。必要なら config の
// textCoords.includeFormValues を有効化 → collect 後に text-coords.json の formValues を読む
// （機微フィールドは伏字、secret-guard で redaction 済み）。
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

操作のポイント:

- **`type` は `selector` を必ず渡す** — selector 指定時は自動でフォーカスしてから入力する。
  selector 省略時は「現在フォーカス中の要素」に入力するため、事前の `focus` / `click` がないと失敗する
- **対象タブは自動でアクティブ化される**（`agentControl.autoSwitchTab`、既定 ON）。バックグラウンドの
  タブに操作やスクリーンショットを要求すると、拡張が先にそのタブへ切り替える
- **動的 ID をセレクタに使わない** — React/MUI 等は `#:r5k:` のような再レンダリングで変わる ID を
  生成する。`text` 指定・安定した属性（`aria-label`, `name`, `data-*`）・SoM の座標を使う
- セレクタが複数要素にマッチした場合は最初の**可視**要素が選ばれ、結果に `selectorMatches` が付く。
  付いていたら意図した要素か確認し、セレクタを絞り込む

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
| `Element is obstructed` | ポップオーバー/モーダルが対象を覆っている（自動解除も失敗） | `clickability.obstructedBy` を確認 → `press_key Escape`、遮蔽要素の閉じるボタンをクリック、またはバックドロップ座標を `click(x,y)` |
| `No target element for type` | selector 未指定でフォーカスも無い | `type` に `selector` を渡す（自動フォーカスされる） |
| 結果に `selectorMatches` | セレクタが複数要素にマッチ（最初の可視要素を使用） | `target` を確認し、違えばセレクタを絞る |
| `execute_js is disabled` | `allowExecuteJs: false`（既定） | ユーザーに有効化を確認 |
| `_warnings: STALE_DATA` | データが古い | `POST /api/collect` |
| 値が `[WHISKOR_REDACTED ...]` | secret guard 有効 | 実値は見えない仕様。入力は `type` + `secretRef` で |
