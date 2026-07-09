# 構想メモ: 汎用ブラウジング / TUI 改善 / intent→command

**日付:** 2026-06-25
**状態:** P1群（F/G/C/E/K）実装済。残りは構想。
**経緯:** ユーザーからのアイデア群を、有用度×実装コストで優先度付けして整理したもの。
判断・解釈は実装者（AI）側で行っている。異論があれば上書きしてよい。

**実装済 (2026-06-25, develop):**
- **F+G** — TUI フィールド編集が既入力値（文字列/数値）も検出・プリフィルして編集可に。数値フィールドは Ctrl+↑↓=±1 / Alt+↑↓=±10 でステップ（`type`/`tabId` は構造キーとして除外）。`server/tui/app.js`、unit `tests/unit/tui-field-edit.test.js`。
- **C** — `cli-shell.js` `baseCatalog()` にバックフィル：source capture / sources list・zip（capture/）、`GET /api/search`・text-coords/ui-catalog の raw スナップショット（session/）、switch/open/close_tab（action/）。`get_layout_map`/`find_target` は HTTP 面が無いため意図的に未登録（MCP専用）。
- **E** — 先頭 `!` で素のローカルシェル実行（Windows: pwsh→powershell→cmd、POSIX: `$SHELL`）。非対話・30sタイムアウト・出力は scrollback へ。HTTP/MCP には一切非公開。共有 `runShellEscape`/`shellOutputLines`（`cli-shell.js`）を TUI/classic 双方で使用。unit `tests/unit/cli-shell-escape.test.js`。
- **K** — dashboard タブ：`transition: all`（将来のレイアウトアニメ化リスク）を color+box-shadow 限定に変更し hover/focus/active をレイアウト不動に。ARIA tablist 化＋roving tabindex で ←→/Home/End/Enter/Space＋数字1-9 のキーボード操作を追加。`server/dashboard.html`。
  ※ flicker 自体は静的CSSからは再現できず（hover は元から色のみ）。最有力ハザード（transition: all）の除去＋キーボード導線で堅牢化した。

## 凡例

| 記号 | 意味 |
|---|---|
| **P1** | 高優先・即効（小さく価値が高い。今日明日で着手可） |
| **P2** | 中優先（中規模、価値はあるが設計判断が要る） |
| **P3** | 構想・大（価値は高いが大きい/不確実。腰を据えて） |
| **BUG** | 不具合報告（構想ではなく直す対象） |

## サマリ表

| # | 項目 | 優先度 | 一言 |
|---|---|---|---|
| F | TUI: → で既入力値も編集可に | ✅実装済 | 既入力の文字列/数値も検出・プリフィル。`type`/`tabId`除外 |
| C | TUI カタログのバックフィル＋登録規約 | ✅実装済 | source capture/zip・search・raw・tabs を登録。layout/find_targetは HTTP無で未登録 |
| E | TUI: 先頭 `!` で素の pwsh 実行 | ✅実装済 | pwsh→powershell→cmd / `$SHELL`。非対話・30s・HTTP/MCP非公開 |
| K | Dashboard タブの hover ちらつき | ✅実装済 | transition限定化＋ARIA tablist＋←→/数字キー。flickerは静的再現不可 |
| D | TUI: export 後の explorer ショートカット | **P2** | 保存先を開く・直近ファイルにフォーカス。ワンショット待機 |
| G | TUI: 数値引数の +/- ショートカット | ✅実装済 | Fと統合。数値フィールドで Ctrl+↑↓=±1 / Alt+↑↓=±10 |
| H | TUI: config 編集専用画面 | **P2** | 頻繁に切替える config の簡易トグル |
| I | キー送信のターゲット/フォーカス指定パイプ | **P2** | 既定（空）＝現状維持。何にフォーカスして送るか |
| A | 汎用ブラウジング/検索ツール | **P2** | navigate＋search は既存。薄いラッパで足りる説 |
| B | miniLLM intent→command | **P3** | 自然言語の意図→具体コマンドへ写像（提案優先） |
| L | 拡張 popup に接続状況/ステータス | **P3** | 独立・小だが優先度低 |
| J | go_back 以外の履歴ナビ | **P3** | forward/履歴一覧。価値は限定的 |
| M | 候補ポップアップ行に背景色 | **P1** | 半透明ターミナル越しの視認性。選択行＋説明に bg 色 |
| N | フィールド編集の enum オプション選択 | **P2** | mode 等の選択肢フィールドを → でピッカー化。編集対応コマンドの拡充も |
| O | 対象セッションの直観的切替 | **P2** | ステータスバーに対象 tabId 常時表示＋ワンキーのセッションピッカー |

---

## P1（即効）

### F. TUI フィールド編集を「既入力値」にも開く  〔BUG寄り〕
**現状:** `server/tui/app.js` の `detectFields()` は `"selector":""` / `"text":""` / `"url":"https://"` のような**空/プレースホルダだけ**を編集対象にする。値が既に入った引数（例 `"deltaY":500`）は → で編集モードに入れず、Enter 送信しかできない＝報告の「→で弄れない」。
**判断:** フィールド編集の基盤（`fieldEditor`=LineEditor、`fieldedit` モード）は完成している。不足は「編集可能フィールドの検出範囲」だけ。
**実装メモ:** `detectFields` を、JSON 値全般（文字列/数値）をフィールドとして拾うよう拡張する。空でない値は初期値としてプリフィルし、そのまま編集できるようにする。プレースホルダ（空 or `https://` 等）は従来通り。コストは小。

### C. TUI カタログのバックフィル＋「登録規約」
**現状:** `baseCatalog()` は ~27 の HTTP エンドポイント中心の**キュレーション**。今セッションの追加（`capture_sources` / `POST /api/source/capture`、`GET /api/sources/:tabId`・`/zip`、`GET /api/search`）や、tabs 系（switch/open/close）、`get_text_coords`/`get_layout_map`/`get_ui_catalog`/`find_target` 等が未登録。
**判断（「各ツールに TUI 実装をマスト化すべきか」への回答）:** ハードな必須化はしない。MCP 69 ツールの多くは agent 専用で、TUI に全部出すと逆に探しにくくなる。代わりに**軽い規約**を採る——「**人間が叩いて意味のある HTTP エンドポイントを足したら `baseCatalog` に 1 行足す**」。TUI カタログは HTTP 駆動なので、HTTP ルートを持つ機能が自然な候補。新ツール追加時のチェックリスト（CLAUDE.md か本ファイル）に 1 項目入れておく。
**即実装:** まず明らかに有用な未登録分（source capture/export、search、tabs、text-coords/layout/ui-catalog/find_target）を `capture`/`session`/`action` カテゴリにバックフィル。コスト小。

### E. TUI: 先頭 `!` で素の pwsh 実行
**狙い:** シェル内からユーザー環境の初期プロファイル端末（pwsh）へ直接コマンドを流せる「エスケープハッチ」。`!ls`, `!git status` のように。
**実装メモ:** `server/tui/app.js` の入力ハンドラで先頭 `!` を検出 → 残りを `spawn`（Windows は pwsh、なければ `process.env.ComSpec`/`SHELL`）で実行し、stdout/stderr を scrollback に流す。非対話・タイムアウト付き。`cli-shell.js`（classic）側にも同等を。セキュリティ的にはローカル端末そのものなので新たな露出は増えない（HTTP/MCP には一切出さない）。コスト中。

### K. Dashboard タブの hover ちらつき  〔BUG〕
**症状:** ダッシュボード（`http://localhost:7892/`）のタブにマウスを乗せると明滅して押せない。フォーカスが乗る/外れるを反復する「CSS アニメ途中で hover が外れて戻る gakugaku」に似た挙動。**タッチでは選べる**、という手掛かりが重要。
**仮説:** hover で**レイアウトが動く**（transform/scale/margin 変化や、hover で出現する要素がカーソル下に重なる）→ ポインタがタブから外れる→ hover 解除→ 戻る、の振動。タッチが効くのは hover 状態を持たないから。
**対応:** ダッシュボード HTML/CSS（`server` 配信の dashboard）を確認し、タブの `:hover` がレイアウトを動かさない（色/下線のみ等）よう修正。併せて**キーボード操作**（←→/数字でタブ切替）も入れておくと堅牢（ユーザーの「キーだけで操作できるべき?」に合致）。要再現調査。

---

## P2（中）

### D. TUI: export 後の explorer ショートカット
**狙い:** `export`（トランスクリプト保存）や今後の source ZIP 保存の**直後**に、ワンショットのキー（`o`=open folder / `e`=explorer / `c`=copy path など。割当は実装側裁量）で保存先を開き、**直近追加ファイルにフォーカス**。**他のキー/ボタンを一度でも触ったら待機解除**。
**実装メモ:** export 完了時に `state.pendingShortcut = { keys, action, path }` をセット → 次の 1 キーだけ横取り。Windows は `explorer /select,<file>`。汎用化すれば source ZIP / screenshot 保存にも使える。コスト中。

### G. TUI: 数値引数の +/- ショートカット
**狙い:** scroll 等、**反復的に上下微調整**したいコマンドで、現在（or 直前）入力の数値を素早く +/- する。`scroll {"deltaY":500}` の 500 を ↑↓ で増減、のような。
**判断:** scroll に限らず「細かく繰り返し調整する/切替えるコマンド」全般に効く汎用機能。フィールド編集（F）と統合すると自然——数値フィールドにフォーカス中、`Ctrl/Alt+↑↓` でステップ増減（符号も反転可）。単体ショートカットより**フィールド編集中の修飾＋矢印**が UI 的に素直。コスト中。F と一緒にやると相乗。

### H. TUI: config 編集専用画面
**狙い:** 頻繁に切替える config を TUI から簡単にトグル。特に切替頻度が高そうなキー（例: `agentControl.input.highFidelity`、`security.allowExecuteJs`、`privacy.secretGuard.enabled`、`agentControl.packedSom.*`、`mcpServer.staticTools` 等）。
**実装メモ:** `config` ビルトイン → `GET /api/config` を取得し、**よく使うキーのホワイトリスト**を一覧表示、各行で値トグル/編集 → `POST /api/config` で patch。全 config を編集させるより「ピン留めした少数キー」を即トグルできる方が実用。ピン集合は別 config か本機能内に持つ。コスト中。

### I. キー送信のターゲット/フォーカス指定パイプ
**狙い:** `press_key`/`type` で「何を選択して送るか」「直前/現在のブラウザ状況に準拠するか」を選べる調整。**未入力の初期値＝現状と同じ**（後方互換）。加えて「何にフォーカスして送るか」を指定可能に。
**実装メモ:** action に任意の `focus`（selector/text）と `target` ヒントを追加。空なら現在のフォーカス要素（＝現状動作）。executor 側で送信前に focus を当ててからキー送出。F/G の TUI フィールド編集とも噛み合う。コスト中。

### A. 汎用ブラウジング/検索ツール（MCP/HTTP/TUI）
**現状の整理:** ページ遷移は `navigate_to`/`POST /api/action navigate` で可能。セッション横断テキスト検索は `search_all_tabs`/`GET /api/search` が既存。ユーザー自身「検索バー直接操作は要らない、URL 遷移で足りるかも」と結論寄り。
**判断:** 「検索バーを直接操作」は低優先（URL 遷移で代替可）。価値があるのは「**1 アクションで検索エンジンへ遷移**」程度の薄いラッパ（例 `browse {"query":"..."}` → 検索 URL へ navigate）と、TUI への検索導線（C でバックフィル）。外部 Web 検索 API 連携まで行くと別物（P3）。まずは薄いラッパ＋導線で十分。

---

## P3（構想・大）

### B. miniLLM intent→command（自然言語の意図 → 具体コマンド）
**狙い:** 「汎用ブラウザ操作」ツールを 1 つ作り、その中で**agent が要求する実行（自然言語の意図）に適応するコマンドをローカル小モデルが自動実行 or 提案提示**する。複雑な操作やパイプが絡むものには不向き、という但し書きはユーザー自身が認識済み。
**判断:**
- **既存構想と強く重複**: [[per-tool-intent-layer]]（各コマンドに「目的」オプション＋review パイプ、軽量モデル＋アルゴリズムで判断）、[[minilm-click-text]]（click(text) への MiniLM 統合）。本件はそれらの「入口を 1 ツールに集約した版」。
- **安全側の既定**: 既定は**自動実行せず「提案提示」**。確定/パイプは人間 or agent が承認。単純な単発操作（click/type/navigate/scroll）に限定すれば誤射のリスクが低い。複雑/連鎖は「これは intent 解決の範囲外」と正直に返す。
- **モデル**: 既存の MiniLM（埋め込み）＋ルールベースの合わせ技で、まず「意図文 → 既知コマンド候補のランキング＋引数抽出」から。生成より**分類＋スロット埋め**の方が堅い（CNN 的な丸め処理云々は一旦保留、というユーザー判断に合致）。
- **優先度**: 価値は高いが面積が大きく、intent-layer 構想の一部として腰を据える。P3。

### L. 拡張 popup に接続状況/ステータス表示
**狙い:** 拡張のツールバー popup に、サーバー接続状況・セッション数・現在の収集状態などを表示。
**判断:** 独立・小〜中だが、ダッシュボード（K 含む）と機能が重なる。優先度低。やるなら `GET /health`/WS 状態を popup に出すだけの軽実装。

### J. go_back 以外の履歴ナビ
**現状:** `go_back`/`go_forward` は実装済み（advanced-actions）。
**判断:** 「普通の履歴一覧」まで要るかは限定的。タブの history を列挙して任意地点へ飛ぶ需要は低い。当面 go_back/forward で足りる。低優先。

---

## 追記 (2026-07-10): TUI UX フィードバック第2弾

利用状況: ユーザーはターミナルを半透明にしてブラウザへ被せて使う。TUI の描画は
その前提（背後に別画面が透ける）で読めなければならない。

### M. 候補ポップアップ行に背景色 〔P1〕
**現状:** 候補ポップアップ（項目＋説明）は前景色のみで、半透明ターミナルでは背後の
ページと混ざって読みにくい。
**実装メモ:** `server/tui/app.js` のポップアップ描画で、行全体（項目・説明とも）に
背景色（ANSI 48;5;x の控えめな帯）を敷く。選択行は現行ハイライトを維持しつつ
非選択行にも薄い帯——「透けても文字の後ろは塗ってある」状態にする。コスト小。

### N. フィールド編集の enum オプション選択＋対応コマンド拡充 〔P2〕
**現状:** → のフィールド編集は自由入力のみで、`mode: exact|fuzzy|semantic` のような
**選択肢フィールドをピッカーで選べない**。また → で編集に入れるコマンド自体が
まだ少ない（カタログのテンプレートにフィールドが無い/検出されない）。
**実装メモ:** カタログのテンプレートに選択肢アノテーション（例 `"mode":"exact|fuzzy|semantic"`）
を導入し、`detectFields()` が enum フィールドとして拾ったら LineEditor でなく
候補リスト（↑↓選択）を出す。合わせてカタログ全体のテンプレートを見直し、
編集可能フィールドを持つエントリを増やす（C の続き）。

### O. 対象セッションの直観的切替 〔P2〕
**現状:** コマンドごとに tabId を打ち替える必要があり、「今どのセッションが対象か」も
見えない。
**実装メモ:** ステータスバーに対象セッション（tabId＋短縮URL）を常時表示し、
ワンキー（例 Ctrl+S）でセッションピッカー（get_sessions の一覧から↑↓選択）を開く。
選択後はテンプレート埋め込み時に tabId を自動充填。「対象セッション」という
シェル状態を1つ持つだけで、既存のフィールド編集と自然に合流する。

## 既存構想との関連
- [[per-tool-intent-layer]] / [[minilm-click-text]] … B の母体。
- [[voice-and-notifications]] … 入出力チャネル（音声/通知）。intent 入力経路として B と接続し得る。
- [[cli-log-polish]] … TUI ログ整形・export --open 系。D/H と同じ TUI 改善系。
- [[ideal-features-todo]]（docs/理想機能メモ.md）… P1/P2 を昇格させる場合の置き場。

## 推奨着手順（実装するなら）
1. **F（→編集の既入力対応）＋ G（数値 +/- ）** — フィールド編集まわりを一緒に。
2. **C（カタログ・バックフィル）** — 今セッションの新機能含め未登録分を登録。
3. **E（`!` pwsh）** — 小さく効く。
4. **K（dashboard hover BUG）** — 再現確認 → CSS 修正＋キー操作。
5. 以降 D / H / I → A → B（大）。
