# Dynamic Focus / 動的注視システム

> AIが仮想カメラを操作するように、画面上の任意のポインタを注視・拡大・縮小・切替・解除。
> 水平切り取りに依存せず、あらゆる画面分割で機能する汎用フォーカス機構。
> 全コマンドは最小トークンで完結。AIがトークン消費を気にしながら高速操作できる。

## コンセプト

```
AIの視点 = 仮想カメラ

全画面 (wide)             2xズーム              4xズーム
┌──────────────┐         ┌────────┐            ┌──────┐
│  ┌──┐ ┌──┐   │   🔍    │ ┌──┐  │     🔍     │┌──┐ │
│  │A │ │B │   │   →     │ │B │  │     →      ││B │ │
│  └──┘ └──┘   │         │ └──┘  │            │└──┘ │
│      ┌──┐    │         │ ┌──┐  │            │┌──┐ │
│      │C │    │         │ │C │  │            ││C │ │
│      └──┘    │         │ └──┘  │            │└──┘ │
└──────────────┘         └────────┘            └──────┘

AIコマンド語彙 (最小トークン):
  f B   → ポインタBにフォーカス (focus)
  zi    → ズームイン (zoom in)
  zo    → ズームアウト (zoom out)
  zr    → ズームリセット (zoom reset)
  n     → 次のポインタ (next pointer)
  p     → 前のポインタ (prev pointer)
  r     → フォーカス解除 (release)
  s     → 現在の状態を確認 (status)
```

## 設計思想: カメラメタファー

AIは「仮想カメラ」を操作する感覚で画面を探索する:

| 操作 | 発話 | MCP呼び出し |
|------|------|------------|
| ポインタBを注視 | `f B` | `focus({ptr:"B"})` |
| もっと詳しく見たい | `zi` | `focus({zoom:"in"})` |
| 引きすぎた、戻す | `zo` | `focus({zoom:"out"})` |
| 全体を見る | `zr` | `focus({zoom:"reset"})` |
| 隣の要素を見る | `n` | `focus({ptr:"next"})` |
| 一個戻る | `p` | `focus({ptr:"prev"})` |
| もういい、解除 | `r` | `focus({action:"release"})` |
| 今どこ見てる？ | `s` | `focus({action:"status"})` |

**各コマンドは1回のMCP呼び出し＝1画像応答。** AIは結果画像を見て次の判断をする。

## アーキテクチャ

```
Layer 0: LLM Agent
  │  f B
  ▼
Layer 1: MCP Server
  │  focus({ptr:"B"})
  ▼
Layer 2: Server Core
  │
  ├─ Focus State Machine (server/focus-state.js) ══ NEW ══
  │     tab単位で現在のフォーカス状態を保持:
  │     {
  │       active: true/false,
  │       pointerId: "B" | null,
  │       center: {x, y},
  │       zoomLevel: 1 | 2 | 4,        // 1=全画面, 2=2x, 4=4x
  │       history: ["A","B","C"],       // ナビゲーション履歴
  │       historyIndex: 1,
  │       codeCache: Map<pointerId, SourceLineBundle>
  │     }
  │
  ├─ [1] Zoom Engine (server/zoom-engine.js) ══ NEW ══
  │     現在のポインタ中心・ズームレベルからcrop矩形を計算:
  │       cropW = viewport.w / zoomLevel
  │       cropH = viewport.h / zoomLevel
  │       clamp viewport内 → CAPTURE_ELEMENT → 画像取得
  │
  ├─ [2] Overlap Analyzer (server/overlap-analyzer.js) ══ NEW ══
  │     注視領域と全スライスの矩形を比較 → 重なり要素を抽出
  │
  ├─ [3] Source Line Collector (server/source-line-collector.js) ══ NEW ══
  │     重なり要素のソース行を収集 (Framework↔DOM + Source Map)
  │
  └─ [4] codeCache (focus-state.js内蔵)
       ポインタごとにSourceLineBundleをメモリ保持
```

## MCPツール: focus

1つのツールで全操作をカバー。引数は最小限。

```
focus({tabId, ptr?, zoom?, action?})
```

| シナリオ | 呼び出し | 動作 |
|---------|---------|------|
| フォーカス | `{ptr:"B"}` | ポインタB中心に2xで表示。初回のみcode collect実行 |
| ズームイン | `{zoom:"in"}` | 現在のポインタ中心で1段階拡大 (2→4→8) |
| ズームアウト | `{zoom:"out"}` | 1段階縮小 (8→4→2→1) |
| リセット | `{zoom:"reset"}` | 全画面表示、フォーカス維持 |
| 次 | `{ptr:"next"}` | 可視ポインタを番号順に移動 |
| 前 | `{ptr:"prev"}` | 逆順に移動 |
| 解除 | `{action:"release"}` | フォーカス解除、全画面に戻す |
| 状態確認 | `{action:"status"}` | 現在のフォーカス状態を返す（画像なし） |

応答 (全操作共通):
```json
{
  "ok": true,
  "active": true,
  "pointerId": "B",
  "zoomLevel": 2,
  "image": { "dataUrl": "...", "x": 400, "y": 300, "w": 960, "h": 540 },
  "totalPointers": 15,
  "codeAttached": ["UserProfileCard", "SideNav"]
}
```

`status` のみimageなし:
```json
{
  "active": true,
  "pointerId": "B",
  "zoomLevel": 2,
  "center": { "x": 850, "y": 1200 },
  "totalPointers": 15,
  "history": ["A","B","C"],
  "historyIndex": 1
}
```

## ユースケースフロー（汎用）

### 水平分割・垂直分割・グリッド、すべてで共通

```
1. AI: capture_screenshot → SoM画像を受信（ポインタA〜P）
2. AI: 「f E」 → focus({ptr:"E"})
         └─ E中心2x画像 + E周辺のコード断片
3. AI: 「zi」 → focus({zoom:"in"})
         └─ E中心4x画像（さらに詳細に）
4. AI: 「ああ、この辺りが原因か。でもちょっと引きたい」
   「zo」 → focus({zoom:"out"})
         └─ E中心2xに戻る
5. AI: 「隣のFも見たい」
   「n」 → focus({ptr:"next"})
         └─ F中心2x画像 + F周辺のコード断片
6. AI: 「やっぱEに戻ろう」
   「p」 → focus({ptr:"prev"})
         └─ E中心2x（コードはキャッシュ済みで即時）
7. AI: 「全体を見渡したい」
   「zr」 → focus({zoom:"reset"})
         └─ 全画面（フォーカスはEのまま）
8. AI: 「もうこの辺は大丈夫」
   「r」 → focus({action:"release"})
         └─ 全画面、フォーカス状態クリア
```

### トークン消費の意識

```
発話例                       トークン数 (概算)
──────────────────────────────────────────
"f B"                        2 tokens
"zi"                         2 tokens
"zo"                         2 tokens
"n"                          1 token
"p"                          1 token
"r"                          1 token
"s"                          1 token
"zr"                         2 tokens

"ポインタBに注目して"        ~8 tokens  (従来の自然言語)
```

## フォーカスステートマシン

```
        ┌──────────────────────────────────────────┐
        │                                          │
        ▼                                          │
   ┌─────────┐   f B / n / p    ┌──────────────┐   │
   │ RELEASED │ ──────────────→ │ FOCUSED (2x) │   │
   │          │ ←── r ────────  │              │   │
   └─────────┘                  ├── zi → 4x    │   │
                                ├── zi → 8x    │   │
                                ├── zo → 2x    │   │
                                ├── zo → 1x    │   │
                                ├── zr → 2x    │   │
                                └── n/p → ptr切替│
                                       │        │
                                       └────────┘
```

- RELEASED → `f B` / `n` / `p`: FOCUSEDに遷移、初期ズーム2x
- FOCUSED → `r`: RELEASEDに遷移、全画面表示
- FOCUSED → `zi`/`zo`/`zr`: ズームレベル変更、ポインタ維持
- FOCUSED → `n`/`p`: ポインタ切替、ズームレベル維持

## Overlap Analyzer + Source Line Collector

フォーカス時のコード収集は初回のみ実行。同一ポインタへの再フォーカスはキャッシュから返す。

```
初回 f B:
  ├─ Zoom Engine → 画像crop
  ├─ Overlap Analyzer:
  │    注目矩形 {x, y, w, h} と全スライス矩形を比較
  │    重なったスライスのelementIdリスト
  └─ Source Line Collector:
        elementId → component名 → _debugSource
        → Source Map Resolver → originalFile:line
        → source-store → 該当行snippet
        → codeCache["B"] = { component, file, lines, snippet }

再 f B (or n→B, p→B):
  ├─ Zoom Engine → 画像crop（最新の画面を撮り直す）
  └─ codeCache["B"] → 即時応答（コード再収集しない）
```

## Transient Code Cache

| 特性 | 仕様 |
|------|------|
| ストレージ | メモリ (focus-state.js 内蔵) |
| 最大エントリ | 50 pointer / tab |
| 生存期間 | セッション終了まで |
| 検索 | ポインタID直接参照（全文検索はPhase 3） |
| 永続化 | しない |

## ファイル構成

```
server/focus-state.js              — フォーカスステートマシン + codeCache
server/zoom-engine.js              — crop矩形計算 + CAPTURE_ELEMENT発行
server/overlap-analyzer.js         — 矩形重なり判定
server/source-line-collector.js    — ソース行切り出し
server/mcp/tools/focus.js          — focus MCPツール1つ
extension/injected/analyzers/slice-engine.js  — SliceElement提供（既存）
```

## 依存関係

- **Slice XML Pipeline** — Overlap AnalyzerがSliceElement[]を入力に使う
- **Intelligence Layer** — Source Line CollectorがSource Map Resolver + Framework↔DOM Mapper + source-store に依存
- **capture_element_screenshot** — Zoom Engineのcrop処理で流用
