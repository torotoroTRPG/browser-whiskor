# click 後に navigation が発生したが `stateChanged: false` になる

## 発生日時
2026-06-13 13:04 頃

## 操作
- タブ: `orhun/ratty` GitHub リポジトリ (tabId: 1666864265)
- アクション: `POST /api/action` → `{ type: "click", text: "Releases" }`
- 対象要素: サイドバーの "Releases" リンク（`a.Link--primary.no-underline`, text: "Releases\n      5"）

## 結果
```
clickLanded: true
whatReceivedClick:
  selector: "div.BorderGrid > div.BorderGrid-row:nth-child(2) > div.BorderGrid-cell > h2.h4 > a.Link--primary"
  isTarget: true
stateChanged: false
unexpectedBehavior: "no_state_change"
```

## 問題
1. クリックは要素に正しく着弾した（`isTarget: true`）
2. 実際にはページ内ナビゲーションが発生し Releases ページが表示されていた
3. しかし whiskor が `stateChanged: false` と判定したため、エージェント側が「開けていない」と誤認識
4. 直後の `GET /api/sessions` でも URL が古いまま（`https://github.com/orhun/ratty`）返ってきた
5. 結果的に無駄な `type: "navigate"` を余計に発行してしまった

## 原因推定
- GitHub は Turbo/HTMX によるクライアントサイドルーティングを使用
- URL が変わってもページの一部しか再描画されないため、whiskor の state change 検出が反応しなかった可能性
- または session キャッシュの URL がナビゲーション後すぐに更新されなかった

## 再現性
GitHub のサイドバーリンク（Turbo 遷移）を click 操作したとき
