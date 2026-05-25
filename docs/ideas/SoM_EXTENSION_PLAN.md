# SoM (Set-of-Marks / Screen of Mind) 拡張計画

作成日: 2026-05-25
ステータス: [PLANNED] — 未実装

---

## 現状

SoM は v3.1.0 で実装済み（赤丸＋白抜き数字）。
`capture_element_screenshot` は MCPツール定義のみ存在し、SW側実装は未完了。

## フェーズ

| Phase | 内容 | 優先度 | 工数目安 |
|-------|------|--------|----------|
| 0 | 要素キャプチャSW実装（patch適用） | 高 | 1-2h |
| 1 | 背景適応型6色SoM（サンプリング＋貪欲彩色） | 高 | 4-6h |
| 2 | モデル別統計＋自動モード選択 | 中 | 8-10h |
| 3 | 選択的キャプチャ最適化（ぼかし・2値記録） | 低 | 6-10h |

詳細は `AGENT_HANDOFF.md` 参照（`C:\Users\onetr\AppData\Local\Temp\opencode\AGENT_HANDOFF.md`）。
