# Slice XML Pipeline

> スクリーンショットをDOM構造に基づいてスライスし、構造化XMLメタデータを付与する。
> AIエージェントが「画面のどの部分が何か」を正確に理解するための基盤。

## 動機

現在のSoMは赤丸＋数字の重ね書きのみ。Agentは座標と要素の対応を自力で推論する必要がある。
Slice XML Pipeline は「この座標範囲に何の要素があるか」をXMLとして構造化し、Agentに提供する。

## データフロー

```
Agent → get_slice_xml(tabId)
  │
  ▼
MCP → server/index.js
  │
  ├─ [1] WebSocket → extension/sw.js
  │       ├─ chrome.tabs.captureVisibleTab → raw PNG (full page)
  │       └─ scripting.executeScript → slice-engine.js
  │
  ├─ [2] slice-engine.js:
  │       └─ DOM tree BFS traversal
  │            ├─ ルートから子要素を再帰的に列挙
  │            ├─ 各要素: getBoundingClientRect() → {x, y, w, h}
  │            ├─ フィルタ: 非表示, ゼロサイズ, viewport外 → 除外
  │            ├─ メタデータ: tag, id, class, text, attributes, selector
  │            └─ 出力: SliceElement[]
  │
  ├─ [3] server/index.js でアセンブル:
  │       └─ XML生成:
  │           <screenshot>
  │             <viewport width="1920" height="1080" />
  │             <slice id="1" x="0" y="0" w="200" h="60">
  │               <tag>nav</tag>
  │               <selector>header nav</selector>
  │               <text>Home About Contact</text>
  │               <children>
  │                 <slice id="2" x="10" y="5" w="60" h="30">
  │                   <tag>a</tag>
  │                   <selector>header nav a:nth-child(1)</selector>
  │                   <text>Home</text>
  │                 </slice>
  │               </children>
  │             </slice>
  │           </screenshot>
  │
  └─ [4] MCP応答:
        { ok, slices: SliceElement[], xml: string, elements: SoMElement[] }
```

## MCPツール仕様

### get_slice_xml

```
Input:  { tabId: number, maxDepth?: number, minArea?: number }
Output: { ok: boolean, xml: string, slices: SliceElement[], elements: SoMElement[] }
```

### get_cheat_sheet

Agent向け簡易マップ（Phase 3連携）。
```
Input:  { tabId: number }
Output: { ok: boolean, viewport: {w, h}, elements: [{id, tag, text, selector, center, size}] }
```

## スライスルール

| 条件 | 動作 |
|------|------|
| 非表示要素 (display:none, visibility:hidden) | スキップ |
| ゼロサイズ (w=0 or h=0) | スキップ |
| viewport外 | スキップ（設定でキャプチャ範囲外の場合） |
| テキストノードのみ | 親要素に統合 |
| 子要素あり | 親スライスのchildrenとして再帰的包含 |
| maxDepth超過 | その階層で打ち切り、子要素は親に統合 |
| minArea未満 | 無視（ゴミノイズ除去） |

## ストレージ

```
cache/{tabId}/raw/slices/
  _index.json          ← スライスセッション一覧
  {timestamp}.xml      ← 生成されたXML
  {timestamp}.json     ← SliceElement[] (生データ)
```

## 依存関係

- 現状のSoM実装 (`capture_screenshot` の要素クエリロジックを再利用)
- **Transparent Overlay** (Phase 1) — 同じ要素矩形データをDashboard表示に使用
- **SoM Variants** (Phase 2–4) — スライスごとの色割当と連携

## 実装メモ

- 要素の重複除去は既存の `collectElements()` の `seen` Set を流用
- slice-engine.js は injected/analyzers/ に配置、既存の plugin-system で管理
- 大量スライス時のパフォーマンス: maxDepth=5, minArea=16px² をデフォルト推奨
