/**
 * server/services/load-monitor.js
 * 
 * Load detection service.
 * Measures event loop lag and tracks embed batch time EWMA.
 * Determines load level and recommended max batch size.
 */
'use strict';

let _lagMs = 0;
let _ewmaBatchMs = 32; // initial conservative guess
const EWMA_ALPHA = 0.3;
let _intervalTimer = null;

const BATCH_PROFILES = {
  fast:     { size: 16 },  // < 200ms/batch -> healthy
  moderate: { size:  6 },  // 200-600ms    -> slightly loaded
  slow:     { size:  2 },  // > 600ms      -> heavily loaded
};

/**
 * Start event loop lag monitoring.
 * @param {number} intervalMs - Measurement interval in ms.
 */
function startLagMonitor(intervalMs = 500) {
  if (_intervalTimer) clearInterval(_intervalTimer);
  _intervalTimer = setInterval(() => {
    // Measure event loop lag by scheduling a setImmediate.
    // The delay between now and when setImmediate executes is the lag.
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6; // ms
      _lagMs = lag;
    });
  }, intervalMs);
  _intervalTimer.unref(); // Do not prevent Node.js from exiting
}

/**
 * Stop lag monitoring.
 */
function stopLagMonitor() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}

/**
 * Record the time taken for a single embedding batch.
 * Updates the Exponential Weighted Moving Average (EWMA).
 * @param {number} elapsedMs 
 */
function recordBatchTime(elapsedMs) {
  _ewmaBatchMs = EWMA_ALPHA * elapsedMs + (1 - EWMA_ALPHA) * _ewmaBatchMs;
}

/**
 * Get current system load level.
 * @returns {'normal' | 'elevated' | 'high'}
 */
function getLoadLevel() {
  const lag = _lagMs;
  const embedMs = _ewmaBatchMs;

  if (lag > 200 || embedMs > 600) return 'high';
  if (lag > 50 || embedMs > 200) return 'elevated';
  return 'normal';
}

/**
 * Get recommended maximum batch size for embedding based on current load.
 * @returns {number}
 */
function getMaxBatchSize() {
  const level = getLoadLevel();
  if (level === 'high') return BATCH_PROFILES.slow.size;
  if (level === 'elevated') return BATCH_PROFILES.moderate.size;
  return BATCH_PROFILES.fast.size;
}

/**
 * Get current load metrics for debugging/telemetry.
 */
function getMetrics() {
  return {
    lagMs: Math.round(_lagMs),
    ewmaBatchMs: Math.round(_ewmaBatchMs),
    loadLevel: getLoadLevel(),
    recommendedBatchSize: getMaxBatchSize(),
  };
}

module.exports = {
  startLagMonitor,
  stopLagMonitor,
  recordBatchTime,
  getLoadLevel,
  getMaxBatchSize,
  getMetrics,
};
