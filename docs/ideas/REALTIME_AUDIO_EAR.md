# Real-time audio perception channel ("ear")

**Status:** idea / exploratory (2026-06-11) — not scheduled, low priority, large in
scope. A rough capture from a free-form user memo; specifics to be worked out later.

## 概要

browser-whiskor は現在エージェントに「目」(DOM/screenshot/SoM) と「記憶」
(network/state graph) を与えているが、「耳」(リアルタイムの音声状態) は無い。ページ上
で何が鳴っているか(再生中か、音量、突然の大音量など)をエージェントが知覚できるように
する構想。録音して後から解析するような分析系は別の責務とし、ここでは**リアルタイム性**
にこだわる。

## Phase 1: 軽量ポーリングによる AUDIO_STATE (本筋)

- 既存アナライザのパターン(`perf.js` の Web Vitals ポーリング)を踏襲。
- `<audio>`/`<video>` 要素: `paused`/`muted`/`volume`/`currentTime`/`duration` を
  低頻度ポーリング。
- WebAudio 利用ページ: `AudioContext`/`AnalyserNode` を**並列**(ページ自身のグラフは
  変更しない)で挿入し、`getByteFrequencyData`/`getByteTimeDomainData` から現在の
  レベルを低頻度サンプリング。
- 新イベント `AUDIO_STATE` を emit → `core.routeMessage` / `cache-writer` で消費
  (producer/consumer contract test の対象に追加する)。
- config: `perception.audio.enabled` (デフォルト false)。`adaptiveCollection` の
  `CollectionScheduler` (two-speed cadence) と相性が良さそう
  (quiescent 時は止める/間引く)。

## Phase 2: 再生前バッファ + DSP (あわよくば、別物として)

ユーザーメモにある「実際の音が流れる前に通信をキャプチャしてハングしてからブラウザに
流す」= ジャンプスケア対策・自動音量正規化。これは **観測ではなく能動的な音声加工**
であり、Phase 1 とは性質が異なる:

- `MediaElementAudioSourceNode` で `<audio>`/`<video>` を WebAudio グラフに引き込むと、
  要素のネイティブ出力が**切断**される(明示的に再接続しないと無音になる)。ページ自身
  が WebAudio を使っている場合は二重処理・競合のリスクがある。
- `chrome.tabCapture` はタブ音声の取得(録音/配信)向けで、「取得→加工→そのタブの
  スピーカー出力へ差し替え」を行う綺麗な API は無い。
- 現実的な実装路線は前者(in-page グラフ書き換え)だが、レイテンシ(=「ハング」分の
  遅延)・グリッチ・他スクリプトとの競合リスクがあり、Phase 1 よりだいぶ大きい。
- 用途的にも「エージェントの知覚」というよりは「人間ユーザー向けのアクセシビリティ/
  安全機能」であり、whiskor 本体というより Phase 1 の tap 基盤を使った**別プロダクト/
  プラグイン**として切り出す方が自然そう。

## 関連・留意

- 秘匿ガード([[project_secret_guard]]) との境界: 対象は「ページが出力する音声」
  (ユーザーに聞こえている音) に限定し、マイク入力(ユーザーの発話/通話音声) は対象外
  とすべき — WebRTC 通話アプリ等でのプライバシー配慮。
- 「常にONじゃない」「最適化しっかり」というユーザー自身の要望どおり、デフォルト off
  + 既存のプロファイル/adaptiveCollection パターンに乗せる。

## 未決 (後日詰める)

- `AUDIO_STATE` のサンプリング頻度・データ形式 (RMS dB? FFT バケット数?)。
- WebAudio グラフへの非破壊フックの実装方式 (`AudioContext.prototype.createAnalyser`
  などのモンキーパッチ範囲)。
- Phase 2 をやるなら whiskor 本体 vs 別プロジェクトのどちらに置くか。
