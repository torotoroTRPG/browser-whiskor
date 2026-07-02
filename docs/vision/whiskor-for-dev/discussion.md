# whiskor-for-dev — 方向性の討論メモ（議論用）

**日付:** 2026-06-26
**状態:** 討論中。ここの「決定」は全て provisional（暫定）。
**読み方:**
- **D = とりあえず決定** … 収束したもの。ただし各 D に **覆る条件** を併記＝固定ではない。覆る条件が満たされたら再議論。
- **F = 未決の分岐** … 本当に決まっていない。選択肢＋トレードオフ＋現状の lean。
- **C = 一回出てきた候補** … 議論に一度出た。parked（後で昇格 or 却下）。
- **T = 議論の火種** … 次に深めるべき論点（緊張・未解決の問い）。

---

## 0. 一番上の問い（親ノード）

```
                    F1: エンジンヒンジ
        「自分の Tauri アプリを Servo(Verso) で出荷するか？」
                          │
        ┌─────────────────┴─────────────────┐
       Yes                                  No
   Servo = 本番                        Chromium 寄り
   深い力がタダ                        （ecosystem 相続）
   認識論の穴 消滅                      + lab 用 Servo は任意
        │                                    │
        └──────────── どちらでも ────────────┘
              Tauri 注入 spike は engine 非依存
              ＝ F1 を parked のまま Phase1 を走れる
```

**F1 が下流を大量に決める親**。ただし最初の spike は engine 不要なので、**parked のまま前進できる**。
→ 火種 **T1**（今決めるか／parked のまま走るか）と **T4**（そもそも engine は need か want か）を参照。

---

## 1. とりあえず決定（D）— 覆る条件つき

| # | 決定 | 根拠 | 覆る条件 |
|---|---|---|---|
| **D1** | 方向性＝runtime 側の開発環境。agent の edit→verify **外側ループを閉じる** | 静的 IDE が持てない「走った後の真実」が whiskor の独占資産 | agent が静的解析だけで verify を十分閉じられると判明（runtime 観測の限界価値が低い） |
| **D2** | 3 軸分離（release 1本 / host / mode）。`for-dev`＝**host＋mode**（フォーク否） | version 単一真実を守る。フォークは shared 同期を悪化 | host 間でコアが乖離し、単一 version が虚構になる |
| **D3** | コアは**ホスト非依存**（`shared/injected/`＋WS）。host は運び屋 | 拡張・Tauri・engine を同一プロトコルで束ねられる | あるホストで WS プロトコルが性能/機能的に不適合 |
| **D4** | 静的解析は**自前実装しない**（tree-sitter/LSP に委譲）。whiskor は runtime semantic を所有し correlate | zero-dep で parser 再実装は沼。差別化は runtime 側 | 既存 LSP/tree-sitter 出力が correlate に使えず自前 parse 不可避 |
| **D5** | 能力＝**権限の面（manifest の壁）**。危険プリミティブは非 dev 配布で「**不在**」。operator↔agent の 2 tier | 安全装置付き実弾を全員に配らない。壁はプラットフォーム強制 | 1 build 維持の要請が強く manifest 2 面化が見合わない（→ runtime gate に後退。ただし危険物は依然 operator 限定） |
| **D6** | 最初の build＝**Tauri 注入 spike（engine 不要）**。`hosts/tauri-injector/` として本体 repo 内 | Tauri は OS webview＝engine clone 不要。host 軸・同一 version | Tauri webview への `initialization_script` 注入が技術的に不可（要 spike 検証） |
| **D7** | **エンジン本体は repo に入れない**（別 repo/隣ディレクトリ） | Chromium ~100GB・Servo 数 GB。別 lifecycle・別 liability | （ほぼ不動） |
| **D8** | 認証＝**復号移植しない**。耐久解＝対象で素直にログイン（`type_secret`）。便宜版＝`chrome.cookies` ハンドオフ（best-effort） | ディスク復号は infostealer 手法。ABE/DBSC/フィンガープリントで壊れる | 対象が device-binding 不使用で、ハンドオフが十分安定と実測 |
| **D9** | 全層 trace に**バック側 reporter 必須**（front✅/HTTP✅/Tauri IPC❌/Rust❌） | front 半分しか今ない。IPC は HTTP でなく見えない | UI+network だけで「効いたか」が十分判定可能と判明（→ D9 後退、T4 に関係） |
| **D10** | 欠落基本要素＝**ループ閉鎖（runtime expectation）**。着手順＝Tauri 注入→reporter→閉鎖 CI 化 | 閉ループが dev 化の核。CI 回帰が戦利品 | 本人の痛みが「状態復帰/観察」に偏り、閉鎖より先にそちら（→ F4） |
| **D11** | 近傍トレースは **server primitive**（`relatedInputs` 一般化） | 決定論的走査を agent に多数呼びさせない | 固定 primitive が硬すぎ、agent orchestration の方が柔軟と判明 |
| **D12** | headless＝**自律 verify/CI 向き**、人間 orchestration は不向き | server は元々 headless。Chrome new-headless が拡張対応 | （性質上不動）。CDP 単一クライアント地雷の回避設計は要 |
| **D13** | doc 置き場＝`docs/vision/whiskor-for-dev/`、`.md`＋fenced ASCII | ideas は軽い検討メモ。vision が深い設計の層 | design artifact として独立公開（CC BY）なら別 repo へ卒業（F2/C6） |
| **D14** | 責任分離の**分割線は "engine" に置く**：core/extension/tauri-injector＝1 repo、**engine-app のみ別 repo** | 別 liability＝CVE 保守＋配布オペ。app は core を消費・複製しない | （分割線は engine で確定。app 側の扱いは F2 のライセンス意図で変わる） |

---

## 2. 未決の分岐（F）

| # | 問い | 選択肢とトレードオフ | 現状の lean |
|---|---|---|---|
| **F1** | 自分の Tauri アプリを Servo(Verso) 出荷するか（**親**） | **Yes**＝Servo が本番＝認識論の穴消滅・深い力がタダ／賭け＝自分の app が Servo で描画されるか。 **No**＝Chromium で ecosystem 相続・本番忠実／engine 内部は触れない | 未定。T4 を解いてから |
| **F2** | アプリ層のライセンス | open(MIT) ／ source-available ／ proprietary。doc を CC BY にするか従属 | 未定（後日でよいと本人言及） |
| **F3** | engine 採用（F1 と結合しつつ独立軸あり） | **Servo**＝内部計装・決定論 replay の lab 価値／**Chromium fork・CEF・専用プロファイル**＝本番忠実＋auth＋拡張＋CDP＋import 相続 | auth エコシステムは Chromium 側に一票。lab 欲は Servo |
| **F4** | 着手順の最終確定 | 痛みが ①状態復帰 ②観察 ③効いたか判定 のどれか | ③（閉ループ）と読んでいるが要確認 |
| **F5** | dev mode と profile system の具体マッピング | dev モード＝profile 束 auto-load＋operator 開放＋アイコン。詳細未設計 | `capability-model.md` で詰める |

---

## 3. 一回出てきた候補（C）— parked

- **C1** 双方向 HITL：demonstration（hotkey 押しながら操作を覗かせる）／agent→人間クリック要請／`explain_element` 共有グラウンディング。→ `orchestration.md`、既存 `VOICE_CONTROL_AND_AGENT_NOTIFICATIONS.md`
- **C2** whiskor 自身が **runtime-backed LSP を喋る**（エディタが hover/definition/references を聞くと runtime 真実で返る）。スパイシー方向、一回出た
- **C3** **任意のブラウザ拡張作成支援**（汎用 dev アシスタント）。採用見送り寄り（採るのは「whiskor 自身の知覚器官を生やす＝adapter/analyzer をその場で」の方）
- **C4** mode 連動でアイコン変化（`action.setIcon`）
- **C5** CSS はリロード無しでホットスワップ（JS＝要 reload／CSS＝swap）
- **C6** design doc を **CC BY 4.0** で公開（zip-vmm 流。コードは MIT のまま）
- **C7** **git worktree** でサンドボックス（本体を壊さず大改造時のみ）
- **C8** engine spike → **active（2026-06-26）**: 目標は「clone→改造→build」なので prebuilt CEF は不適（あれは embed 用で改造不可）。**改造可能なソース＝Servo** が第一候補（Rust・ビルドが理解可能）。Chromium はフルビルドが重い（~100GB・数時間）。**本体 repo の外**の隔離 dir に置く（Windows のため WSL2 でのビルド推奨＝Windows toolchain の摩擦回避＋別ファイルシステムで自然に隔離）

---

## 4. 議論の火種（T）— 次に深める論点

- **T1 〔F1 をいつ解くか〕** parked のまま Phase1（Tauri 注入）を走れる。が、本人が「ブラウザ所有」を繰り返し circle している＝早めに解いた方が下流が落ち着く可能性。**いつ解くかを決める議論**。
- **T2 〔分割線の確定〕** D2（フォーク否・1 repo）と D14（責任分離・別 repo）の緊張は、「**分割線を engine に置く**」で解消する：extension+core+tauri-injector＝1 repo、engine-app だけ別 repo。**この線で確定してよいか**。
- **T3 〔manifest 2 面化の実体〕** D5 の「非 dev では危険物が不在」を、MV3 で**狭い/広い 2 manifest（または 2 build target）**としてどう実装するか。`capability-model.md` 行き。
- **T4 ★最重要〔engine は need か want か〕** 本人の**実際の痛み**（作った TS がバックを通って効いているか）は、**Tauri injector ＋ reporter ＋ ループ閉鎖だけで満たせる＝engine 同梱は要らない**。Servo/Chromium は別軸（lab／own-a-browser／Rust 核の夢）。**「所有」は commit する目標か、魅力的な隣接物か**を正直に分けると、roadmap の形と F1 の重みが決まる。
  - **→ 暫定回答（2026-06-26）:** want＝**Yes（今 spike する）**。ただし **need 列が primary** のまま。engine spike は **本体 repo の外で隔離**し、結果（① ビルド通るか ② 改造できるか ③ 自分の app が描画されるか）を **F1 の入力**にする。spike は timebox＝roadmap ではない。

---

## 5. 認知の地図（1 枚）

```
                    [need: 開発サイクルの痛みを消す]
                              │
        ┌──────────────┬──────┴───────┬──────────────┐
   Tauri injector   reporter      ループ閉鎖      近傍/HITL
   (D6, host)       (D9, trace)   (D10, 閉ループ)  (D11, C1)
        │              │              │
        └────── これだけで dev 価値は閉じる（engine 不要） ──────┘

                    [want: ブラウザを所有する]   ← T4 で need と分離
                              │
                    F1 engine ヒンジ
                              │
              ┌───────────────┴───────────────┐
          Servo(lab/本番)                 Chromium(本番相続)
          F3 / engine-host.md             F3 / engine-host.md
                              │
                    D7/D14: 別 repo・engine が分割線
```

**核心の主張（討論の出発点）:** need の列（左）は engine 同梱なしで完結する。
engine（右）は want。T4 でこの 2 つを分けることが、方向性を固める最初の一手。
（→ §6 で精緻化：owned browser が「汎用テスト基盤」として中央に来ると、左右の関係が変わる）

---

## 6. 方向の精緻化（2026-06-26 追記）— owned browser ＝ 汎用外部テスト環境

T4 の暫定回答（want＝Yes）を受けて、本人が engine の位置づけを明確化した。**Tauri はあくまで例**であり、本丸は次：

> **自分で持つ・改造できるブラウザ（Servo 想定）を、任意の web ターゲットに使える "汎用の外部開発テスト環境" にする。**

具体的な動機:
- **Tauri frontend を再ビルド無しでテスト**：Tauri アプリは毎回フルビルド（Rust 込み）が面倒。frontend を owned browser に直接ロードして素早く回したい。
- **Tauri に限らない**：任意の web 系ターゲットに簡単に injection し、外部から汎用的に使える開発テスト環境にする。
- **開いてるサイトの深層調査**も同時に（whiskor 本来の知覚）。
- **アカウントログインもできる**（owned browser に直接ログインして保持）。

この精緻化が効かせる点:
- **engine は "parked な want" から "中央基盤" へ格上げ**。`need` 列（Tauri injector / reporter / ループ閉鎖）は依然有効だが、それらが **owned browser の中でネイティブに実現**される像になる（injection は permission を乞う拡張でなく、自分が権限主体）。
- **認証の悩み（cross-engine 移植）はほぼ消える**：owned browser に直接ログイン＝profile 永続。前出の DPAPI/ABE/DBSC 問題を回避。
- **新しい load-bearing 問題が出る（discussion 行き）**：
  - **`invoke()` ギャップ** — Tauri frontend は `invoke()` IPC でバックを呼ぶ。素の owned browser で動かすと Tauri ランタイムが無く `invoke` 未定義＝アプリが壊れる。→ 実バックへ HTTP 接続 / `invoke` shim・bridge / reporter が IPC を肩代わり、のいずれか要設計。
  - **web platform fidelity** — Servo が実アプリ（React 等）を正しく描画するか（Chromium fork なら回避）。
  - **「外部から汎用的に駆動」** — 他ツール/セッション/agent が owned browser をどう制御するか（既存 WS/HTTP/MCP 面の再利用 or CDP-like）。
- **F1 への影響**：owned browser が "汎用テスト基盤" として常用されるなら、それ自体が日常 runtime ＝ F1（Servo を本番にするか）の「本番」が "出荷アプリ" でなく "自分の開発環境" に置き換わる。fidelity リスクの当事者が「ユーザー」でなく「自分」になり、賭けの性質が変わる（自分が困るだけ＝許容しやすい）。
