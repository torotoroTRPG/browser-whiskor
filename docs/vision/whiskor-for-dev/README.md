# whiskor-for-dev — runtime 側の開発環境（構想）

**日付:** 2026-06-26
**状態:** 構想（未実装）。本フォルダはサブシステムごとの深い設計仕様を束ねる場所。
**位置づけ:** `docs/vision/` の一概念。これは個別機能というより **v4 の製品方向**の傘で、配下に層別の仕様 doc を持つ。
**経緯:** 「IDE のパイプライン図」から始まった一連の対話を、principal の立場で体系化したもの。判断・解釈は実装者（AI）側。異論があれば上書きしてよい。

---

## テーゼ

whiskor を「agent 向け観測層」から **開発環境の "runtime 側半分"** へ拡張する。
静的 IDE / LSP が扱えない領域＝「コードが実際に走った後の真実」を whiskor が持ち、
agent の **edit→verify の外側ループをライブ web app 上で閉じる**。
新規エンジンの話ではなく、**既にある相関・状態グラフ・知覚コアを正面に持ってくる**話。

---

## 統合アーキテクチャ（層構成）

```
╔══════════════════════════════════════════════════════════════════════╗
║                 whiskor — runtime 側の開発環境 (層構成)               ║
╚══════════════════════════════════════════════════════════════════════╝

┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 0 : Caller                                                      │
│   AI agent (MCP / ゲートあり)        operator (whk / ゲートなし)        │
│   click/type/navigate + 期待(expectation)                              │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ 操作 + expectation
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 1 : whiskor core                                                │
│   知覚の構造化 / def-use を「観測」 / state graph / state hash         │
│   correlate（UI↔network↔source）/  ★ loop closure 判定（期待↔実測）    │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ WS:7891 protocol（★ host 非依存）
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 2 : Host（コアをページに差す運び屋）                            │
│   ┌ Chrome/Firefox 拡張 ┐  ┌ Tauri injector ┐  ┌ engine-embed ┐       │
│   │ content-script 中継 │  │ init_script    │  │ Servo/Chromium │       │
│   └─────────────────────┘  └────────────────┘  └────────────────┘       │
│   能力 = 権限の面（manifest の壁）。トグルではない                     │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ inject + observe
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 3 : Page runtime（本物）                                        │
│   DOM / framework state / network / canvas …                          │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ invoke() IPC  /  HTTP
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LAYER 4 : Backend（自分のサーバー / Rust）＋ reporter                 │
│   ハンドラ span を同ローカルハブへ push → correlator が UI と縫う      │
└──────────────────────────────────────────────────────────────────────┘

  ★閉ループ:  LAYER0 の expectation … reload + state 復帰 …
              LAYER1〜4 の実測 → 採点(効いた/効いてない) → 自己修正
```

---

## アーキテクチャの 3 軸（混ぜると破綻する）

```
リリース (versioned artifact) : 1 本。package.json が唯一の真実
ホスト    (コアを差す場所)      : Chrome拡張 / Firefox拡張 / Tauri injector / engine-embed
モード    (実行時 UX の束)      : perception / dev / orchestration（profile system が裏）
```

`for-dev` はフォークではなく **host ＋ mode**。engine-embed のみ別 liability ゆえ将来別 repo に卒業しうる（→ [`engine-host.md`](engine-host.md)）。

---

## 本フォルダの構成（サブ仕様）

各 doc を zip-vmm 級（層図 ＋ データフロー ＋ アルゴリズム）まで深掘りする。順次作成。

| doc | 内容 | 状態 |
|---|---|---|
| `README.md`（本書） | 全体像・テーゼ・統合層図・3 軸・ロードマップ | ✅ |
| [`discussion.md`](discussion.md) | 方向性の討論メモ（D=暫定決定＋覆る条件 / F=未決分岐 / C=候補 / T=火種）。仕様に落とす前の合意形成の土台 | ✅ |
| [`2026-07-03_dev-loop-additions.md`](2026-07-03_dev-loop-additions.md) | 追記メモ: 開発者アダプタ（統合契約）・backend 代役/中継・編集→判定ループ・論理スクリーン・focus dossier。熟したら discussion へ昇格 | ✅ メモ |
| [`dev-exec.md`](dev-exec.md) | 外部成果物（ビルド済み .js）のライブ実行と判定ループ。実行プリミティブ（blob/CDP）＋ intake（inline/file/push）＋ verdict 5値＋ dev mode（明示・可視・一時）＋不変条件 I-1〜I-10。追記メモ項目2の仕様化＋項目5のツールチェーン境界を吸収 | ✅ 仕様 |
| [`host-model.md`](host-model.md) | ホスト非依存コア / 拡張 / Tauri injector / engine-embed。bridge 層と注入経路の図 | 🔮 未作成 |
| [`loop-closure.md`](loop-closure.md) | runtime expectation primitive。inner/outer loop ＋ 期待↔実測の判定フロー | 🔮 未作成 |
| [`full-stack-trace.md`](full-stack-trace.md) | UI操作→invoke/IPC→Rust→返り→UI差分の span 相関。reporter とハブのプロトコル | 🔮 未作成 |
| [`capability-model.md`](capability-model.md) | 権限の壁 / operator↔agent tier / manifest プロファイルの enforcement 図 | 🔮 未作成 |
| [`orchestration.md`](orchestration.md) | 双方向 HITL（agent→人間の要請 / 人間→agent の demonstration）＋近傍トレース primitive | 🔮 未作成 |
| [`engine-host.md`](engine-host.md) | Servo vs Chromium embed。決定ヒンジ・認証戦略・headless/CI・embed アーキ | 🔮 未作成 |

---

## ロードマップ（推奨着手順）

```
Phase 1 — 土台
  └ 🔮 Tauri injector ホスト        host-model.md     コアを Tauri webview へ注入
Phase 2 — 価値の本命
  └ 🔮 バック側 reporter（全層trace） full-stack-trace.md  IPC＋Rust span を同ハブへ
Phase 3 — ループを閉じる
  └ 🔮 loop closure primitive ＋ CI  loop-closure.md   期待↔実測の採点を無人 CI 回帰へ
横断
  ├ 🔮 capability / manifest 二面    capability-model.md
  ├ 🔮 双方向 HITL ＋ 近傍トレース    orchestration.md
  └ ⏸ engine 決定（§未決1）          engine-host.md
```

---

## 未決の分岐（ユーザー意図に依存・parked）

1. **engine ヒンジ** — 自分の Tauri アプリを将来 Servo(Verso) 出荷する線はあるか（Yes→Servo 土台 / No→Chromium 寄り＋lab Servo）。→ [`engine-host.md`](engine-host.md)
2. **アプリ層のライセンス** — open か source-available/proprietary か（本体は MIT）。
3. **着手順** — 推奨は Tauri 注入 → reporter → ループ閉鎖 CI 化（上記 Phase）。

---

## 既存 substrate との対応（greenfield ではない）

| 構想要素 | 乗る既存 |
|---|---|
| Outer loop の状態復帰 | `state-navigator` / `navigate_to_state` / `replay_session` |
| ソース逆引き | `source-correlation` / `source-index` / `source-store` |
| operator 専用 JS 注入 | `execute_js`（`allowExecuteJs` ゲート）＋ TUI `!command` の哲学 |
| 高忠実度入力 | CDP `chrome.debugger` |
| 認証の耐久解 | `type_secret` ＋ secret-guard |
| ホスト非依存コア | `shared/injected/` ＋ plugin-system のホットリロード |
| モード | profile system（`tool-profiles.json` / `tool-manager.js`） |
| 双方向 HITL | `docs/ideas/VOICE_CONTROL_AND_AGENT_NOTIFICATIONS.md` |
| 近傍トレース | `relatedInputs` の一般化 |

新規に作るのは主に：**Tauri injector ホスト** / **バック側 reporter** / **ループ閉鎖 primitive** / **近傍トレース primitive** / **engine-embed（決定後）**。

---

## 関連・メモ

- 上位: [`docs/vision/index.md`](../index.md)（vision 全体のロードマップ）
- 関連構想: `docs/ideas/NAMESPACE_MAP_AND_AI_COLLAB_VERIFICATION.md` / `VOICE_CONTROL_AND_AGENT_NOTIFICATIONS.md` / `SOURCE_UPLOAD_CORRELATION.md`
- **ライセンス（parked）**: zip-vmm は設計 doc を CC BY 4.0（コードと分離）で公開している。本フォルダを共有可能な design artifact にするなら、同様に doc だけ CC BY とする選択肢がある（本体コードは MIT）。決めるのは後日。
