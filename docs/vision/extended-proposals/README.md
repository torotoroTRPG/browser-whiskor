# Extended Proposals A–G

> v4 Architecture に対する拡張提案。各Proposalは自己完結しており、実装依存関係を持つ。
> 詳細設計: `docs/ideas/ARCHITECTURE_EXTENDED_PROPOSALS.md`

## Proposal一覧

| ID | 名称 | 優先度 | 現状の資料 | 依存 |
|----|------|--------|-----------|------|
| A | DOM_MUTATION Event Type | 高 | `docs/ideas/ARCHITECTURE_EXTENDED_PROPOSALS.md` | — |
| B | CSS @layer Cascade Resolution | 中 | 同上 | — |
| C | State Graph Visualizer | 中 | 同上 | — |
| D | Adaptive Collection Scheduling | 低 | 同上 | — |
| E | Source Map Resolver | 中 | 同上 | — |
| F | Session Replay | 低 | 同上 | A (optional) |
| G | Conclusion Cache | 低 | 同上 | E |

## Proposal A: DOM_MUTATION Event Type

現状の `TEXT_COORD_DELTA` では拾えない属性のみの変異や不可視の挿入をカバーする。

### MutationObserver 設定
```javascript
observer.observe(document.body, {
  childList: true, subtree: true, attributes: true,
  characterData: true, attributeOldValue: true
});
```

### バッチング
16msウィンドウで同一要素への複数変異を coalesce。
`childList` 変異は coalesce しない（過渡DOMの検出に必要）。

### スキーマ
```json
{
  "type": "DOM_MUTATION",
  "records": [{
    "mutationType": "childList" | "attributes" | "characterData",
    "targetSelector": "button.btn",
    "addedCount": 0, "removedCount": 1,
    "attributeName": "class", "oldValue": "btn", "newValue": "btn active"
  }]
}
```

### Correlator 連携
`TEXT_COORD_DELTA` より優先。`dom.signal: "mutation_observer"` で区別。

## Proposal B: CSS @layer Cascade Resolution

`@layer` が考慮されていない既存のCSS Origin Trackerを拡張。

### Layer優先度
```
0 = 非レイヤールール (最高優先度)
1 = 最初の@layer
2 = 2番目の@layer
...
```

### ソートキー拡張
`[specificity, source_order]` → `[layer_priority, specificity, source_order]`

## Proposal C: State Graph Visualizer

状態グラフをテキストベースで描画する MCPツール。
`docs/vision/context-brain/` の State Visualizer と同一。

詳細は [`docs/vision/context-brain/README.md`](../context-brain/README.md) 参照。

## Proposal D: Adaptive Collection Scheduling

アナライザーの収集頻度を変化率EMAに基づき動的調整。
`docs/vision/context-brain/` の Adaptive Scheduling と同一。

詳細は [`docs/vision/context-brain/README.md`](../context-brain/README.md) 参照。

## Proposal E: Source Map Resolver

コンパイル済みCSS/JSのファイル参照を元のソース位置に解決。
CSS Origin Tracker と Framework↔DOM Mapper の信頼度を1.00に昇格。

詳細は [`docs/vision/context-brain/README.md`](../context-brain/README.md) 参照。

## Proposal F: Session Replay

Agent操作の記録と再実行。
`docs/vision/context-brain/` の Session Replay と同一。

詳細は [`docs/vision/context-brain/README.md`](../context-brain/README.md) 参照。

## Proposal G: Conclusion Cache

`explain_element` の結果をSHA-256無効化キーでキャッシュ。
`docs/vision/context-brain/` の Conclusion Cache と同一。

詳細は [`docs/vision/context-brain/README.md`](../context-brain/README.md) 参照。

## 依存関係グラフ

```
A (DOM_MUTATION)
  └─ optional: B

B (@layer)
  └─ standalone

C (State Visualizer)
  └─ standalone (既存 state-store.js 利用)

D (Adaptive Scheduling)
  └─ standalone (collector.jsのみ変更)

E (Source Map Resolver)
  ├─ CSS Origin Tracker (Level 3 → Level 1 昇格)
  └─ Framework↔DOM Mapper (_debugSource解決)

F (Session Replay)
  └─ standalone (既存 executor.js + state-navigator.js 利用)

G (Conclusion Cache)
  └─ standalone (explain_elementに依存)

推奨順序: A → E+B → C → G → D → F
```
