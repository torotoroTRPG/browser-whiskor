# browser-whiskor v3 → v4 実装進捗レポート

生成日時: 2026-05-24

---

## ✅ 完了した実装

### 新規ファイル作成

| ファイル | 内容 | ステータス |
|---|---|---|
| `extension/injected/analyzers/css-origin.js` | CSS Origin Tracker (Subsystem 1) — 4段階フォールバック、特異度計算、ルールマッチング | ✅ 完了 |
| `extension/injected/analyzers/source-fetcher.js` | Source Layer acquisition — CSS/JSファイル取得・ハッシュ化・変更検出 | ✅ 完了 |
| `server/source-store.js` | Source file cache + cross-session hash registry | ✅ 完了 |

### TODO埋め（既存ファイル修正）

| ファイル | 変更内容 | ステータス |
|---|---|---|
| `server/mcp/tools/intelligence.js` | `explain_element`, `why_did_this_change`, `get_source_file`, `detect_site_updates` の4ツール実装 | ✅ 完了 |
| `server/config-loader.js` | `cssOrigin`, `sourceFetcher`, `correlator`, `frameworkDomMap` のデフォルト設定追加 + getMcpToolsDefaults に4ツール追加 | ✅ 完了 |
| `extension/injected/executor.js` | programmaticクリック戦略実装 (React Fiber + Vue 3 + fallback) | ✅ 完了 |
| `firefox-mv2/injected/executor.js` | 同上 (Firefox版) | ✅ 完了 |
| `extension/injected/analyzers/framework-dom-map.js` | TODOコメント除去（実装は既存） | ✅ 完了 |
| `extension/injected/analyzers/dom-mutations.js` | TODOコメント除去（実装は既存） | ✅ 完了 |

### アーキテクチャ整合性修正（設計矛盾の解消）

| ファイル | 問題 | 修正内容 |
|---|---|---|
| `server/core.js` | correlator・sourceStore が全く配線されていなかった | `WhiskorCore` コンストラクタに `correlator`/`sourceStore` を追加、`DOM_MUTATION`/`CSS_ORIGIN_MAP`/`FRAMEWORK_DOM_MAP`/`SOURCE_CONTENT` メッセージルーティング追加 |
| `server/core.js` | intelligence dataの永続化ロジックなし | `_persistIntelligenceData`, `_persistCausalChains`, `_appendSourceChanges` ヘルパー追加 |
| `server/index.js` | correlator/sourceStore がインスタンス化されていなかった | `TimeSeriesCorrelator` + `sourceStore` をインスタンス化し `WhiskorCore` へ注入 |
| `server/index.js` | `cache` が MCP callbacks に渡されていなかった | `setIntelligenceCallbacks(correlator, sourceStore, cache)` 追加 |
| `server/mcp-server.js` | `cache` callbacks が未定義 | `setIntelligenceCallbacks()` 関数追加・export |

---

## ⚠️ 残っている作業・既知の問題

### 中優先度

1. **`css-origin.js` の Level 1 (DevTools getResources) 実装**
   - 現在 Level 2〜4 のみ実装
   - Level 1 は DevTools パネルコンテキストからのみ呼び出し可能なため、`extension/devtools/` 側でラッパーが必要
   - **対応**: DevTools パネルスクリプトからの postMessage ブリッジを実装し、`css-origin.js` がそれをハンドリングできるようにする

2. **Correlator への framework_transition イベント feed 拡充**
   - `REACT_SNAPSHOT`, `VUE_SNAPSHOT` も correlator に feed すると Rule 2/3 の精度が上がる
   - 現在は `REACT_TRANSITION` のみ correlator へ届いている
   - **対応**: `core.js` の該当ケースに `if (this.correlator) { this.correlator.addMessage(msg); }` を追加

3. **`plugin-system.js` 依存関係フィールド未設定**
   - `_topologicalSort()` 自体は実装済み。各プラグインの `dependencies` フィールドが未設定
   - **対応**: `css-origin.js` に `dependencies: ['css-analyzer']` などを追加

4. **`mcp-tools.json` への intelligence ツール追記**
   - `config-loader.js` のデフォルトでは有効だが `mcp-tools.json` 本体には未追記
   - **対応**: `server/configs/mcp-tools.json` に `explain_element` 他4ツールを追加

### 低優先度

5. **CSS Origin Tracker の `@layer` / `@scope` 対応**
   - アーキテクチャの「Known Limitations」にも記載
   - Cascade Layers を考慮した特異度比較は現在未対応

6. **Correlator の framework_transition イベントとの改良統合**
   - 現在は `NETWORK_REQUEST/RESPONSE`, `DOM_MUTATION`, `TEXT_COORD_DELTA` が correlator に feed されている
   - `REACT_TRANSITION` の feed を追加するともっと精度が上がる

### ✅ 完了した実装（2026-05-24 追記）

以下のタスクは本実装で対応済み:

- **plugin-system.js の依存解決**: `_topologicalSort()` を実装 (`installAll()` で使用)
- **read-data.js の css_origin_map**: `get_css_analysis` の返値に `css_origin_map` を追加
- **intelligence.js の on-demand collection**: polling → event-driven + ポーリングフォールバックに改善
- **Firefox 同期**: `css-origin.js`, `source-fetcher.js`, `framework-dom-map.js` を Firefox にコピー+ manifest 更新
- **manifest.json 更新**: Chrome + Firefox 両方に 3ファイルの analyzer を content_scripts に追加
- **config.json intelligence**: `plugins.{css-origin,source-fetcher,framework-dom-map}` + `intelligence` セクション追加
- **correlator feed**: `NETWORK_REQUEST/RESPONSE` と `TEXT_COORD_DELTA` が correlator に feed されるようになった
- **todo-source-map.json**: 空配列に更新

---

## 実装上の設計判断メモ

### programmatic click の React Fiber traversal
```
el[__reactFiber$xxx].memoizedProps → onClick ハンドラを検索
fiberを .return で遡って最初に onClick を持つコンポーネントを使用
SyntheticEvent互換オブジェクトを合成して渡す
```
本番ビルドでは `displayName` が消えているが、`memoizedProps.onClick` は常に存在する。

### correlator の配線
`TEXT_COORD_DELTA` → `visual_delta` イベントとして correlator に feed（既存の normalizeMessage で対応済み）
`DOM_MUTATION` → 新規で `dom_mutation` イベントとして追加（core.js のルーティングで対応）

### source-store の永続化戦略
- `cache/sources/hashes.json` に URL→hash のクロスセッションレジストリを保持
- セッションディレクトリ下の `raw/sources/content/` にファイル本文を保存
- 2秒のデバウンスで書き込み（頻繁なファイルI/Oを防ぐ）
