# Namespace mapping & collaborative verification

**Status:** design notes / exploratory (2026-06-04) — not scheduled. Some parts are
CPU-heavy enough that a Rust core could be considered later.

## 概要

収集データを **保存用** と **agent 提示用** に分け、production build を相手にするときは
agent に渡したスニペットに軽い検証ステップを添えて受領の正しさを測り、サイト（origin）
ごとに識別子の **名前空間マップ**（出現・呼び出し形態・信頼値を伴う索引）を育てる、という
一連の機能群の設計メモ。すべて config で切り替え、初期値は off。production build マッピングは
experimental 扱いとする。

既存の `source-index` / `source-correlation`（[[project_source_upload_correlation]]）が扱う
「component → 定義ファイル」を、「識別子 → 出現・用途・信頼値の地図」へ広げる位置づけ。

---

## 1. 保存と提示の分離 (cold store ↔ hot view)

whiskor は収集データをディスクに圧縮保存している（`cache-writer`, gzip の `state-store` 等）。
ここを保存層と提示層に分ける。

### Cold store（保存）
- 生データは圧縮保存（現状踏襲）。狙いは省容量と再現性。
- 逆引き索引・目次は保存時に全部は作らず、安いメタ（ファイル一覧・ハッシュ・型・サイズ）だけ
  持つ。逆引きや用途メモは **評価値（worth スコア）がしきい値を超えた対象だけ** を後追いで
  作る。production の難読化名は大半がノイズなので、よく出る・agent が触る・相関が付いた
  ものに索引を寄せる方が費用対効果が良い。
- worth スコアの素材：出現頻度、agent 参照回数、相関確度、一意性（§3 のスタッツと同じ土台）。

### Hot view（提示）
- agent へ渡すときは、生 JSON ダンプではなく構造を整え、関連部分だけを切り出す。既存
  `get_source_context` の「必要分だけ」の方針をデータ全般に広げたもの。
- 整形は決定的（同じ入力で同じ出力）にし、§2 の検証で正解集合をサーバーが厳密に持てる
  ようにする。
- 整形しても原本へのポインタは必ず残す（agent が原本を要求したとき往復を増やさないため）。
- config: `presentation.aiView.enabled`（初期 off）。off の間は従来どおり素のデータ。

---

## 2. 提示スニペットの受領検証

production build を相手にするとき、agent には関連部分を切り出したスニペットを渡す。その
スニペットが正しく読まれ・受領されたかを、検証専用の往復を足さずに測りたい。

### 方法
- スニペットを返す MCP tool result の末尾に、短い確認指示を添える。例：「このスニペットに
  含まれる識別子（component 名 / state 名 / props 名）を行番号付きで挙げよ」。
- agent が次の自然なやり取り（次の tool 呼び出しやテキスト）でそれに触れたら、サーバーは
  その入力を緩くパースし、整形時に確定済みの正解集合と突き合わせる。
- 構造・行・内容が合致すれば、そのスニペットを正しく受領された入力として扱い、相関・名前
  空間マップへ反映する。ズレていれば信頼値を下げ、必要なら再提示する。
- スニペットの中身はサーバー側が用意した既知データなので、正解集合をサーバーが完全に持てる
  （agent の自己申告に依存しない）のがこの検証の前提。

### ホールドアウト
- 実際には含まれない識別子を確認対象に少数混ぜる。agent が含まれない名を「ある」と答えたら、
  読まずに補完した兆候として信頼値を下げる材料にする。

### 信頼値
- スコア素材：正解の被覆率、ホールドアウト識別子の拒否率、行番号・構造の一致度、同一
  スニペットに対する複数回・複数 agent の合意。
- 信頼値は「whiskor が観測できた範囲で何割裏が取れたか」を表す。確証のないものは値を作らず
  unknown とする（根拠に直結する表現にとどめる方針。[[project_related_inputs]] と同じ）。

### 注意点
- agent が確認指示を無視したり別形式で答えることがある。パースは寛容にし、未応答は「未検証」
  のまま据え置く（沈黙を不正解として減点しない）。
- tool result に指示文を足すこと自体が外部入力の経路になりうる。確認文言は固定テンプレート
  とし、ページ由来のテキストを混ぜない（[[project_secret_guard]] と同じく、ページの値を制御
  文に入れない）。
- 理想的には追加往復は発生しないが、再提示が要る場合は上限回数を設ける。

---

## 3. 名前空間マップ（origin ごとの識別子索引）

ある識別子（例：component 名）の扱いは、他でどれだけ・どんな形で使われているかで変わる。
単なる name → file ではなく、識別子の出現と性質を origin 単位で索引する。

### 1 識別子に持たせる情報
- 出現：回数、出現箇所、呼び出し形態（JSX 要素 / 関数呼び出し / import / 再 export）。
- 定義：定義候補箇所、再定義の頻度（同名が複数箇所で定義されているか）。
- 用途：観測から読み取れる範囲の説明。読み取れなければ unknown とする。
- マッピング率：観測した識別子のうち定義/用途まで確定できた割合。
- 信頼値：§2 の検証で得た値の履歴。
- スタッツ：別のやり取りで agent がこの識別子をどう扱ったかの記録（[[project_packed_som_capture]]
  の `som-stats` の時間減衰スコアと同型）。

### 同名異義の分離
- 別箇所で同名定義されていても目的が違うことがある。単純な name キーでは混同するため、
  クラスタリングキーを **(name, 定義箇所, shape シグネチャ)** とする。shape は props 名集合 /
  state 形 / 子要素パターンなどのフィンガープリント（既存の `state-fingerprint` の FNV32 を
  流用可能）。同名でも shape が違えば別エンティティとして分けて載せる。

### 観測事実と推定の分離
- 出現形態・回数・相関のように観測から直接言えることと、用途の推定のように解釈が入るものは
  別フィールドに分ける。後者には信頼値と検証済み/未検証を必ず添える。

### 保存形態
- origin ごとに 1 つの索引（`cache/namespace-map/<origin>/index.json`）。重い詳細は §1 の
  cold store に逃がし、index は目次に徹する。逆引きは §1 の方針に従い worth の高いものだけ
  太らせる。

---

## 4. production build マッピング mode（experimental・初期 off）

上記を束ねた専用モード。取得済みの production(minified) build を、観測しながら継続的に名前
空間マップへ反映する。

- 入力：難読化名、実行時の振る舞い、DOM 相関、（あれば）sourcemap。
- 解決の優先度：sourcemap があれば `source-map-resolver`(VLQ) で原名/原位置を得る（既存資産。
  ただし bundle 位置が取れる経路でのみ使う。[[project_source_upload_correlation]] の T1 で
  「fiber には bundle 位置の根拠がない」とした件と整合）。無ければ振る舞いと §2 の検証で意味
  ラベルを付け、§3 のマップに信頼値付きで記録する。
- config: `productionMapping.enabled`（初期 off、experimental 明記）。
- 同名異義・再定義・呼び出し形態は §3 のクラスタリングで扱い、マッピング率を進捗指標として
  出す。
- minified バンドルは更新ごとに名前が変わる（content hash 付きファイル名）。マップは bundle
  hash でバージョニングし、差分で引き継ぐ。自動の意味推定には誤りが混じる前提で、人間または
  agent が確定したラベルだけを確定層に上げる。

---

## 5. 既存基盤との対応

| 構想要素 | 流用できる既存 |
|---|---|
| cold store / 圧縮 / 索引 | `cache-writer`, `state-store`(gzip+LRU), `state-persistence` |
| shape フィンガープリント | `state-fingerprint`(FNV32) |
| スタッツ / 時間減衰スコア | `som-stats`（[[project_packed_som_capture]]） |
| 鮮度・無効化 | `som-cache`, `conclusion-cache`(SHA-256 無効化) |
| sourcemap 解決 | `source-map-resolver`(VLQ) |
| 相関土台 | `source-index`, `source-correlation`（[[project_source_upload_correlation]]） |
| 秘匿の越境防止 | `secret-guard`（[[project_secret_guard]]） |

---

## 6. Rust 化を検討しうる範囲

MCP / HTTP の薄い層は Node のまま、計算が重い核だけを将来 Rust に切り出す選択肢がある。

- 向く：多数の識別子のクラスタリング・shape フィンガープリント・名前空間マップの構築/差分、
  圧縮と逆引き索引、VLQ/sourcemap の大量解決、build 間 diff。CPU バウンドで並列が効く領域。
- 据え置き：MCP プロトコル、agent との対話、config、検証の組み立て（I/O とプロトコル寄り）。
- 接続：まずはサブプロセス境界（whiskor の supervisor / proxy 構成と相性が良い。
  [[project_crash_resilience]]）。性能が必要なら N-API を検討。

---

## 7. フェーズ分け

1. **P0 — 提示の分離**：hot view の整形 + slice を config（初期 off）で。検証なし。既存
   `get_source_context` の整形強化として単独で価値が出る。
2. **P1 — 受領検証（最小）**：既知スニペットに対する識別子列挙の確認 + ホールドアウト少数。
   信頼値の記録のみ（マップへの反映はまだ）。サーバーが正解集合を持つのでユニットテスト可能
   （agent 応答はモック）。
3. **P2 — 名前空間マップ v1**：origin ごとの index、出現/形態の事実のみ記録、同名異義の
   クラスタリング、マッピング率の算出。用途推定はまだ載せない。
4. **P3 — production mapping mode（experimental）**：sourcemap 経路 + 推定ラベルを信頼値付き
   で。bundle hash バージョニング。
5. **P4 — Rust 核**：P2/P3 が重ければ計算核を切り出す。

各フェーズが単独で価値を持つ順序。初期はすべて off / experimental。

---

## 8. 未決事項

- 検証確認の添え先：tool result 末尾テキストで足りるか、専用メタフィールドにすべきか（agent
  実装差で拾われ方が変わる）。
- 用途推定をどこまで agent に委ねるか、事実のみに留めるか。
- マッピング率の分母の定義（観測した識別子全体 / agent が触れたもの / 可視範囲のみ）。
- production build の更新検知（bundle hash 変化）と古いマップの破棄/引き継ぎ規則。
- 複数 agent のスタッツの集約方法（多数決 / 重み付き / 直近優先の時間減衰）。
- プライバシー：名前空間マップ自体に内部 component 名やエンドポイントが載りうる。秘匿ガードの
  対象に含めるか、エクスポート時の扱いをどうするか。
