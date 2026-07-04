# dev-exec — 外部成果物のライブ実行と判定ループ

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                            browser-whiskor                                   ║
║           dev-exec : Live Artifact Execution & Verdict Specification         ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

**日付:** 2026-07-03
**状態:** 設計仕様。**E1（リリース境界α）＋ E2 intake 拡張（file/push）＋ E3（判定ループ verdict engine）実装済み**（2026-07-03）。
E2 残り（cdp backend＋auto フォールバック）・E4（watchループ）・E5（慣習/レシピ）は未着手。
[`README.md`](README.md)（傘）配下のサブ仕様。[`2026-07-03_dev-loop-additions.md`](2026-07-03_dev-loop-additions.md)
の項目2（編集→判定ループ）を中核に、実行プリミティブと項目5（開発者アダプタ）のツールチェーン境界を1本の仕様に束ねたもの。
**先行実装:** 全構成部品の substrate は実在する（SECTION 11）。

**E1 実装マップ（2026-07-03）:** `server/dev-gate.js`（mode状態機械＋TTL＋origin検査／I-1,I-2,I-5,I-7）・
`server/dev-intake.js`（bare/相対import拒否＋SHA-256／D-1）・`server/dev-audit.js`（audit-before-ack／I-3,I-4）・
`shared/injected/executor.js` の `execute_module` action（blob注入・MAIN world・console/戻り値回収・origin検査はページ側で実測／I-5,I-8）・
`server/index.js` の `devExec`（gate→intake→audit→dispatch→redact／I-6。標準/proxy両対応）・
MCP `dev` プロファイル（`server/mcp/tools/dev.js` の `exec_module`/`dev_status`、`tool-manager.js` の不在原則／7.3）・
HTTP `GET /api/dev/status`・`POST /api/dev/on|off|exec`（exec は非活性時404）・`whk dev on|off|status|exec`（operator専権）・
config `dev` セクション（安全既定）＋`_check-config-defaults.js` ガード＋拡張バッジ（両background の `DEV_MODE`）。
テスト: `tests/unit/dev-exec.test.js`（39件）。

**E2 intake 拡張（2026-07-03）:** `server/dev-intake.js` の `resolveFilePath`（fileRoots realpath 閉じ込め＋symlink脱出遮断／T-2,T-5）・
`server/dev-artifacts.js`（push intake の成果物メモリLRU＝`artifactCacheMax`、ディスク非永続／I-4）・
`devExec` の `code|path|artifactId` 3経路解決・HTTP `POST /api/dev/artifact`（非活性時404）・`exec_module` に path/artifactId。

**E3 判定ループ（2026-07-03）:** 実行結果を **5値verdict＋evidence** に写像する（5.3）。
`shared/injected/executor.js` の `execute_module` に baseline（`window.__SI_CURRENT_HASH__` の compositeHash・console・error水位／5.1）＋
event-driven settle（MutationObserver＋in-flight fetch/XHR、`settleQuietMs`静穏／`settleMaxMs`上限／5.2）＋observed スナップショットを追加。
`server/dev-verdict.js` が `buildVerdict`（clean/effect/regressed/blocked/inconclusive、expectation無しでも既定判定が立つ＝新規errorゼロ∧意図せぬ遷移ゼロで clean/effect ↔ regressed を分離）＋
`verdicts.jsonl` 永続化（`maxVerdicts` cap、本文非記録／I-4,5.5）。gate/intake 拒否も `blocked` verdict として同語彙で記録。
navigated（exec中タブ遷移）は inconclusive。verdict 語彙の所有権は本仕様（loop-closure が拡張、5.4）。
**現状の範囲: blob backend のみ。evidence.delta は seam（null）＝delta-engine 連携は後続。cdp backend＋auto＝E2残り／watch＝E4。**
テスト: `tests/unit/dev-exec.test.js`（39件）。**注: verdict の実出力は実ページ tab での live 検証が要る**（unit は写像/永続化ロジックを検証、server 配線は no-tab/blocked 経路で実機確認済）。

---

dev-exec は、開発者の手元にある JavaScript 成果物（ビルド済み .js。TS 等は
ツールチェーン側で JS に落ちたもの）を、**本物のページランタイム**（実 DOM・
実フレームワーク状態・実ネットワークの上）で実行し、その帰結を構造化された
**verdict（判定）**として返すサブシステムである。

jsdom / vitest が提供するのは DOM の**シミュレーション**であり、dev-exec が
提供するのは**実測**である。両者は代替関係ではない：単体テストは既存ランナー
の領分のまま、dev-exec は「実際に走っているアプリの文脈でしか確認できないこと」
— 実フレームワークの状態遷移・実 CSS 適用下の挙動・実ネットワーク応答との
相互作用 — だけを引き受ける。

この形式が満たすべき設計要求：

- **実行単位の同一性** — 何が走ったかは常にコンテンツハッシュで一意に固定
  される。「たぶんこのファイル」は監査にも判定キャッシュにも使えない。

- **不在の原則** — dev-exec の能力は、dev モードが非活性のとき「拒否する」
  のではなく**存在しない**（ツール一覧に現れず、エンドポイントは閉じる）。
  README の「能力＝権限の壁。トグルではない」をランタイムで体現する。

- **証拠つき判定** — verdict は boolean ではない。「何が変わり、何が壊れ、
  何を根拠にそう言えるか」を添えて返す。判定に使った観測は再検査できる。

- **秘匿境界の維持** — 実行出力（console・戻り値）は秘密を含みうる。既存の
  secret-guard 境界を dev-exec が横から迂回することは許されない。

- **ツールチェーン非所有** — dev-exec はビルドしない。バンドルしない。
  トランスパイルしない。「成果物が用意できた」という事実の**消費者**である。

---

## SECTION 0 : 位置づけと非目標

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 0.1 位置づけ

```
  2026-07-03 追記メモの項目           本仕様での扱い
  ─────────────────────────────      ──────────────────────────────────────
  項目2  編集→判定ループ             ★ 中核。SECTION 5（判定ループ）＋
                                       SECTION 4.3（watch トリガー）
  項目5  開発者アダプタ               部分吸収。SECTION 4.2（ツールチェーン
                                       境界）が項目5の「入口」に相当。
                                       manifest 語彙の全体設計は項目5 に残す
  項目1  backend 代役/中継            対象外（別仕様）。ただし verdict 語彙は
                                       将来共有する（SECTION 5.4）
  項目3  論理スクリーン               対象外。verdict の evidence が論理
                                       スクリーンを参照する可能性のみ記す
  項目4  focus dossier                対象外。artifact hash の扱い（4.4）が
                                       項目4のキャッシュ鍵設計と整合
  loop-closure.md（未作成）           操作トリガーの expectation primitive は
                                       あちらが所有。dev-exec は編集/成果物
                                       トリガーの変種を所有。verdict 語彙は
                                       共通化する（5.4）
```

### 0.2 非目標（先に切る）

以下は dev-exec の領分では**ない**。要求が来ても既存ツールへ返す。

```
  N-1  単体テストランナーの代替      vitest / jest の再発明はしない。
                                     assert 収集は最小限の慣習（6.2）のみ
  N-2  ビルドオーケストレーション    watch・依存グラフ・並列化・キャッシュは
                                     npm scripts / vite / turbo の領分
  N-3  バンドラ / トランスパイラ     import 解決は成果物を作る側の仕事。
                                     dev-exec が受けるのは自己完結モジュール
                                     1ファイル（D-1）。TS→JS も同様（D-7）
  N-4  非 dev オリジンへの実行       許可オリジン外への exec は機能として
                                     存在しない。ペンテスト用途は対象外
  N-5  コード永続ストレージ          成果物本体は既定で保存しない（I-4）。
                                     ソース保管は source-store の領分
  N-6  ISOLATED world 実行           フレームワーク状態に触れない実行には
                                     現状ニーズがない。MAIN world のみ（D-6）
```

---

## SECTION 1 : 用語

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

```
  artifact        実行単位。自己完結（依存バンドル済み）の ES module 1ファイル
                  分の JS テキスト。由来は inline / file / push の3経路（4.1）

  artifact hash   artifact 本文の SHA-256。同一性・監査・キャッシュ鍵の基底

  exec            1回の実行。exec_id（ULID）で識別される。артifact hash ＋
                  対象タブ＋時刻＋backend＋結果を束ねる単位

  backend         注入機構。blob（blob URL + dynamic import）| cdp
                  （chrome.debugger / Runtime.evaluate）| auto（blob→cdp
                  フォールバック）（3.2）

  dev mode        dev 系 capability が存在する実行時状態。明示活性化・常時
                  可視・TTL 失効（7.2）。config 値ではない（D-3）

  probe           実行モードの一。走らせて戻り値・console・エラーを回収する

  harness         実行モードの一。artifact が輸出するテスト群を走らせ
                  pass/fail を構造化回収する（6.2）

  baseline        exec 直前に取る観測の基準点。state hash・console 水位・
                  エラー数（5.1）

  settle          exec 後、ページが安定するまでのイベント駆動待機（5.2）

  verdict         判定。clean | effect | regressed | blocked | inconclusive
                  の5値＋証拠（5.3）

  operator        whk CLI / ダッシュボードを操作する人間。ゲートなし tier

  agent           MCP 経由の AI。ゲートあり tier。dev mode を活性化できない
```

---

## SECTION 2 : アーキテクチャ

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2.1 データフロー全景

```
  operator                agent (MCP)             toolchain (外部)
     │ whk dev on            │ exec_module           │ ビルド完了
     │ （活性化は             │ （dev mode 活性中     │ （FS watch 検知 or
     │   operator 専権）      │   のみ可視）           │   POST /api/dev/artifact）
     ▼                       ▼                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │            dev mode（TTL つき実行時状態・拡張バッジ可視）           │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
                     ┌─ GATE ────────────────────┐
                     │ mode 活性？                │ → 不活性: ツール不在/404
                     │ origin 許可？（注入直前）   │ → 不一致: blocked
                     │ サイズ上限内？              │ → 超過:   blocked
                     └────────────┬───────────────┘
                                  ▼
                     AUDIT append（hash・initiator・origin）   ← I-3
                                  ▼
                     BASELINE capture（state hash / console 水位）
                                  ▼
                     INJECT（blob import MAIN │ CDP eval）
                                  ▼
                     SETTLE（MutationObserver ＋ network idle ＋ 上限）
                                  ▼
                     DELTA collect（delta-engine / console 新規 / 遷移）
                                  ▼
                     VERDICT 構築（5値＋evidence）
                                  ▼
                     secret-guard redaction                    ← I-6
                                  ▼
                     応答（MCP/HTTP）＋ verdicts.jsonl へ永続化
```

### 2.2 プロセス配置

dev-exec に新プロセスは要らない。既存の3者に薄い層が乗るだけである。

```
  ┌──────────────┐  MCP/HTTP   ┌──────────────────┐  WS:7891  ┌───────────────┐
  │ agent /       │────────────▶│ whiskor server   │──────────▶│ 拡張 SW        │
  │ operator /    │             │  ├ dev-gate      │           │  ├ 注入経路    │
  │ toolchain     │             │  ├ dev-audit     │           │  │ (blob/CDP)  │
  └──────────────┘             │  ├ artifact-     │           │  └ 既存 settle │
                                │  │  intake       │           └───────┬───────┘
                                │  ├ verdict-      │                   │ MAIN world
                                │  │  engine       │                   ▼
                                │  └ fs-watcher    │           ┌───────────────┐
                                └──────────────────┘           │ ページ         │
                                                               │ ランタイム     │
                                                               └───────────────┘
```

サイドカー原則（[README](README.md) 3軸・2026-07-03 の結合方針）はそのまま保たれる：
開発者のプロジェクト側は HTTP/MCP を叩くだけであり、whiskor のコードを
取り込まない。

---

## SECTION 3 : 実行プリミティブ

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 3.1 実行単位の定義

実行単位は**自己完結 ES module 1ファイル**である。

```
  受け入れる           複数文 / import 済みバンドル / top-level await /
                       export（harness モードで使用）

  受け入れない         bare import（"react" 等の未解決指定子）
                       相対 import（"./util.js"）
                       → いずれも intake 時に静的検査で拒否し、
                         「ビルドしてから渡す」旨のエラーで返す（9.1）
```

Rationale: blob URL には base URL がなく相対解決が原理的に成立しない。
bare 指定子には import map が要る。どちらも「解決」を dev-exec 側に持ち込む
＝バンドラの再発明（N-3）に直結するため、境界を**成果物の形**で切る。
import の解決は成果物を作る側（esbuild / vite / tsc --bundle 何でもよい）の
仕事であり、これは項目5の「アダプタはビルドしない」と同じ切り方である（D-1）。

既存 `execute_js`（式評価・`new Function('return (…)')`）は**一切変更しない**
（I-10）。dev-exec は別ツール・別ゲートであり、両者の関係は：

```
  execute_js    式を1つ評価する。REPL の1行に相当。既存ゲート
                （security.allowExecuteJs）のまま
  exec_module   モジュールを走らせる。ファイル1本に相当。dev mode ゲート
```

### 3.2 backend — 注入機構の二重化

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  backend    機構                          制約                           │
  │  ────────   ─────────────────────────     ─────────────────────────────  │
  │  blob       artifact を Blob URL 化し     ページ CSP の script-src に     │
  │             MAIN world から dynamic       支配される（blob: 不許可の     │
  │             import()                      ページでは失敗する）           │
  │                                                                          │
  │  cdp        chrome.debugger アタッチ →    Chrome 専用。アタッチ中は      │
  │             Runtime.evaluate              「デバッグしています」バナー。 │
  │             （awaitPromise, replMode）    ページ CSP の影響を受けない    │
  │                                                                          │
  │  auto       blob を試行し、CSP 起因の     既定値。判定は 9.1 の          │
  │  （既定）    失敗時のみ cdp へ 1 回        決定木に従う                   │
  │             フォールバック                                               │
  └──────────────────────────────────────────────────────────────────────────┘
```

Rationale: この二重化は `agentControl.input.highFidelity`（synthetic / CDP の
off/fallback/always、Chrome 専用、`debugger` 権限は導入済み）の**確立済み前例
の相似形**である。新しい権限も新しい設計判断も増やさない。Firefox は cdp を
持たないため blob 単独＝CSP 厳格ページでは `blocked(csp_blocked)` を正直に
返す。dev-exec の主対象は開発者自身の localhost アプリであり、自分の dev
サーバーの CSP は開発者が制御できるため、これは実用上の欠陥ではなく**正直な
制約**である（remediation ヒントを添える。9.1）。

評価済みの代替案として `chrome.userScripts` API（Chrome 120+）がある。
ユーザーによるブラウザ側トグルを要する点は「明示活性化」と思想が合うが、
第3の backend を管理する複雑さに現状見合わないため parked（D-2 参照）。

### 3.3 実行コンテキストと生存期間

```
  world           MAIN のみ（D-6）。フレームワーク状態・アプリの
                  グローバルに直接触れる。これが dev-exec の存在理由

  authority       ページの JS が持つ権限と完全に同一。それ以上を渡さない。
                  拡張 API・bridge ハンドル・特権コールバックは注入コードから
                  到達不能に保つ（I-8）。dev-exec のゲートが守るのは
                  「意図せぬ実行が起きないこと」であって「実行されたコードが
                  ページ内でできること」ではない — 後者はページ権限そのもの

  timeout         既定 10 000 ms（dev.exec.timeoutMs）。module の評価と
                  export された Promise の解決を含む。超過は inconclusive

  再注入           ES module は強制アンロードできない。慣習として artifact は
                  `export function __whiskor_dispose__()` を持ってよい。
                  同一 watch 系列での再注入時、前回 module が dispose を
                  輸出していれば注入前に呼ぶ。保証ではなく慣習（best effort）
                  であり、確実な初期化はページリロード＋state 復帰で行う

  タブ切替         不要。exec は captureVisibleTab と違い非アクティブタブでも
                  動作するため、autoSwitchTab の対象外とする
```

### 3.4 結果の形

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  exec 結果レコード                                                        │
  │                                                                          │
  │  field            型          内容                                       │
  │  ──────────────   ─────────   ─────────────────────────────────────────  │
  │  execId           string      ULID。全レコードの主キー                    │
  │  artifactHash     string      SHA-256 hex                                │
  │  tabId / origin   number/str  実行対象。origin は注入直前の実測値（I-5）  │
  │  initiator        string      "operator" | "agent" | "watch"             │
  │  backend          string      実際に使われた機構（auto 解決後の値）        │
  │  mode             string      "probe" | "harness"                        │
  │  value            any|marker  戻り値。JSON 化不能なら                     │
  │                               { unserializable:true, type, preview }     │
  │  consoleLogs      array       実行中に発生した console（水位差分。上限     │
  │                               dev.exec.maxConsoleEntries、既定 200）      │
  │  error            object?     未捕捉例外 { message, stack? }             │
  │  timings          object      { injectedAt, evaluatedMs, settledMs }     │
  │  verdict          object      SECTION 5.3 の verdict（判定ループ有効時）  │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## SECTION 4 : 成果物の受け入れ（intake）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 4.1 3つの intake 経路

```
  経路      入口                          用途                主 initiator
  ───────   ──────────────────────────    ─────────────────   ────────────
  inline    exec_module { code }          その場の probe      agent
  file      exec_module { path }          手元ファイル実行     operator/agent
  push      POST /api/dev/artifact        ビルド完了フック     toolchain
            { name, code | zip }          からの投げ込み
```

**file 経路の閉じ込め:** path は `dev.exec.fileRoots[]`（宣言済みプロジェクト
ルートの配列）の**内側に正規化後に収まる**ことを要求する。realpath 解決後に
検査し、symlink による脱出も塞ぐ。fileRoots が空（既定）のとき file 経路は
存在しない。これがなければ「任意 JS 実行」が「任意ファイル読取→実行」へ
静かに拡大する。

**push 経路の受け皿:** 受領した artifact は hash 計算＋メモリ保持（LRU、
`dev.exec.artifactCacheMax`、既定 32 本）し、`artifactId` を返す。以後
`exec_module { artifactId }` で参照実行できる。ディスクへは書かない（I-4）。

### 4.2 ツールチェーン境界 — 「artifact ready の消費者」

dev-exec とビルドツールの責任線は次の1行に尽きる：

```
  ビルドツールが成果物を作る。dev-exec はそれを本物のランタイムに届けて
  観測まで面倒を見る。境界は「成果物ファイル」そのもの。
```

したがって dev-exec は watch 対象として**成果物**（dist/ 等のビルド出力）を
見る。ソース（src/*.ts）は見ない。ソースを見ると「ビルドを起動する責任」が
dev-exec 側に滲み、N-2 に抵触する。開発者の既存 watch（vite build --watch、
tsc -w、esbuild --watch）が成果物を更新し、dev-exec はその更新を検知する
だけである。

```
  開発者の世界                              whiskor の世界
  ─────────────────────────────            ─────────────────────────────
  src/foo.ts ──(tsc/esbuild/vite)──▶ dist/foo.js ──(FS watch)──▶ 注入＋判定
              ここは開発者の toolchain      │        ここから dev-exec
                                           └── 境界 ＝ 成果物ファイル
```

これは項目5（開発者アダプタ）の non-goal「"artifact ready" イベントの消費者」
の最初の実装であり、この watch 設定に必要になった設定項目群が、項目5の
manifest 語彙（`whiskor.dev.json`）の**実測に基づく最初の語彙**になる
（追記メモの推奨順「スパイクから語彙を抽出」の実行）。

### 4.3 watch トリガー（編集→判定ループの「口」）

```
  arm_dev_watch { path, tabId, mode?, expectation?, reloadBefore? }

  path           fileRoots 内の成果物パス（glob 可、既定は単一ファイル）
  tabId          注入・判定対象タブ
  reloadBefore   true のとき注入前にページを再読込し、state-navigator で
                 直前 state へ復帰してから注入する（副作用の蓄積を切る）。
                 既定 false（HMR 的な上書き注入）
```

発火規律：

```
  FS イベント ──▶ debounce（dev.exec.watchDebounceMs、既定 300ms）
             ──▶ hash 計算。前回と同一 hash なら発火しない（touch 対策）
             ──▶ 実行キューへ

  キュー規律（I-9）:
    ・同時実行は 1。実行中に届いた新成果物は「最新 1 件」だけ保留し、
      それ以前の保留は破棄する（latest-wins）
    ・ビルドが 5 連発しても走るのは「実行中の 1 本＋最後の 1 本」のみ
```

Rationale: latest-wins は packed SoM のフレッシュネス連動キャッシュと同じ
判断 — 開発ループで意味があるのは常に**最新の成果物に対する判定**であり、
中間版の判定履歴に価値はない。

### 4.4 同一性とキャッシュ整合

artifact hash は verdict レコードに常に刻まれる。これは項目4（focus dossier）
が要求する「dev 文脈では編集が常態なので、分析キャッシュは source hash で
無効化しなければ実害が出る」と同じ規律の適用である：**dev-exec が走った後の
ページについての一切のキャッシュ済み結論は、そこに至った artifact hash 系列
と切り離して有効性を主張できない**。conclusion-cache 側が dev-exec の exec
履歴を無効化シグナルとして購読する（実装は将来。契約だけ先に固定する）。

---

## SECTION 5 : 判定ループ（verdict engine）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 5.1 baseline

exec 直前に、対象タブについて取る：

```
  state hash        compositeHash（state-fingerprint / FNV32）
  console 水位       console-logger の現在エントリ数（以後の新規のみを差分視）
  未捕捉エラー数     同上
  （任意）           expectation が視覚要素を含む場合のみ layout-map /
                    要素スナップショット。既定では取らない（軽量原則）
```

baseline は exec レコード内に埋め込まれ、独立永続化しない。

### 5.2 settle — イベント駆動の安定待ち

固定 sleep は使わない。既存 executor.js の post-click settle（MutationObserver
＋ popstate/hashchange のイベント駆動待機。「fetch → DOM swap」する SPA を
固定遅延が取りこぼす問題への解）**と同じ機構を再利用**する。

```
  静穏条件    直近 dev.exec.settleQuietMs（既定 500ms）に
              DOM mutation なし ∧ in-flight fetch/XHR なし
  上限        dev.exec.settleMaxMs（既定 8 000ms）。上限到達は
              「不安定なまま観測した」印を evidence に残す
```

### 5.3 verdict — 5値と証拠

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  verdict        意味                        主たる根拠                    │
  │  ────────────   ─────────────────────────   ─────────────────────────── │
  │  clean          実行成功。新規エラーなし、    console 差分ゼロ ∧          │
  │                 意図せぬ状態遷移なし          state 遷移なしまたは         │
  │                                              expectation 内              │
  │  effect         実行成功。観測可能な変化      delta-engine の差分 ∧       │
  │                 あり（expectation があれば    （expectation 指定時）       │
  │                 合致）                        その充足                     │
  │  regressed      実行はされたが壊した          新規 console error /        │
  │                                              未捕捉例外 / expectation 外  │
  │                                              の状態遷移                   │
  │  blocked        実行に至らなかった            gate 拒否 / csp_blocked /    │
  │                                              origin 不一致 / サイズ超過   │
  │  inconclusive   判定不能                      timeout / settle 上限 /      │
  │                                              exec 中のタブ遷移            │
  └──────────────────────────────────────────────────────────────────────────┘
```

verdict には必ず evidence を添える：

```
  evidence: {
    consoleNew:        [...],      // baseline 水位以降の新規エントリ（redaction 済）
    stateTransition:   {...}|null, // from/to hash とラベル（state-semantic）
    delta:             {...}|null, // delta-engine の集約差分
    expectationResult: {...}|null, // 与えられた場合のみ。充足/不足の内訳
    flags:             [...]       // "settled_at_cap" | "tab_navigated" 等
  }
```

**expectation なしでもデフォルト判定が立つ**ことが重要である（追記メモ項目2）。
「console 新規エラーゼロ・意図せぬ遷移ゼロ」だけで clean/regressed の2値は
出せるため、開発者は何も書かずに「壊してないか」を watch ループから受け取れる。

### 5.4 verdict 語彙の共有（loop-closure との契約）

この5値＋evidence の形は、将来の loop-closure.md（操作トリガーの expectation
primitive）・項目1 relay の契約アサートと**共通語彙**にする。トリガーが
「agent の click」でも「ファイル編集」でも「ワイヤ上のメッセージ」でも、
返ってくる判定の形が同じであれば、CI・agent・人間のいずれの消費者も1つの
読み方で済む。語彙の所有権は先に実装される本仕様が持ち、loop-closure 側は
これを拡張する（破壊しない）。

### 5.5 永続化

```
  cache/sessions/{tabId}/dev/verdicts.jsonl     append-only、cache-writer の
                                                アトミック書込規律に従う
  cache/sessions/{tabId}/dev/audit.jsonl        SECTION 7.4 の監査ログ
```

保持上限は `dev.exec.maxVerdicts`（既定 500 件/タブ、超過は古い方から削除）。
artifact 本文はどちらにも入らない（I-4）— hash と名前のみ。

---

## SECTION 6 : テスト実行の意味論

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 6.1 probe モード（既定）

module を評価し、default export（あれば）の解決値・console・エラーを回収する。
「この関数、実データでどう振る舞う？」に答える最短経路。

```js
// probe artifact の例（開発者が手元で書き、esbuild -bundle で1本化して渡す）
import { computeTotal } from './cart-logic.ts';   // ← バンドル時に解決済み
const state = window.__APP_STORE__.getState();
export default computeTotal(state.cart);          // 戻り値が exec 結果の value
```

### 6.2 harness モード — 最小慣習

フレームワークは提供しない。**named export の関数を順に走らせる**だけの
慣習を定める：

```
  ・artifact が `export const __whiskor_tests__ = { name: fn, ... }` を持つ
  ・各 fn を直列に await 実行。throw ＝ fail、正常帰還 ＝ pass
  ・assert は素の throw / console.assert / 任意の自前関数でよい。
    whiskor 側から assert ライブラリは注入しない
  ・結果: value が { total, passed, failed, cases: [{name, ok, error?, ms}] }
```

Rationale: assert API を whiskor が定義した瞬間、それはテストフレームワーク
になり N-1 に抵触する。throw ベースなら開発者は chai でも node:assert でも
自分のバンドルに好きなものを含められ、dev-exec は「throw したか」だけ見る。
判定は verdict 側が引き受ける（harness の fail は regressed に写像される）。

### 6.3 TS の扱い（明示）

**dev-exec は TS を受けない。** TS→JS は開発者の toolchain の仕事であり、
whiskor が esbuild/swc を内蔵することはしない（D-7）。ただし体験としては
1コマンドに折り畳める — 例（ドキュメントで配布するレシピであり機能ではない）：

```
  esbuild probe.ts --bundle --format=esm --outfile=dist/probe.js \
    && whk dev exec dist/probe.js --tab 123
  # または watch 常駐:
  esbuild probe.ts --bundle --watch ...   ＋   arm_dev_watch dist/probe.js
```

これにより「TS は一例。言語非依存」（追記メモ項目5）が構造として守られる：
wasm でも別トランスパイラ経由でも、成果物が自己完結 ES module でありさえ
すれば同じ口に乗る。

---

## SECTION 7 : セキュリティモデル

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

dev-exec は本製品で最も危険なプリミティブ（任意コード実行）に、さらに
ファイル intake を接いだものである。実装の本体はこのセクションであり、
ここが完成しない限り**いかなる部分もリリースしない**（SECTION 12）。

### 7.1 脅威モデル

```
  T-1  operator の意図なしに agent が dev 能力を得る／行使する
       → 対策: 活性化は operator 専権（I-2）。agent には活性中しか
         ツール自体が存在しない（I-1）

  T-2  意図しないオリジンでの実行（タブが要求と注入の間に遷移した、
       対象タブを取り違えた）
       → 対策: origin 許可検査は「注入直前のタブの実 origin」に対して
         行う（I-5）。要求時検査では TOCTOU が残る

  T-3  実行出力（console・戻り値）や成果物経由で秘密がディスク・agent
       文脈へ漏れる
       → 対策: 出力は secret-guard 通過後にのみ境界を出る（I-6）。
         成果物本体は永続化しない（I-4）

  T-4  編集済みソースに対して古い成果物／古い判定が使われる
       → 対策: hash 同一性（4.4）。「たぶん最新」を構造的に排除

  T-5  ローカルの別プロセスが fileRoots 内の成果物を差し替える
       → 対策: 防止はしない（ローカル FS を信用しない開発機は本仕様の
         前提外）。ただし hash が監査に刻まれるため**検知**は常に可能

  T-6  実行結果テキスト（ページ由来文字列を含む）が agent への prompt
       injection 経路になる
       → 対策: 新規表面ではない — ページ読取全般と同一クラスであり、
         既存の同スタンス（データは informational、指示として扱わない）
         に従う。dev-exec 固有の追加はしない
```

### 7.2 dev mode — 明示・可視・一時

dev mode は **config 値ではなく実行時状態**である（D-3）。

```
  活性化      whk dev on [--ttl 4h] [--project <root>]   （CLI）
              またはダッシュボードのトグル。MCP からは不可能（I-2）
              — allowAgentConfig=true であっても set_config の対象外

  可視化      活性中、拡張アイコンにバッジ（色反転）。ダッシュボード
              ヘッダに残り TTL 表示。GET /health の `dev` フィールドに
              { active, expiresAt, roots }（roots はパス自体でなく個数のみ
              — 管理パス非公開の既存方針に合わせる）

  失効        TTL（既定 4h、上限 24h）で自動失効。失効時は config-change-log
              の auto-revert と同じ経路で活性化前状態へ戻る（I-7）。
              プロセス再起動・明示 whk dev off でも失効

  範囲        対象 origin は localhost ＋ fileRoots に対応して宣言された
              origin のみ（dev.exec.allowedOrigins、既定 ["http://localhost",
              "http://127.0.0.1"]、ポート任意）
```

### 7.3 不在の原則の実装

```
  MCP     dev profile のツール（exec_module / arm_dev_watch / disarm_dev_watch /
          get_dev_verdicts）は、dev mode 非活性時 tools/list に**現れない**。
          活性化/失効で notifications/tools/list_changed を発火（既存機構）。
          staticTools=true でも dev profile だけは静的公開の対象外とする
          — 静的モードは「可視範囲を広げるだけで権限は広げない」が既存
          原則だが、dev はツールの存在自体が能力の告知になるため例外とする

  HTTP    /api/dev/* は非活性時 404（403 ではない — 存在を告知しない）

  config  committed config.json では dev セクションの能力キーは全て
          off/空。scripts/_check-config-defaults.js の検査対象に
          dev.exec.fileRoots=[] / dev.exec.enabled=false を追加し、
          個人値の config.json 混入を CI で落とす（既存ガードの拡張）
```

### 7.4 監査 — audit-before-ack

```
  全 exec は、結果を呼び出し元へ返す**前に** audit.jsonl へ追記される（I-3）:

  { ts, execId, artifactHash, artifactName?, initiator, tabId, origin,
    backend, mode, bytes, verdict }

  ・追記は cache-writer のアトミック規律（tmp→rename ではなく append だが
    1行=1レコードの JSONL であり、途中クラッシュは行単位で検出可能）
  ・audit には成果物本文・console 本文を含めない（サイズと秘匿の両面）
  ・config-change-log が「agent による設定変更」を追跡するのと同じ思想の、
    「agent によるコード実行」版である
```

### 7.5 権限を拡大しないこと

注入された module がページ権限**以上**のものに触れる経路を作らない（I-8）。
具体的には：注入は「テキストを module として評価させる」ことだけを行い、
コールバック・拡張の postMessage プロトコルの返信権・bridge の内部ハンドル
を artifact のスコープへ**引数として渡さない**。artifact が window 上の
whiskor グローバル（`__SI_*`）に触れられること自体はページ内 JS と同条件で
あり、これは新規表面ではない。

---

## SECTION 8 : インターフェイス

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 8.1 MCP ツール（新設 `dev` プロファイル）

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  tool                 引数                                                │
  │  ──────────────────   ─────────────────────────────────────────────────  │
  │  exec_module          { tabId, code? | path? | artifactId?,              │
  │                         mode? ("probe"|"harness"), expectation?,          │
  │                         backend? ("auto"|"blob"|"cdp"),                   │
  │                         verdict? (bool, 既定 true), timeoutMs? }          │
  │                       code/path/artifactId は排他。いずれか必須            │
  │                                                                          │
  │  arm_dev_watch        { path, tabId, mode?, expectation?,                │
  │                         reloadBefore?, debounceMs? } → { watchId }        │
  │                                                                          │
  │  disarm_dev_watch     { watchId }                                        │
  │                                                                          │
  │  get_dev_verdicts     { tabId?, limit?, sinceExecId? }                    │
  │                       watch 発火分を含む直近 verdict の取得                │
  └──────────────────────────────────────────────────────────────────────────┘

  プロファイル特性:
    自動トリガー   なし（キーワードで勝手にロードされない。dev mode 活性が
                   唯一の可視化条件 — 7.3）
    アイドル解除   なし（mode 失効が解除に相当）
```

### 8.2 HTTP エンドポイント

```
  POST /api/dev/exec       exec_module と同一ボディ。同一結果
  POST /api/dev/artifact   { name, code } → { artifactId, hash }  （push intake）
  POST /api/dev/watch      { arm: {...} } | { disarm: watchId }
  GET  /api/dev/verdicts   ?tabId=&limit=&sinceExecId=
  （全て dev mode 非活性時 404 — 7.3）

  whk CLI（operator 経路）:
  whk dev on [--ttl] / whk dev off / whk dev status
  whk dev exec <path> --tab <id> [--harness] [--watch]
```

### 8.3 config（`dev` セクション、全て静的ポリシー — 活性状態は含まない）

```
  dev.exec.enabled            false    ポリシーとしての総開閉。false なら
                                       whk dev on 自体が拒否される
  dev.exec.fileRoots          []       file/watch 経路の許可ルート（realpath）
  dev.exec.allowedOrigins     [localhost 系] 注入許可 origin
  dev.exec.backend            "auto"   auto | blob | cdp
  dev.exec.timeoutMs          10000
  dev.exec.settleQuietMs      500
  dev.exec.settleMaxMs        8000
  dev.exec.watchDebounceMs    300
  dev.exec.maxArtifactBytes   2097152  (2 MiB)
  dev.exec.maxConsoleEntries  200
  dev.exec.artifactCacheMax   32
  dev.exec.maxVerdicts        500
  dev.mode.defaultTtlMs       14400000 (4h)
  dev.mode.maxTtlMs           86400000 (24h)

  ・個人値は config.local.json へ（既存の分離方針）
  ・agent からは全キー read-only（permissions.agentReadOnlyPaths へ追加）。
    allowAgentConfig=true でも dev.* は set_config 不可（I-2 の config 面）
```

---

## SECTION 9 : 障害モードと回復

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 9.1 注入失敗の決定木

```
  exec 要求
   │
   ├─ dev mode 非活性 ──────────────▶ （ツール不在/404。ここへ到達しない）
   │
   ├─ intake 検査失敗
   │   ├─ bare/相対 import 検出 ────▶ blocked(unresolved_import)
   │   │                              hint: "bundle first (esbuild --bundle)"
   │   ├─ fileRoots 外 path ────────▶ blocked(path_outside_roots)
   │   └─ サイズ超過 ───────────────▶ blocked(artifact_too_large)
   │
   ├─ 注入直前 origin 検査失敗 ─────▶ blocked(origin_not_allowed)
   │                                  evidence.flags に実測 origin
   │
   ├─ blob 注入 → CSP 拒否検出
   │   ├─ backend=auto ∧ Chrome ───▶ CDP へ 1 回フォールバック
   │   │     ├─ 成功 ──────────────▶ 続行（backend:"cdp" を記録）
   │   │     └─ アタッチ失敗 ──────▶ blocked(cdp_attach_failed)
   │   ├─ backend=blob 固定 ───────▶ blocked(csp_blocked)
   │   └─ Firefox ─────────────────▶ blocked(csp_blocked)
   │         hint: "dev server の CSP に blob: を許可するか Chrome を使用"
   │
   ├─ 評価中の未捕捉例外 ──────────▶ 実行済み扱い。error に格納し
   │                                  verdict は regressed
   ├─ timeout ─────────────────────▶ inconclusive(timeout)
   └─ exec 中にタブが遷移 ─────────▶ inconclusive(tab_navigated)
                                      （遷移自体は evidence に記録 —
                                       それが artifact の効果である可能性
                                       を排除しないため）
```

### 9.2 サーバークラッシュとの関係

dev mode の活性状態はメモリ上の実行時状態であり、**クラッシュ/再起動で失効
する**（安全側に倒れる。supervisor による自動再起動後も dev mode は off）。
watch 登録も同様に失効する。audit.jsonl / verdicts.jsonl は append-only
JSONL のため、クラッシュ時の損失は最悪「最後の1行」であり、既存の起動時
リカバリ思想（半端の検出と切り捨て）に従う。

### 9.3 watch の暴走保護

debounce ＋ latest-wins（I-9）に加え、`dev.exec.watchDebounceMs` 内に
hash が変化し続ける場合（ビルドが書きかけを吐く等）は「静止してから」発火
する。1 watch あたりの発火レートに上限は設けない — latest-wins が構造的に
背圧になっており、実行が詰まっても保留は常に 1 件だからである。

---

## SECTION 10 : 不変条件

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

以下は常時成立していなければならない。違反は dev-exec のバグであって、
回復可能な実行時条件ではない。

```
  I-1   不在の原則。dev mode 非活性のとき、dev 系ツールは MCP tools/list に
        現れず、/api/dev/* は 404 を返す。「存在するが拒否する」状態を
        作らない。

  I-2   活性化は operator 専権。agent の入力（MCP ツール呼出・set_config）
        だけから dev mode が活性化される経路は存在しない。
        allowAgentConfig=true でも dev.* は set_config の対象外。

  I-3   audit-before-ack。exec の結果が呼び出し元へ返るのは、監査レコードの
        追記が完了した後である。

  I-4   成果物本文は既定で永続化されない。hash・名前・サイズは常に記録される。

  I-5   origin 検査は注入直前に、対象タブの実測 origin に対して行う。
        要求受理時の検査で代替してはならない。

  I-6   secret-guard 有効時、exec の出力（console・value・evidence）は
        redaction 通過後にのみサーバー境界（MCP 応答・HTTP 応答・ディスク）
        を出る。

  I-7   dev mode は必ず失効する。失効はプロセス再起動を要さず、活性化前の
        状態への復帰は config-change-log の auto-revert と同経路で行われる。
        サーバー再起動後の dev mode は常に off。

  I-8   exec はページ authority を拡大しない。注入コードへ拡張 API・特権
        コールバック・bridge 内部ハンドルを渡さない。

  I-9   watch キューの同時実行は 1、保留は最新 1 件のみ（latest-wins）。

  I-10  既存 execute_js の意味論・ゲート（security.allowExecuteJs）は
        本仕様によって変更されない。
```

---

## SECTION 11 : 既存 substrate との対応

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

greenfield ではない。各構成要素の乗り先：

```
  構成要素                  乗る既存                          新規部分
  ───────────────────       ──────────────────────────────    ────────────────
  注入（blob）              executor.js の action ディス       execute_module
                            パッチ＋ EXECUTE_ACTION 配管       action の追加
  注入（cdp）               sw.js executeHighFidelity の       Runtime.evaluate
                            debugger アタッチ管理              呼び出し
  settle                    executor.js post-click settle      流用（ほぼゼロ）
                            （MutationObserver＋履歴イベント）
  baseline / 遷移判定       state-fingerprint / state-         流用
                            reporter（REQUEST_STATE_HASH）
  差分                      delta-engine / correlator          流用
  console 水位              console-logger analyzer            水位カーソルのみ
  redaction                 secret-guard.js                    通過点の配線
  監査                      config-change-log の思想＋          audit.jsonl
                            cache-writer の書込規律            writer
  ツール可視性              tool-manager / tool-profiles       dev profile ＋
                            （list_changed 通知は既存）        不在原則の例外則
  ゲート前例                security.allowExecuteJs /          dev-gate
                            requiresConfig ゲート
  TTL / auto-revert         config-change-log auto-revert      mode state 管理
  file 閉じ込め             （新規）                           fileRoots 検査
  push intake               /api/source/upload の受領配管      /api/dev/artifact
  CLI                       server/cli.js（whk サブコマンド）  whk dev 系
  バッジ可視化              両 background の badge 操作         dev 表示
```

新規に書く実体は：**dev-gate（mode 状態機械＋TTL）/ artifact-intake（検査・
hash・LRU）/ verdict-engine（baseline→settle→delta→5値）/ fs-watcher
（debounce＋latest-wins）/ executor 側 execute_module action** の5点である。

---

## SECTION 12 : ロードマップとリリース境界

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

段階は実装順、リリース境界は「公開既定が安全のまま／一貫した話が1つ／秘密の
扱いに中間状態がない」の3条件で切る（難度の等高線とリリース境界を混同しない
— 2026-07-03 の R 列の規律をそのまま適用）。

```
  E1  実行プリミティブ＋ゲート＋監査          【リリース境界 α】
      execute_module action（blob）/ dev-gate（mode・TTL・バッジ・不在原則）/
      audit-before-ack / exec_module（inline のみ）/ whk dev on|off|status
      ── ゲートと監査が完成しない限り E1 は出荷しない。
         「注入だけ先に」は relay の教訓（秘匿境界に穴の開いた増分）と同型

  E2  intake 拡張                             【α に同梱可、単独でも可】
      file 経路（fileRoots 閉じ込め）/ push 経路（/api/dev/artifact）/
      cdp backend＋auto フォールバック

  E3  判定ループ                              【リリース境界 β】
      baseline / settle 流用 / delta 収集 / 5値 verdict＋evidence /
      verdicts.jsonl / get_dev_verdicts
      ── ここで初めて「実行機能」が「判定機能」になる。β のリリースノートは
         verdict 語彙の公開＝ loop-closure との共有契約の発効を意味する

  E4  watch ループ                            【リリース境界 γ ＝ 項目2 完成】
      fs-watcher（debounce・hash 同一抑止・latest-wins）/ arm/disarm /
      reloadBefore（state-navigator 復帰）
      ── γ が「編集→判定ループ」のユーザー向け成立点。追記メモ項目2 の
         スパイクはこの E4 を 1 プロジェクト分ハードコードで先行検証する
         ものであり、E1〜E3 の設計妥当性をここから逆算してよい

  E5  慣習とレシピ                            【doc のみ、随時】
      harness 慣習（__whiskor_tests__）/ __whiskor_dispose__ / TS レシピ
      （esbuild --bundle 併走）/ 項目5 manifest への語彙昇格の検討開始

  横断（全 E 共通の出荷条件）:
      _check-config-defaults.js に dev.* 既定の検査を追加 / SECURITY.md に
      dev mode の脅威モデル追記 / CLAUDE.md・http-api-reference の更新
```

依存関係：E1→E2→E3→E4 は直列。E5 は E3 以降いつでも。項目5（アダプタ
manifest）への語彙昇格は **E4 の実測の後**（先に語彙を設計しない — 追記メモ
の推奨順を維持）。

---

## APPENDIX A : 設計判断の記録

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

```
  D-1  実行単位＝自己完結バンドル
       検討: import map 提供 / サーバー側解決 / 相対 import 許可。
       却下理由: いずれも module 解決の所有＝バンドラの再発明（N-3）。
       境界を「成果物の形」で切れば、言語・toolchain 非依存が自動的に立つ。

  D-2  backend 二重化（blob / cdp / auto）
       検討: chrome.userScripts API（専用 world・CSP 緩和・ユーザートグル）。
       parked 理由: 思想は合う（明示活性化）が第3 backend の管理コストが
       現状の価値に見合わない。blob/cdp は既存前例（input highFidelity）の
       相似形で、権限追加ゼロ。userScripts は E5 以降の再評価対象。

  D-3  dev mode ＝ TTL つき実行時状態（config 値ではない）
       理由: config は「ポリシー」であり永続する。実行能力の活性化は
       「セッション」であり失効すべき。config に activate フラグを置くと
       「切り忘れ」が永続化し、7.2 の三原則（明示・可視・一時）の「一時」が
       構造的に破れる。クラッシュ後 off（9.2）もこのモデルから自然に出る。

  D-4  harness は慣習であって API ではない
       理由: assert API の提供＝テストフレームワーク化（N-1）。throw 規約
       なら開発者の既存資産（任意の assert lib）がバンドルにそのまま乗る。

  D-5  execute_js 不変・別ツール新設
       理由: 既存ツールの意味論変更は全 agent 系消費者への破壊。式評価
       （REPL 1行）と module 実行（ファイル1本）は用途が別で、ゲートも別
       （常設 config vs 一時 mode）。統合の誘惑は名前の類似だけである。

  D-6  MAIN world のみ
       理由: dev-exec の価値の源泉は実フレームワーク状態への到達。ISOLATED
       で走らせたいユースケースが実在しない。必要になれば world 引数の追加
       は後方互換で可能。

  D-7  TS 非対応（toolchain 境界の外）
       理由: esbuild/swc の内蔵は「重い npm 依存を同梱しない」既存方針
       （OCR の bring-your-own と同じ判断）に反する。かつ TS だけ特別扱い
       すると「言語非依存」（項目5）が崩れる。レシピ（6.3）で体験は保てる。

  D-8  verdict 語彙の先行所有
       理由: loop-closure / relay 契約アサートと判定の形を共有するため、
       最初に実装される dev-exec が語彙を定義し、後続は拡張のみ許す。
       逆順（先に抽象語彙を設計）は実測に根を張らない語彙を生む — 項目5
       manifest と同じ理由で却下。

  D-9  audit-before-ack（結果より監査が先）
       理由: 逆順だと「実行されたが記録がない」ウィンドウが生まれ、T-1 の
       事後検証（operator が agent の行動を監査する）が成立しない。監査
       追記は JSONL 1 行で、レイテンシ影響は無視できる。
```

---

## 関連

- 傘: [`README.md`](README.md) — 統合層図・3軸・ロードマップ
- 直接の親: [`2026-07-03_dev-loop-additions.md`](2026-07-03_dev-loop-additions.md) 項目2・5
- 討論: [`discussion.md`](discussion.md)
- 将来の共有先: `loop-closure.md`（未作成、verdict 語彙を継承する側）
- 様式の参照元: zip-vmm 設計文書群（vmdirty Journal Spec ほか）
