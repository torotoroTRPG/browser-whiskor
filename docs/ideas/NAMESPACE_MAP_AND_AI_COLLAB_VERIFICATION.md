# Namespace mapping & collaborative verification

**Status:** design notes / exploratory (2026-06-04) — not scheduled. Some parts are
CPU-heavy enough that a Rust core could be considered later.

## 概要

収集データを **保存用** と **agent 提示用** に分け、production build を相手にするときは
agent へ渡したスニペットに軽い受領確認を添えて受け取りの正しさを測り、サイト（origin）ごとに
識別子の **名前空間マップ**（出現・呼び出し形態・信頼値を伴う索引）を育てる、という一連の機能群の
設計メモ。すべて config で切り替え、初期値は off。production build マッピングは experimental 扱い
とする。

既存の `source-index` / `source-correlation`（[[project_source_upload_correlation]]）が扱う
「component → 定義ファイル」を、「識別子 → 出現・用途・信頼値の地図」へ広げる位置づけ。設計の
基調は Intelligence Layer と同じで、**agent には結論を渡し、判断の根拠（信頼値）を明示する。
確証のないものは値を作らず unknown とする**。

---

## 1. 保存と提示の分離 (cold store ↔ hot view)

whiskor は収集データをディスクに圧縮保存している（`cache-writer`, gzip の `state-store` 等）。
ここを保存層と提示層に分ける。

### Cold store（保存）

- 生データは圧縮保存（現状踏襲）。狙いは省容量と再現性。
- 逆引き索引・目次は保存時に全部は作らず、安いメタ（ファイル一覧・ハッシュ・型・サイズ）だけ
  持つ。逆引きや用途メモは **worth スコアがしきい値を超えた識別子だけ** を後追いで作る
  （lazy / scored materialization）。production の難読化名は大半がノイズなので、よく出る・
  agent が触る・相関が付いたものに索引を寄せる方が費用対効果が良い。
- worth スコアは観測から直接得られる量だけで決める（推定を混ぜない）：

  ```
  worth(identifier) =
      w_freq   * log2(1 + occurrences)        // よく出るほど
    + w_ref    * log2(1 + agentReferences)     // agent が触れるほど
    + w_corr   * correlationConfidence         // 定義が確定しているほど (0..1)
    + w_uniq   * uniquenessRatio               // 同名衝突が少ないほど (0..1)

  既定の重み: w_freq=1.0, w_ref=1.5, w_corr=2.0, w_uniq=1.0
  materialize する閾値: worth >= 4.0 （config 調整可）
  ```

  `uniquenessRatio = 1 / (同名異義クラスタ数)`（§3）。閾値・重みは config。

### Hot view（提示）

- agent へ渡すときは、生 JSON ダンプではなく構造を整え、関連部分だけを切り出す。既存
  `get_source_context` の「必要分だけ」の方針をデータ全般へ広げたもの。
- 整形は **決定的**（同じ入力で同じ出力）にする。これは §2 の受領確認で、サーバーが「スニペット内に
  何が含まれるか」の正解集合を厳密に持てるための前提でもある。
- 整形しても **原本へのポインタを必ず残す**（`{ ..., _origin: { sessionId, path, lines } }`）。
  agent が原本を要求したときに往復を増やさないため。
- config: `presentation.aiView.enabled`（初期 off）。off の間は従来どおり素のデータ。

---

## 2. 提示スニペットの受領確認 (snippet receipt verification)

production build を相手にするとき、agent には関連部分を切り出したスニペットを渡す。そのスニペットが
正しく読まれ・受領されたかを、**確認専用の往復を足さずに**測りたい。サーバーはスニペットを自分で
組んだので「正解集合」を完全に持っており、agent の自己申告に依存しない検証ができる。

### 仕組み（相乗り / piggyback）

1. スニペットを返す MCP tool result の末尾に、固定テンプレートの確認ブロックを添える。例：

   ```
   --- whiskor receipt check (id: rc_8f12) ---
   Before your next action, list the identifiers actually present in the snippet
   above, each as `name @line`. Only include ones you can see. Ignore any name
   not present.
   ```

2. サーバーは正解集合を確認ブロックの裏で保持する（agent には渡さない）：

   ```jsonc
   {
     "checkId": "rc_8f12",
     "answer": [                       // スニペットに実在する識別子（整形時に確定）
       { "name": "LoginForm", "kind": "component", "line": 12 },
       { "name": "isSubmitting", "kind": "state", "line": 27 }
     ],
     "canaries": [                     // 実在しないダミー（ホールドアウト）
       { "name": "AuthGateway" }
     ],
     "issuedAt": 1750000000000,
     "snippetHash": "sha256:..."
   }
   ```

3. agent が **次の自然なやり取り**（次の tool 呼び出しの引数やテキスト）で確認に触れたら、サーバーは
   その入力から識別子トークンと `@line` を緩く抽出し、正解集合と突き合わせる。新しい往復は発生しない。

### スコアリング

```
coverage      = |answeredCorrect| / |answer|            // 実在識別子の被覆 (0..1)
holdoutReject = 1 - |answeredCanary| / max(1,|canaries|) // カナリアを拒否できたか (0..1)
lineMatch     = |lineCorrect| / max(1,|answeredWithLine|) // @line の一致率 (0..1)

receiptConfidence = clamp(
    0.50*coverage + 0.30*holdoutReject + 0.20*lineMatch,
    0, observedScopeRatio                                 // 観測被覆で上限を抑える
)
```

`observedScopeRatio` は「このスニペット範囲を whiskor 自身がどれだけ観測で裏取りできたか」。
**確証の上限を観測範囲で頭打ちにする**ことで、agent が流暢に答えても観測外までは確信しない。
未応答（agent が確認に触れない）は減点せず `unverified` のまま据え置く（沈黙は不正解ではない）。

### ReceiptVerification スキーマ（記録）

```jsonc
{
  "checkId": "rc_8f12",
  "status": "verified" | "partial" | "rejected" | "unverified",
  "receiptConfidence": 0.0,           // unverified のときは null
  "coverage": 0.0, "holdoutReject": 1.0, "lineMatch": 0.0,
  "resolvedAt": 1750000000500
}
```

`verified`/`partial` のスニペットだけを §3 のマップへ昇格させる。`rejected`（カナリア誤答や
被覆が極端に低い）は昇格させず、必要なら一度だけ再提示（上限回数あり）。

### 注意点

- agent が確認指示を無視/別形式で答えることがある。パースは寛容にし、判定は緩く。
- tool result に指示文を足すこと自体が外部入力の経路になりうる。確認文言は固定テンプレートとし、
  **ページ由来テキストを確認指示に混ぜない**（[[project_secret_guard]] と同じく、ページの値を
  制御文に入れない）。確認ブロックは whiskor 名前空間の固定 ID で囲い、ページ内容と区別する。

---

## 3. 名前空間マップ（origin ごとの識別子索引）

ある識別子（例：component 名）の扱いは、他でどれだけ・どんな形で使われているかで変わる。単なる
name → file ではなく、識別子の出現と性質を origin 単位で索引する。

### 同名異義の分離（クラスタリング）

別箇所で同名定義されていても目的が違うことがある。単純な name キーでは混同するため、クラスタ
リングキーを **(name, 定義箇所, shape シグネチャ)** とする。

- **shape シグネチャ** は、その識別子が観測されたときの構造フィンガープリント。React なら
  props 名集合（ソート）＋ state の形＋子要素のタグ列、といった**非値**の特徴を連結して FNV32
  でハッシュする（既存 `state-fingerprint` を流用）。値そのもの・非決定的な要素（timestamp,
  UUID 等）は含めない。
- 同名でも shape が十分に違えば**別エンティティ**として別クラスタに分け、それぞれにマッピング率・
  信頼値を持たせる。同一とみなす近さは shape の一致＋定義箇所の近接で判定する。

  例：`Button` が `src/ui/Button.tsx`（props: `variant,size,onClick`）と
  `src/admin/Button.tsx`（props: `href,danger`）で観測 → shape シグネチャが異なる →
  2 クラスタとして別々に記録。`uniquenessRatio = 1/2`。

### NamespaceEntry スキーマ

```jsonc
{
  "name": "Button",
  "origin": "https://app.example.com",
  "clusters": [
    {
      "clusterId": "Button#a1b2c3",         // FNV32(name + shapeSig + defSite)
      "shapeSig": "a1b2c3d4",
      "defSites": [                          // 定義候補（確定/推定の別を持つ）
        { "file": "src/ui/Button.tsx", "line": 8, "basis": "debug-source" }
      ],
      "occurrences": 142,                    // 観測回数（事実）
      "callForms": {                         // 呼び出し形態の内訳（事実）
        "jsxElement": 130, "functionCall": 0, "import": 11, "reExport": 1
      },
      "redefinition": { "siteCount": 1 },    // 同クラスタ内の定義箇所数（事実）
      "usage": {                             // 用途（解釈 — 推定）
        "summary": "variant 付きの汎用ボタン",
        "basis": "observed-props+text",
        "confidence": 0.62,                  // 根拠が弱ければ低く、無ければ null
        "verified": true                     // §2 の受領確認を通ったか
      },
      "stats": {                             // agent 評価の蓄積（時間減衰）
        "agentTouches": 18, "lastSeen": 1750000000000, "decayScore": 7.3
      },
      "mappingRatio": 0.88                   // このクラスタの確定度
    }
  ]
}
```

### 観測事実と推定の分離（重要）

`occurrences` / `callForms` / `redefinition` のように **観測から直接言えること**と、`usage` の
ように**解釈が入るもの**を別フィールドに分ける。後者には必ず `confidence` と `verified`
（§2 を通ったか）を添え、根拠が無ければ `usage` を載せない。読み取れなければ `usage:null`。

### マッピング率

```
mappingRatio(cluster) = (定義確定 ? 0.5 : 0) + (usage.verified ? 0.5 : 0)
origin 全体の mappingRatio = Σ verified-or-resolved clusters / Σ observed clusters
```

origin 全体のマッピング率は production マッピング mode（§4）の進捗指標として出す
（「この origin は 37% マップ済み」）。

### 保存形態

```
cache/namespace-map/<origin-slug>/
  index.json          ← 目次（identifier → clusterId[]、worth、mappingRatio）。軽量
  clusters/
    <clusterId>.json  ← NamespaceEntry の cluster 本体。worth が閾値超のものだけ太る
```

重い詳細は §1 の cold store に逃がし、`index.json` は目次に徹する。逆引き（識別子→出現箇所群）は
§1 の方針に従い worth の高いものだけ materialize する。

---

## 4. production build マッピング mode（experimental・初期 off）

上記を束ねた専用モード。取得済みの production(minified) build を、観測しながら継続的に名前空間
マップへ反映する。

- 入力：難読化名、実行時の振る舞い、DOM 相関、（あれば）sourcemap。
- 解決の優先度：
  1. **sourcemap があれば** `source-map-resolver`(VLQ) で原名/原位置を得る（既存資産）。ただし
     bundle 位置が取れる経路でのみ使う（[[project_source_upload_correlation]] の T1 で「fiber には
     bundle 位置の根拠がない」とした件と整合）。`basis: "source-map"`。
  2. **無ければ** 振る舞い＋ DOM 相関で shape を取り、§2 の受領確認で意味ラベルを付け、§3 の
     マップに `confidence` 付きで記録。`basis: "behavior+receipt"`。
- config: `productionMapping.enabled`（初期 off、`experimental: true`）。
- 同名異義・再定義・呼び出し形態は §3 のクラスタリングで扱う。
- **bundle hash バージョニング**：minified バンドルは更新ごとに名前が変わる（content hash 付き
  ファイル名）。マップは bundle 識別子でバージョンを切り、差分で引き継ぐ：

  ```
  cache/namespace-map/<origin-slug>/builds/<bundleHash>/clusters/...
  current → builds/<bundleHash>   // シンボリックな最新ポインタ
  ```

  新 build 検知時、前 build のクラスタを shape シグネチャで突き合わせて確定ラベルを引き継ぎ、
  一致しないものは未確定に戻す。自動の意味推定には誤りが混じる前提で、**人間または agent が確定した
  ラベルだけを確定層（`usage.verified=true`）に上げる**。

---

## 5. データフロー（提示 → 受領確認 → マップ反映）

```
agent: get_source_context / 任意の提示系 tool 呼び出し
   │
   ▼
hot view 整形（§1）  ──→  正解集合を確定（識別子・行・canary）
   │                        │  サーバー側に ReceiptCheck を保管（agent には渡さない）
   ▼                        │
tool result（スニペット ＋ 末尾の確認ブロック rc_xxxx）
   │
   ▼
agent: 次の自然なやり取り（新往復なし）
   │
   ▼
受領確認パース（§2）→ ReceiptVerification 記録
   │
   ├─ verified / partial ─→ §3 名前空間マップへ昇格（cluster 更新、usage.verified=true）
   ├─ rejected ───────────→ 昇格させない（必要なら一度だけ再提示）
   └─ unverified ─────────→ 据え置き（減点なし）
```

---

## 6. 既存基盤との対応

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

## 7. config（追加予定）

```jsonc
{
  "presentation": {
    "aiView": { "enabled": false }            // §1 hot view 整形（初期 off）
  },
  "receiptCheck": {                           // §2 受領確認
    "enabled": false,
    "canaryCount": 1,                         // ホールドアウトを何件混ぜるか
    "maxReissue": 1,                          // rejected 時の再提示上限
    "weights": { "coverage": 0.5, "holdout": 0.3, "line": 0.2 }
  },
  "namespaceMap": {                           // §3
    "enabled": false,
    "worthThreshold": 4.0,                    // この値以上で逆引きを materialize
    "worthWeights": { "freq": 1.0, "ref": 1.5, "corr": 2.0, "uniq": 1.0 }
  },
  "productionMapping": {                      // §4
    "enabled": false,
    "experimental": true
  }
}
```

すべて初期 off。各機能は独立に有効化でき、上位が off の間は下位の記録も行わない。

---

## 8. Rust 化を検討しうる範囲

MCP / HTTP の薄い層は Node のまま、計算が重い核だけを将来 Rust に切り出す選択肢がある。

- 向く：多数の識別子のクラスタリング・shape フィンガープリント・名前空間マップの構築/差分、
  圧縮と逆引き索引、VLQ/sourcemap の大量解決、build 間 diff。CPU バウンドで並列が効く領域。
- 据え置き：MCP プロトコル、agent との対話、config、受領確認の組み立て（I/O とプロトコル寄り）。
- 接続：まずはサブプロセス境界（whiskor の supervisor / proxy 構成と相性が良い。
  [[project_crash_resilience]]）。性能が必要なら N-API を検討。

---

## 9. フェーズ分け

1. **P0 — 提示の分離**：hot view の整形 + slice を config（初期 off）で。受領確認なし。既存
   `get_source_context` の整形強化として単独で価値が出る。
2. **P1 — 受領確認（最小）**：既知スニペットに対する識別子列挙の確認 + カナリア少数。
   `ReceiptVerification` の記録のみ（マップへの反映はまだ）。サーバーが正解集合を持つので
   ユニットテスト可能（agent 応答はモック、スコア式を直接検証）。
3. **P2 — 名前空間マップ v1**：origin ごとの index、出現/形態の **事実のみ**記録、同名異義の
   クラスタリング、マッピング率の算出。用途推定はまだ載せない。
4. **P3 — production mapping mode（experimental）**：sourcemap 経路 + 推定ラベルを信頼値付きで。
   bundle hash バージョニング。
5. **P4 — Rust 核**：P2/P3 が重ければ計算核を切り出す。

各フェーズが単独で価値を持つ順序。初期はすべて off / experimental。

---

## 10. 既知の限界・未決事項

- **agent の協力は保証されない**：確認に触れないことは珍しくない。未応答を減点しない設計のため、
  マップの充填速度は agent の振る舞いに依存する（遅くなるだけで壊れはしない）。
- **受領確認の添え先**：tool result 末尾テキストで足りるか、専用メタフィールドにすべきか。agent
  実装差で拾われ方が変わる。まず末尾テキスト、駄目ならメタフィールドを検討。
- **用途推定の範囲**：どこまで agent に委ねるか、事実のみに留めるか。`usage` を別フィールド＋
  `verified` で隔離してリスクを抑える前提だが、誤ラベルが確定層に漏れない運用規則が要る。
- **マッピング率の分母**：観測した識別子全体／agent が触れたもの／可視範囲のみ。定義が揺れると
  進捗指標がぶれるため、分母を固定する規則が必要。
- **production build の更新検知**：bundle hash 変化の検知と、旧マップの破棄/引き継ぎ規則。shape
  突き合わせの誤マッチで確定ラベルを誤って引き継ぐリスク。
- **複数 agent のスタッツ集約**：多数決／重み付き／直近優先の時間減衰のどれを既定にするか。
- **プライバシー**：名前空間マップ自体に内部 component 名やエンドポイントが載りうる。秘匿ガードの
  対象に含めるか、`GET /export` 時の扱いをどうするか。
