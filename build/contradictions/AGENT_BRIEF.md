# browser-whiskor — Agent Brief

この ZIP は **browser-whiskor のソースツリー** のスナップショットです。下記 contradictions (アーキテクチャ文書と実装の乖離) を確認し、修正してください。

## 前提

- アーキテクチャ文書は `docs/` 以下にあり
- 修正後 `npm test` で全テストが通過すること
- 既存のコードスタイル（IIFE、エラーハンドリング、null ガード、命名規則）に従うこと

## 重要: 修正のスタンス

1. **コード優位の原則**: アーキテクチャ文書よりコードの実装が明らかに優れている場合、コードを正とし文書を追従させること。アーキテクチャに盲従しない。
2. **アーキテクチャからの逸脱**: 以下の設計思想から大きく外れない限り、合理的な実装判断を優先する:
   - 「エージェントは結論を受け取る」（生データではなく構造化された結論を渡す）
   - 外部 npm 依存の最小化（ws と bippy のみ）
   - Fallback chain による graceful degradation
3. **最小変更**: 可能な限り最小の変更行数で最大の効果を出すこと。
4. **両ブラウザ対応**: Chrome (`extension/`) と Firefox (`firefox-mv2/`) の両方を同時に修正すること。

## 修正推奨順序

| # | Contradiction | ファイル | 修正量 | インパクト |
|---|---------------|----------|--------|-----------|
| 1 | **C1**: clickability.js が manifest にない | `manifest.json` x2 | 各 +1行 | Subsystem 5 が蘇生 |
| 2 | **H2**: SNAPSHOT → correlator feed なし | `core.js` | +6行 | 相関精度向上の前提 |
| 3 | **H1**: Correlator Rule 2 未実装 | `correlator.js` | ~+30行 | Framework→DOM 相関が可能に |
| 4 | **H3**: dom.signal 欠落 | `correlator.js` | +2行 | 信号源の区別 |
| 5 | **M1**: DOM_MUTATION type 欠落 | `dom-mutations.js` | +1行 | スキーマ準拠 |
| 6 | **M2**: source-fetcher dependencies | `source-fetcher.js` | 1行変更 | 依存関係正確化 |
| 7 | L1-L4 | 任意 | — | — |

## ディレクトリ構造 (簡略)

```
browser-whiskor/
├── extension/           ← Chrome MV3
│   ├── manifest.json   ★ C1
│   ├── background/sw.js
│   ├── devtools/devtools.js
│   ├── injected/
│   │   ├── analyzers/
│   │   │   ├── clickability.js   ★ C1 (unloaded)
│   │   │   ├── css-origin.js
│   │   │   ├── source-fetcher.js ★ M2
│   │   │   ├── dom-mutations.js  ★ M1
│   │   │   └── framework-dom-map.js
│   │   └── executor.js   ★ C1 (dead code paths)
│   └── panel/
├── firefox-mv2/         ← Firefox MV2 (mirror)
│   └── manifest.json    ★ C1
├── server/
│   ├── core.js          ★ H2
│   ├── correlator.js    ★ H1, H3
│   ├── state-visualizer.js ★ L4 (orphaned)
│   ├── mcp/tools/intelligence.js ★ L3
│   └── source-store.js
├── shared/injected/     ← sync-shared.ps1 で管理
├── config.json
└── docs/
    ├── architecture.md  ★ L2
    └── ideas/
        ├── ARCHITECTURE_INTELLIGENCE_LAYER.md  (基準文書)
        └── ARCHITECTURE_EXTENDED_PROPOSALS.md  (proposal 群)
```

## 修正手順

1. CONTRAINTS.md を読み、各 contradiction を把握
2. SOURCE_MAP.md を参照し修正ファイルを特定
3. コードを修正 (Chrome + Firefox 両方)
4. `npm test` または `.\tests\run-tests.ps1` で全テスト通過確認
5. 問題なければ終了。CONTRAINTS.md の該当行を ✅ Updated に更新すること
