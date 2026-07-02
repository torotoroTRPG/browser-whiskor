# Self-update（新コードのダウンロード＆置換）

Status: 設計のみ（2026-07-02）。未実装。config に `updateCheck.selfUpdate`（既定 false・現状 inert）の seam だけ確保済み。

## 現状（実装済みの土台）

起動時の**バージョン確認と通知**は実装済み（`server/update-checker.js`）:
- `docs/version.json`（Pages = main:/docs、`npm version` で自動同期）を fetch → package.json 版と semver 比較
- 新版があれば: ログ ＋ `GET /health` の `update` ＋ ダッシュボードバナー ＋ デスクトップ通知（`scripts/_notify.js`、`updateCheck.osToast`）
- `updateCheck.autoSetup`（opt-in）は **ローカル既存ファイル**を `whk setup` で拡張へ反映＋リロードするだけ。**新コードのDLはしない**

この doc が扱うのは、その先の「新コードを実際に取得して入れ替える」自動化。

## なぜ別スライスか（リスクが段違い）

1. **インストール形態で挙動が根本的に変わる**
   - **git clone（開発）**: 更新＝`git pull`。WIP を抱えた作業ツリーで自動 pull は未コミット変更/コンフリクトを踏むので**やらない**（検出＋通知に留める）
   - **リリースZIP（配布インストール）**: 更新＝新ZIPをDLして展開。selfUpdate が意味を持つのはこちら
2. **稼働中インストールの上書きは脆い**: 実行中の `server/*.js` の置換（Windows は使用中ファイルロック）。半端適用を避けるため staged swap（tmp展開→atomic rename、既存 `extension-installer.js` と同方式）が必須
3. **供給網リスク**: 「起動時に自動でコード取得＆実行」は強力かつ危険。自分の release でも **SHA256 検証必須**（release.yml が `SHA256SUMS.txt` を publish 済み＝検証材料あり）。必ず opt-in・明示ログ

## 設計スケッチ

`updateCheck.selfUpdate: true`（opt-in）かつ **bundle インストール**のときのみ発火。git チェックアウト検出時は無効（通知のみ）。

```
1. 検出      updateAvailable（既存の update-checker）
2. install種別判定  .git があれば git checkout → selfUpdate 無効（通知のみ）
                    無ければ bundle → 続行
3. DL         browser-whiskor-full-<latest>.zip を release からストリーム取得（zip-reader.js 流用）
4. 検証       SHA256SUMS.txt と突合。不一致なら中止＋警告
5. staged swap  .update-staging/ へ展開 → 検証済みツリーを atomic に入れ替え
                （node_modules・cache・config.local.json・secrets.local.json は保持）
6. whk setup    落とした拡張ファイルを管理ディレクトリへ反映＋拡張リロード（＝autoSetup 連鎖）
7. supervised restart  supervisor に新コードで再起動を依頼（非ゼロ終了で自動再起動 or 専用シグナル）
```

- **ユーザーの「DL→setup自動」の直感はここ**（ステップ6が setup 連鎖）。selfUpdate は autoSetup を内包する
- ロールバック: 旧ツリーを1世代 `.update-backup/` に退避し、起動 self-check 失敗時に戻す
- config.local.json / secrets.local.json / cache / node_modules は swap 対象外（消さない）

## 論点

- Windows のファイルロック（実行中の .js は置換できることが多いが、ネイティブモジュールや開いたハンドルは注意）
- supervisor 連携の再起動プロトコル（現状は「非ゼロ終了で再起動」。self-update 用に意図した再起動経路が要る）
- 署名（SHA256 は改竄検知だが真正性は GitHub の TLS/リリース権限に依存。将来的に minisign 等の署名も検討可）
- 既定は必ず off。UI/ログで「自動更新が入る」ことを明示

関連: 通知側は実装済み（[[project_update_check]]）。autoSetup の限界（新コードDLしない）もそこに記載。
