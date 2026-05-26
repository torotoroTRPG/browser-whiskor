/**
 * server/delta-engine.js
 *
 * Smart Delta Aggregator: TEXT_COORD_DELTA を「意味のあるイベント」に変換。
 *
 * 機能:
 *   1. Motion Clustering: 同じベクトルで動く要素をグループ化
 *   2. CSS Animation Filtering: 装飾的アニメーションを無視
 *   3. Pattern Registry Integration: 既知パターンは ref のみ送信
 *   4. Ring Buffer: 最新 N フレームを保持し、集約して送信
 */
'use strict';

const patternRegistry = require('./pattern-registry');

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_BUFFER_SIZE    = 5;       // 保持するフレーム数
const AGGREGATE_INTERVAL = 1500;    // 集約間隔 (ms)
const SCROLL_THRESHOLD   = 0.7;     // 70%以上の要素が同じ動きならスクロール判定
const VECTOR_TOLERANCE   = 3;       // ベクトル一致の許容誤差 (px)

// CSS animation で動いていても無視する要素の判定基準
const IGNORED_CHANGE_TYPES = new Set([
  'opacity-only',     // 透明度のみ
  'color-only',       // 色のみ
  'background-only',  // 背景のみ
  'shadow-only',      // シャドウのみ
]);

// ── State ─────────────────────────────────────────────────────────────────────
const tabBuffers = new Map(); // tabId -> { frames: [], timer: null, lastVp: null }

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * ベクトルが許容範囲内で一致しているか
 */
function vectorsMatch(a, b, tolerance = VECTOR_TOLERANCE) {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/**
 * 変化が「装飾的」かどうかを判定（無視すべきCSSアニメーション）
 */
function isDecorativeChange(delta) {
  // 位置・サイズ・テキストの変化がない = 装飾的
  const hasPositionChange = (delta.dx !== 0 || delta.dy !== 0);
  const hasSizeChange     = (delta.dw !== 0 || delta.dh !== 0);
  const hasTextChange     = delta.textChanged === true;
  const hasStateChange    = delta.stateChanged === true;

  return !hasPositionChange && !hasSizeChange && !hasTextChange && !hasStateChange;
}

/**
 * 要素リストを動きのベクトルでクラスタリング
 * @param {Array} deltas - 要素の差分リスト
 * @returns {Array} クラスタ [{ vector, elements, count }]
 */
function clusterByVector(deltas) {
  const clusters = [];

  for (const d of deltas) {
    const vec = { x: d.dx || 0, y: d.dy || 0 };

    // 既存クラスタにマッチするか確認
    let matched = false;
    for (const cluster of clusters) {
      if (vectorsMatch(cluster.vector, vec)) {
        cluster.elements.push(d);
        cluster.count++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({ vector: vec, elements: [d], count: 1 });
    }
  }

  return clusters;
}

/**
 * スクロール判定: 大部分の要素が同じベクトルで動いているか
 */
function detectScroll(clusters, totalElements) {
  if (totalElements < 3) return null;

  for (const cluster of clusters) {
    const ratio = cluster.count / totalElements;
    if (ratio >= SCROLL_THRESHOLD && (cluster.vector.x !== 0 || cluster.vector.y !== 0)) {
      return {
        type: 'scroll',
        vector: cluster.vector,
        affectedCount: cluster.count,
      };
    }
  }
  return null;
}

/**
 * フレームデータをスマートデルタに変換
 * @param {Array} frames - バッファ内のフレーム
 * @param {string} tabId
 * @returns {object}
 */
function buildSmartDelta(frames, tabId) {
  if (!frames.length) return null;

  const allDeltas = [];
  let viewportChange = null;
  const newPatterns = [];
  const knownPatterns = [];

  // 全フレームのデルタを収集
  for (const frame of frames) {
    if (frame.viewport) {
      viewportChange = {
        from: frame.viewport.from,
        to: frame.viewport.to,
        delta: {
          x: (frame.viewport.to?.scrollX || 0) - (frame.viewport.from?.scrollX || 0),
          y: (frame.viewport.to?.scrollY || 0) - (frame.viewport.from?.scrollY || 0),
        },
      };
    }

    if (frame.deltas) {
      for (const d of frame.deltas) {
        // 装飾的変化はスキップ
        if (isDecorativeChange(d)) continue;
        allDeltas.push(d);
      }
    }
  }

  // ベクトルクラスタリング (appeared/disappeared は除外)
  const motionDeltas = allDeltas.filter(d => !d.appeared && !d.disappeared);
  const clusters = clusterByVector(motionDeltas);

  // スクロール検知
  const scrollInfo = detectScroll(clusters, motionDeltas.length);

  // モーショングループ構築
  const motionGroups = [];
  for (const cluster of clusters) {
    // スクロールに含まれる要素は個別報告しない
    if (scrollInfo && vectorsMatch(scrollInfo.vector, cluster.vector)) {
      continue;
    }

    // パターン登録
    const patternResult = patternRegistry.registerPattern(tabId, {
      vector: cluster.vector,
      elements: cluster.elements,
    });

    const groupEntry = {
      ref: patternResult.ref,
      vector: cluster.vector,
      count: cluster.count,
      sampleIds: cluster.elements.slice(0, 3).map(e => e.id),
    };

    if (patternResult.isNew) {
      newPatterns.push({ ...groupEntry, def: patternResult.def });
    } else {
      knownPatterns.push(groupEntry);
    }

    motionGroups.push(groupEntry);
  }

  // テキスト/状態変化の収集（位置変化がないもの）
  const contentUpdates = allDeltas
    .filter(d => (d.dx === 0 && d.dy === 0) && (d.textChanged || d.stateChanged))
    .map(d => ({
      id: d.id,
      text: d.newText || d.text,
      state: d.newState,
    }));

  // 新規出現要素
  const appearances = allDeltas
    .filter(d => d.appeared === true)
    .map(d => {
      const patternResult = patternRegistry.registerPattern(tabId, {
        appeared: { subtype: d.elementType || 'element', text: d.text },
      });

      const entry = {
        ref: patternResult.ref,
        id: d.id,
        pos: { x: d.absoluteX, y: d.absoluteY },
        text: d.text,
      };

      if (patternResult.isNew) {
        newPatterns.push({ ...entry, def: patternResult.def });
      } else {
        knownPatterns.push({ ref: patternResult.ref, status: 'appeared', pos: entry.pos });
      }

      return entry;
    });

  // 消えた要素
  const disappearances = allDeltas
    .filter(d => d.disappeared === true)
    .map(d => ({
      id: d.id,
      lastText: d.text,
      lastPos: { x: d.absoluteX, y: d.absoluteY },
    }));

  // 時間情報
  const firstFrame = frames[0];
  const lastFrame  = frames[frames.length - 1];
  const elapsedMs  = lastFrame.timestamp - firstFrame.timestamp;

  return {
    elapsed_ms: elapsedMs,
    frame_count: frames.length,
    viewport: viewportChange || null,
    scroll: scrollInfo ? {
      vector: scrollInfo.vector,
      affected_elements: scrollInfo.affectedCount,
    } : null,
    motion_groups: motionGroups,
    content_updates: contentUpdates.length ? contentUpdates : null,
    appearances: appearances.length ? appearances : null,
    disappearances: disappearances.length ? disappearances : null,
    // パターン情報（AIの「あれね」用）
    _patterns: {
      new: newPatterns.length ? newPatterns : null,
      known: knownPatterns.length ? knownPatterns : null,
    },
  };
}

/**
 * フレームをバッファに追加。閾値を超えたら集約して返す。
 * @param {string} tabId
 * @param {object} frame - { timestamp, viewport?, deltas? }
 * @returns {object|null} 集約済みデルタ（バッファ満杯時のみ）
 */
function addFrame(tabId, frame) {
  if (!tabBuffers.has(tabId)) {
    tabBuffers.set(tabId, { frames: [], timer: null, lastVp: null });
  }

  const buf = tabBuffers.get(tabId);
  buf.frames.push(frame);

  // ビューポート更新を記録
  if (frame.viewport) {
    buf.lastVp = frame.viewport.to;
  }

  // バッファが満杯 → 集約
  if (buf.frames.length >= MAX_BUFFER_SIZE) {
    return flushBuffer(tabId);
  }

  // タイマーセット（時間切れでもフラッシュ）
  if (!buf.timer) {
    buf.timer = setTimeout(() => flushBuffer(tabId), AGGREGATE_INTERVAL).unref();
  }

  return null;
}

/**
 * バッファをフラッシュして集約デルタを返す
 * @param {string} tabId
 * @returns {object|null}
 */
function flushBuffer(tabId) {
  const buf = tabBuffers.get(tabId);
  if (!buf || !buf.frames.length) return null;

  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }

  const delta = buildSmartDelta(buf.frames, tabId);
  buf.frames = [];
  return delta;
}

/**
 * 現在のバッファ状態を取得（デバッグ用）
 */
function getBufferState(tabId) {
  const buf = tabBuffers.get(tabId);
  if (!buf) return { frames: 0 };
  return { frames: buf.frames.length, lastVp: buf.lastVp };
}

/**
 * クリーンアップ（タブ切断時）
 */
function cleanup(tabId) {
  const buf = tabBuffers.get(tabId);
  if (buf && buf.timer) {
    clearTimeout(buf.timer);
  }
  tabBuffers.delete(tabId);
}

/**
 * テスト用: 全状態リセット
 */
function resetAll() {
  for (const [, buf] of tabBuffers) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  tabBuffers.clear();
  patternRegistry.clearAll();
}

module.exports = {
  addFrame,
  flushBuffer,
  getBufferState,
  cleanup,
  resetAll,
  // Export for testing
  clusterByVector,
  detectScroll,
  isDecorativeChange,
  buildSmartDelta,
  VECTOR_TOLERANCE,
  SCROLL_THRESHOLD,
  MAX_BUFFER_SIZE,
};
