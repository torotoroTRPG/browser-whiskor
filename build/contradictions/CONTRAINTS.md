# browser-whiskor — Architecture vs Implementation Contradictions

> 生成日時: 2026-05-24  
> 基準ドキュメント: `docs/architecture.md` (v3), `docs/ideas/ARCHITECTURE_INTELLIGENCE_LAYER.md` (v4 ratified)  
> 備考: Extended Proposals (A–G) は `[PROPOSAL]` ステータスのため原則未実装でも contradiction とは見なさないが、dom-mutations.js のように部分的に実装が存在するものは記載。

---

## 凡例

| 記号 | 意味 |
|------|------|
| 🔴 CRITICAL | 実行時動作に影響。ユーザーに届く機能が欠落 |
| 🟠 HIGH | 設計通りに動かない。精度低下またはデータ欠落 |
| 🟡 MED | 設計と実装が不一致だがフォールバックが効く |
| 🔵 LOW | 軽微な不一致。リファクタリング時に是正 |

---

## 🔴 CRITICAL — 即修正が必要

### C1: clickability.js がどちらの manifest にも含まれていない

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | `extension/manifest.json` + `firefox-mv2/manifest.json` の `content_scripts` に `clickability.js` を含め、executor.js と統合する |
| 現状 | 両 manifest の `content_scripts` 配列に `clickability.js` が存在しない。executor.js:59 で `window.__SI_CLICKABILITY__` を参照するが常に undefined → 全 clickability コードがデッドパス |
| 影響 | click/right_click/analyze_click の ACTION_RESULT に `clickability` / `diagnosis` フィールドが含まれない。Subsystem 5 全体が無効 |
| 証拠 | `extension/manifest.json:26-59` に clickability.js なし。`firefox-mv2/manifest.json:19-52` に clickability.js なし。`executor.js:59` で `const analyzer = window.__SI_CLICKABILITY__`、同 60 で `if (analyzer)` は常に false |
| 修正量 | 2行追加 (両 manifest) |

---

## 🟠 HIGH — 設計通りの精度・網羅性が出ていない

### H1: Correlator Rule 2 (Framework→DOM) が実装されていない

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | Rule 2: `REACT_SNAPSHOT` / `VUE_SNAPSHOT` が DOM mutation の 100ms 以内に発生した場合、Framework→DOM の因果連鎖を生成する。信頼度ベース 0.85、Framework↔DOM Mapper 確認済みなら 1.00 |
| 現状 | `correlator.js:_correlateDomEvent()` は `network_response` の存在を前提として相関を実行する。`framework_transition` 単独では相関をトリガーしない。`_correlateFrameworkEvent()` が存在しない |
| 影響 | Framework の状態更新が原因の DOM 変化が一切検出されない。Rule 3 (composed chain) も枠組みとしては存在するが、Rule 2 の不在により「Framework のみが原因」のケースが相関されない |
| 証拠 | `correlator.js:131-172` `_correlateDomEvent()` — 冒頭の `const responses = buffer.before(...)` が network_response を検索。framework イベントは補助的証拠としてのみ使用。Rule 2 に相当する分岐なし |
| 修正量 | 新規メソッド `_correlateFrameworkEvent()` + 呼び出し箇所追加 (correlator.js) |

### H2: REACT_SNAPSHOT / VUE_SNAPSHOT が correlator に feed されていない

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | REACT_SNAPSHOT, VUE_SNAPSHOT は correlator に feed され、Rule 2/3 の入力となる |
| 現状 | `server/core.js:172-192` の該当 case 群は cache + dashboard のみを通り、correlator への feed がない |
| 影響 | Framework→DOM 相関が根本的に不可能。H1 を修正しても SNAPSHOT が correlator に届かなければ意味がない |
| 証拠 | `core.js:172-192` `case 'REACT_SNAPSHOT':` ～ `case 'PAGE_NAVIGATED':` に `this.correlator` への参照なし |
| 修正量 | core.js に +6行 (各 SNAPSHOT case に correlator feed を追加) |

### H3: Correlator CausalChain に dom.signal フィールドが欠落

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | CausalChain.dom.signal: `"mutation_observer"` | `"text_coord_delta"` — DOM 変化の検出元を区別する |
| 現状 | `correlator.js:159-165` の dom オブジェクトに `signal` フィールドがない。`eventType`, `mutationCount`, `sampleSelectors`, `summary`, `timestamp` のみ |
| 影響 | 軽微。将来 DOM_MUTATION と TEXT_COORD_DELTA の両方が同時に存在する場合の優先制御ができない |
| 証拠 | `correlator.js:159-165` — chain 組み立て箇所 |
| 修正量 | ~2行 (correlator.js) |

---

## 🟡 MED — 設計と実装の部分的不一致

### M1: DOM_MUTATION ペイロードに type と tabId 欠落

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | `{ type: "DOM_MUTATION", tabId, timestamp, batchDurationMs, records: [...] }` |
| 現状 | `dom-mutations.js:80-86` で `_api.emit('DOM_MUTATION', { timestamp, batchDurationMs, records }, true)` — type と tabId が含まれていない。`tabId` は relay 層で補完される想定だが、type は単純欠落 |
| 影響 | メッセージルーティングに支障なし (emit の event name で識別)。ただし cache-writer など payload.type を読む箇所で null になる可能性あり |
| 証拠 | `dom-mutations.js:80-86` |
| 修正量 | ~1行 |

### M2: source-fetcher.js の dependencies が空配列

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | `dependencies: ['sources']` — source-fetcher は SOURCE_CATALOG が収集した URL 一覧を利用するため依存を宣言すべき |
| 現状 | `source-fetcher.js:71` に `dependencies: []` |
| 影響 | プラグインのインストール順序が未定義。実行時には catalog が先に完了していることが多いため実際の障害は稀だが、稀なタイミングで空の catalog を読む可能性がある |
| 証拠 | `source-fetcher.js:71` |
| 修正量 | 1行 |

---

## 🔵 LOW — 軽微な不一致、または将来対応

### L1: CSS-origin Level 1 (DevTools bridge) — 実装は完了したが検証不足

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 | DevTools パネルが `chrome.devtools.inspectedWindow.eval()` 経由で全スタイルシートのフルテキストを取得し、CORS制限を回避する |
| 現状 | `devtools/devtools.js` に 5秒間隔のポーリング実装。`css-origin.js:288-298` で `__SI_DEVTOOLS_CSS_CACHE__` を読み取り。ポーリングで取得したルールテキストは `__SI_DEVTOOLS_SHEET_TEXT__` に格納されるが、実際のルール解決ロジックとどう接続されるか未検証 |
| 影響 | DevTools が開かれていないと Level 1 は機能しない (設計上既知)。ポーリングと on-demand collect の競合が未確認 |
| 修正量 | 検証・テストのみ |

### L2: アーキテクチャ文書に intelligence.js の記載がない

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求: `docs/architecture.md:449` | mcp/tools ディレクトリ配下に read.js, write.js, capture.js, control.js のみ記載。intelligence.js がない |
| 現状 | `server/mcp/tools/intelligence.js` は実際に存在し、5ツールを実装済み。ただし `docs/architecture.md` は v3 文書であり v4 の `ARCHITECTURE_INTELLIGENCE_LAYER.md` がこれをカバーしている |
| 影響 | なし (文書の更新漏れ) |
| 修正量 | `docs/architecture.md` に intelligence.js の行を追加 |

### L3: mcp-tools.json の `analyze_click` カテゴリが intelligence ではなく control と architecture に書かれている

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 (ARCHITECTURE_INTELLIGENCE_LAYER.md:991) | analyze_click の profile は "core" (→ control カテゴリ相当) と記載 |
| 現状 | mcp-tools.json:80 では `category: "intelligence"` に設定。ARCHITECTURE_INTELLIGENCE_LAYER.md の MCP TOOL ADDITIONS 表では analyze_click のみ "core" としており不一致 |
| 判断 | 現状の `intelligence` カテゴリで実用上問題なし。どちらでもよいが統一すべき |
| 修正量 | 0行 (判断委ねる) または mcp-tools.json の 1行を修正 |

### L4: state-visualizer.js が orphaned

| 項目 | 内容 |
|------|------|
| アーキテクチャ要求 (Proposal C) | `get_state_map_visual` MCP tool として登録し、`state-visualizer.js` から ASCII グラフを返す |
| 現状 | `server/state-visualizer.js` は実装されているが、どの `require()` からも参照されていない。mcp-tools.json に `get_state_map_visual` のエントリなし |
| 影響 | Proposal C は `[PROPOSAL]` ステータスのため contradiction ではない。ただしファイルが存在する以上、使われないコードがリポジトリにある状態 |
| 修正量 | 依存関係の整理: 削除するか、正式に MCP tool 化するか |

---

## サマリ: 全矛盾解決済み ✅

```
全10件の矛盾は修正完了:
  C1  →  manifest直し (2行)                  ✅ Subsystem 5 蘇生
  H1  →  correlator.js Rule 2 追加 (~30行)    ✅ Framework→DOM 相関実装
  H2  →  core.js +6行                         ✅ SNAPSHOT correlator feed
  H3  →  correlator.js +2行                   ✅ dom.signal フィールド追加
  M1  →  dom-mutations.js +1行                ✅ type フィールド追加
  M2  →  source-fetcher.js 1行                ✅ dependencies 設定済み
  L1  →  Level 1 bridge                       ✅ postMessage 方式に置換
  L2  →  docs/architecture.md                 ✅ intelligence.js 追記
  L3  →  analyze_click カテゴリ               ✅ "core" に統一
  L4  →  state-visualizer.js                  ✅ MCP tool 化
```

---

## 設計判断の自由

修正に際して、以下の原則を尊重すること:

1. **コード優位の原則**: アーキテクチャ文書よりも実際のコードが機能的に優れている場合、コードを正とし、必要に応じて文書を更新する
2. **アーキテクチャからの逸脱許容範囲**: アーキテクチャの根本思想（「エージェントは結論を受け取る」、依存関係の最小化、fallback chain による gracefull degradation）から大きく外れない限り、実装上の合理的判断を優先する
3. **最低限の修正量**: 可能な限り最小の変更で最大の効果を出す
4. **既存のコードスタイル・パターンに従う**: 既存の書き方（エラーハンドリング、null ガード、コメントスタイルなど）を模倣すること
