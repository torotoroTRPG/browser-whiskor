# Tab Lifecycle & Archive

> ブラウザタブの完全なライフサイクル管理。
> AIがタブを一覧・切替・生成・破棄し、さらに「アーカイブ」として状態ごとテキスト化して保存・復元できる。

## コンセプト

```
AIが見ているタブ群

┌──────┬──────┬──────┬──────┬──────┐
│  ダッ │ 在庫 │ 顧客 │ 設定 │ 注文 │  ← タブバー
│ シュ  │ 管理 │ 管理 │      │ 詳細 │
│ ボード│      │      │      │      │
├──────┴──────┴──────┴──────┴──────┤
│                                    │
│  👁️ 現在アクティブなタブ             │
│                                     │
│  🔒 タブC (顧客管理) — WebSocket接続中│
│  💤 タブD (設定) — 最後の操作: 3分前  │
│  📦 タブE (注文詳細) — stateGraph有  │
└─────────────────────────────────────┘

アーカイブ領域（メモリ＋ディスク）
┌─────────────────────────────────────┐
│ 📦 タブF (取引履歴) — 30分前アーカイブ│
│   URL: /transactions                │
│   compositeHash: a1f3c8e            │
│   状態: 検索結果一覧表示中            │
│   最終操作: スクロール→3件目の詳細    │
│                                     │
│ 📦 タブG (分析レポート) — 1時間前    │
│   URL: /reports/q2                  │
│   compositeHash: b34d2e1            │
│   状態: グラフ表示、フィルター適用済  │
└─────────────────────────────────────┘
```

## MCPツール

### 1. list_tabs — 全タブの状態を一覧

```
list_tabs()
Output: {
  tabs: [{
    tabId: 5,
    title: "Dashboard — ACME Corp",
    url: "https://app.example.com/dashboard",
    favicon: "data:image/...",
    active: true,
    status: "complete" | "loading" | "unloaded",
    whiskorState: {
      connected: true,           // WebSocket接続中
      compositeHash: "a1f3c8e", // 現在の状態ハッシュ
      watcherActive: false,
      lastActivity: 1700000000000
    }
  }]
}
```

### 2. switch_tab — アクティブタブ切替

```
switch_tab(tabId: 3)
Output: {
  ok: true,
  previousTabId: 5,
  currentTabId: 3,
  tab: { title, url, whiskorState }
}
```

### 3. open_tab — 新規タブを開く

```
open_tab(url: "https://...", active: true, background: false)
Output: {
  ok: true,
  tabId: 7,
  tab: { title, url }
}
```

`navigate_to`（既存）との違い:
- navigate_to: 現在のタブを遷移させる（置き換え）
- open_tab: 新規タブを開く（追加）

### 4. close_tab — タブを閉じる

```
close_tab(tabId: 3)
Output: {
  ok: true,
  closedTabId: 3,
  previousTabId: 5,   // フォーカスが移ったタブ
  archived: false      // アーカイブせず閉じた場合
}
```

### 5. archive_tab — タブをアーカイブ

タブの状態をすべてテキスト化して保存し、タブを閉じる。

```
archive_tab(tabId: 3)
Output: {
  ok: true,
  archiveId: "arch-20260526-3-a1f3c8e",
  archive: {
    tabId: 3,
    title: "顧客管理",
    url: "https://app.example.com/customers",
    compositeHash: "a1f3c8e",
    capturedAt: 1700000000000,
    stateSummary: {
      label: "検索結果一覧表示中",
      tags: ["search", "table", "pagination"],
      keyState: { searchQuery: "株式会社", page: 3 }
    },
    sessionDir: "cache/sessions/...",
    screenshot: "data:image/png;base64,...",  // アーカイブ用サムネイル
    snapshot: { /* DOMスナップショットの要約 */ }
  }
}
```

**アーカイブに含まれる情報:**
| 項目 | 内容 |
|------|------|
| URL | 完全なURL |
| タイトル | document.title |
| compositeHash | 状態グラフ上の位置 |
| stateSummary | ラベル・タグ・キー状態 |
| screenshot | アーカイブ時の画面キャプチャ |
| domSnapshot | DOM構造の要約（全要素は不要） |
| sessionDir | キャッシュパス（後でrestore時に参照可能） |
| replayLog | 直近の操作履歴（actions.jsonlの要約） |

### 6. list_archives — アーカイブ一覧

```
list_archives()
Output: {
  archives: [{
    archiveId: "arch-20260526-3-a1f3c8e",
    title: "顧客管理",
    url: "...",
    compositeHash: "a1f3c8e",
    capturedAt: 1700000000000,
    stateSummary: { label: "..." }
  }]
}
```

### 7. restore_archive — アーカイブから復元

```
restore_archive(archiveId: "arch-20260526-3-a1f3c8e", active: true)
Output: {
  ok: true,
  tabId: 8,
  archive: { ... },
  restoreStatus: {
    urlLoaded: true,
    stateReached: true,    // navigate_to_state で元の状態まで復元
    stateExactMatch: true  // 完全一致 / 部分一致
  }
}
```

復元フロー:
1. 新規タブを開く (open_tab)
2. URLに遷移 (navigate_to)
3. 状態ハッシュまでナビゲート (navigate_to_state)
4. 復元できなかった状態は差分報告

### 8. search_archives — アーカイブ全文検索

```
search_archives(query: "顧客", tag?: "search")
Output: {
  results: [{
    archiveId: "...",
    title: "顧客管理",
    url: "...",
    matchedField: "title" | "url" | "stateSummary.label" | "tags",
    stateSummary: { ... }
  }]
}
```

## アーカイブストレージ

### メモリ (ホットキャッシュ)

```
server/tab-archive-store.js:
  Map<archiveId, ArchiveEntry>
    直近50件を保持
    LRU + アクセス時間で管理
    セッション終了時に最新をディスクへフラッシュ
```

### ディスク (永続化)

```
cache/archives/
  _index.json              ← 全アーカイブの索引
    [{ archiveId, title, url, capturedAt, tags }]
  arch-{date}-{tabId}-{hash}/
    archive.json            ← ArchiveEntry の完全データ
    screenshot.png          ← アーカイブ時の画面キャプチャ
    session-state.json      ← 復元用の状態情報（compositeHash等）
```

### インメモリ完全テキスト化（AI検索用）

アーカイブ時に、タブの状態情報を**テキストのみ**の要約に変換してメモリに保持する。
AIは画像を受け取らなくても、このテキストだけでタブの内容を把握できる。

```json
{
  "archiveId": "...",
  "title": "顧客管理",
  "url": "https://app.example.com/customers?q=株式会社&page=3",
  "stateText": "顧客一覧ページ。検索クエリ「株式会社」、3ページ目を表示中。
  テーブルに20件の顧客データ。列: 会社名, 担当者, メール, ステータス, 最終更新日。
  ページネーション: 「前へ」「次へ」ボタンあり、現在3/5ページ。
  右上に「新規顧客登録」ボタン。",
  "keyState": {
    "searchQuery": "株式会社",
    "page": 3,
    "totalPages": 5,
    "totalResults": 97
  }
}
```

## タブ状態の理解

`list_tabs` はタブが今「どういう状態か」をAIが把握できるようにする:

```json
{
  "tabId": 5,
  "title": "Dashboard — ACME Corp",
  "url": "https://app.example.com/dashboard",
  "active": true,
  "status": "complete",
  "whiskorState": {
    "connected": true,
    "compositeHash": "a1f3c8e",
    "stateLabel": "ダッシュボード 週次サマリ表示中",
    "lastActivity": 1700000000000,
    "watcherActive": false,
    "framework": "react",
    "unvisitedActions": 12,         // 未訪問の操作可能要素
    "lastScreenshot": "..."         // 最新のサムネイル
  }
}
```

## ユースケースフロー

### シナリオ: クロスブラウジング＋アーカイブ

```
1. AI: list_tabs()
   → 3タブ開いてる。ダッシュボード、顧客管理、在庫管理

2. AI: 「まず在庫管理を見よう」
   → switch_tab(tabId: 7)

3. AI: capture_screenshot → 在庫管理の画面を確認

4. AI: 「次に顧客管理も見ながら比較したい」
   → open_tab("https://app.example.com/customers")
   → switch_tab(tabId: 5)

5. AI: 「この分析レポートは後で必要だから取っておこう」
   → archive_tab(tabId: 3)
   → タブ3が閉じられ、archive領域に保存される

6. AI: 「さっきの在庫管理の続きをやる」
   → list_archives() → restore_archive("arch-...")
   → タブが復元され、元の状態まで自動ナビゲート

7. AI: 「顧客関連のアーカイブを全部調べたい」
   → search_archives(query: "顧客")
   → 3件ヒット → restore_archive で順次復元
```

### シナリオ: メモリ節約

```
1. AI: list_tabs()
   → 12タブ開いてる。ほとんどが未使用

2. AI: list_tabs() で whiskorState.lastActivity を確認
   → 5分以上操作していないタブが8つ

3. AI: 「古いタブをアーカイブして整理しよう」
   → archive_tab(tabId: 4) × 8回
   → アクティブタブのみ残す

4. AI: 「後で必要なやつを探そう」
   → search_archives(tag: "important")
   → 2件 → restore_archive
```

## ファイル構成（追加分）

```
server/tab-manager.js              — list_tabs, switch_tab, open_tab, close_tab
server/tab-archive-store.js        — アーカイブのCRUD + ディスク永続化
server/archive-textifier.js        — タブ状態→テキスト要約変換
server/mcp/tools/tabs.js           — 全タブ管理MCPツール (list/switch/open/close)
server/mcp/tools/archive.js        — アーカイブMCPツール (archive/restore/list/search)
cache/archives/                    — アーカイブディスクストレージ
```

## 依存関係

- **state-navigator.js** — restore時の `navigate_to_state` で依存
- **state-semantic.js** — archive時の `stateSummary.{label, tags, keyState}` 生成
- **cache** — アーカイブのディスク永続化
- **capture_screenshot** — アーカイブ時のサムネイル取得
