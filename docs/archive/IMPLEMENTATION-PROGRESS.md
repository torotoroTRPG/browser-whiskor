# browser-whiskor v3 → v4 実装進捗レポート

生成日時: 2026-05-24（最終更新: 2026-05-27 v0.3.4）

---

## ✅ 完了した実装

### 新規ファイル作成

| ファイル | 内容 | ステータス |
|---|---|---|
| `extension/injected/analyzers/css-origin.js` | CSS Origin Tracker — 4段階フォールバック、特異度計算、ルールマッチング、@layer/@scope/@media/@supports/@container カスケード順序、sourcemap VLQ デコード、Level 1 postMessage ブリッジ | ✅ 完了 |
| `extension/injected/analyzers/source-fetcher.js` | Source Layer acquisition — CSS/JSファイル取得・ハッシュ化・変更検出 | ✅ 完了 |
| `server/source-store.js` | Source file cache + cross-session hash registry | ✅ 完了 |

### TODO埋め（既存ファイル修正）

| ファイル | 変更内容 | ステータス |
|---|---|---|
| `server/mcp/tools/intelligence.js` | `explain_element`, `why_did_this_change`, `get_source_file`, `detect_site_updates` の4ツール実装 + `sourceOrigin` フィールド露出 | ✅ 完了 |
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

### Session 3 修正（2026-05-25）

| ファイル | 変更内容 |
|---|---|
| `css-origin.js` | @layer Cascade 5 spec 準拠（`buildLayerRegistry` / `flattenRules` / `Infinity=unlayered`）、sourcemap VLQ デコーダ（`vlqDecode` / `fetchSourceMap` / `resolveSourceLine`）、Level 1 getResources ブリッジ（`requestLevel1Resources` postMessage → bridge → SW → panel → getResources → 逆経路）、旧 `__SI_DEVTOOLS_CSS_CACHE__` ポーリング削除 |
| `panel.js` | `onCssOriginResourceRequest()` 新規 — `chrome.devtools.inspectedWindow.getResources()` + `getContent()` + sourceMappingURL 抽出 |
| `devtools.js` | ポーリングロジック完全削除（69行→3行）。Level 1 は panel.js が担当 |
| `bridge.js` | `reqId` 転送追加（CSS_ORIGIN_RESOURCE_REQUEST の相関 ID） |
| `sw.js` / `background.js` | CSS_ORIGIN_RESOURCE_REQUEST ルーティング（panel port 経由または空注入）+ CSS_ORIGIN_RESOURCE_RESPONSE の MAIN ワールド注入 |
| `source-fetcher.js` | `dependencies: ['css', 'css-origin']` |
| `core.js` | フレームワークSNAPSHOT分離（汎用DOM snapshot とは別ルートで correlator に feed）、STATE_HASH_REPORT/TRANSITION_HISTORY の不要 correlator 呼び出し削除、`_persistCausalChains` 引数修正 |
| `intelligence.js` | `sourceOrigin` フィールド精密マージ（`{file, line}` または `{sheetHref, sourceLine}` または null） |
| `css-origin.js` | `|| 4` → `?? 4`（nullish coalescing）— `acquisitionLevel: 0` が正しく無効化されるよう修正 |

---

## ⚠️ 残っている作業・既知の問題

### 中優先度

1. **`plugin-system.js` 依存関係フィールド未設定**
   - `_topologicalSort()` 自体は実装済み。各プラグインの `dependencies` フィールドが未設定（source-fetcher.js のみ設定済み）
   - **対応**: 各 analyzer/plugin の `dependencies` フィールドを適切に設定する

2. **`mcp-tools.json` への intelligence ツール追記**
   - `config-loader.js` のデフォルトでは有効だが `mcp-tools.json` 本体には未追記
   - **対応**: `server/configs/mcp-tools.json` に `explain_element` 他4ツールを追加

3. **Firefox MV2 manifest への analyzer 登録未完了**
   - `css-origin.js`, `source-fetcher.js` が manifest の content_scripts に未登録
   - そのためこれらの analyzer は Firefox では実際には動作しない

### 低優先度

4. **Correlator のさらなる精度改善**
   - フレームワークSNAPSHOTの correlator feed は実装済み。さらに `REACT_TRANSITION` イベントを直接 feed すると精度が上がる可能性がある

5. **source-store.js の E2E テスト不足**
   - ユニットテストは存在するが、実際の extension → server パイプラインでの E2E テストは未実施

### ✅ 以前のセッションで完了済み

- **plugin-system.js の依存解決**: `_topologicalSort()` を実装 (`installAll()` で使用)
- **read-data.js の css_origin_map**: `get_css_analysis` の返値に `css_origin_map` を追加
- **intelligence.js の on-demand collection**: polling → event-driven + ポーリングフォールバックに改善
- **Firefox 同期**: `css-origin.js`, `source-fetcher.js`, `framework-dom-map.js` を Firefox にコピー+ manifest 更新
- **manifest.json 更新**: Chrome + Firefox 両方に 3ファイルの analyzer を content_scripts に追加
- **config.json intelligence**: `plugins.{css-origin,source-fetcher,framework-dom-map}` + `intelligence` セクション追加
- **correlator feed**: `NETWORK_REQUEST/RESPONSE` + `TEXT_COORD_DELTA` + フレームワークSNAPSHOT が correlator に feed
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
- `TEXT_COORD_DELTA` → `visual_delta` イベントとして correlator に feed
- `DOM_MUTATION` → `dom_mutation` イベントとして追加
- フレームワークSNAPSHOT → correlator に feed（因果連鎖のコンテキスト改善、ただしチェーン永続化はしない）
- `STATE_HASH_REPORT` と `TRANSITION_HISTORY` は correlator に feed しない（因果連鎖に価値を追加しないため）

### source-store の永続化戦略
- `cache/sources/hashes.json` に URL→hash のクロスセッションレジストリを保持
- セッションディレクトリ下の `raw/sources/content/` にファイル本文を保存
- 2秒のデバウンスで書き込み（頻繁なファイルI/Oを防ぐ）

### CSS Origin Level 1 ブリッジの設計判断
- `chrome.devtools.inspectedWindow.eval()` による定期ポーリング → postMessage + getResources() のオンデマンド方式に置き換え
- 相関 ID（reqId）による応答照合で、複数タブ同時リクエストを安全に処理
- 500ms タイムアウトで DevTools 未開封時の graceful fallback を保証
- getResources() は DevTools ページスクリプト（panel.js）でしか利用できないため、SW→port.postMessage→panel.js の経路を使用

### || → ?? 修正の判断
- `acquisitionLevel: 0`（Level 1 無効化）は falsy 扱いで意図せず `4` にフォールバックしていた
- `||` → `??` で `undefined/null` の場合のみデフォルト値を使用するように変更
- 設定値 1・2・3・4 の動作に影響なし
