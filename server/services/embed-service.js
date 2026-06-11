/**
 * server/services/embed-service.js
 * 
 * High-level orchestration for embeddings.
 * Manages differential embedding, asynchronous job queues, and adaptive batching.
 * Delegates to worker pool for inference, embed-store for persistence, 
 * and load-monitor for system health.
 */
'use strict';

const crypto = require('crypto');
const workerPool = require('./embed-worker-pool');
const embedStore = require('./embed-store');
const loadMonitor = require('./load-monitor');

// Status: 'unavailable', 'ready', 'pending', 'stale'
let _embedStatus = 'unavailable';
let _pendingNotices = new Map(); // sessionId -> { type, message }

// Metrics
let _metrics = {
  embeddingsGenerated: 0,
  embeddingsFromCache: 0,
  totalRequests: 0,
};

/**
 * Compute the content hash for a DOM element to be used as cache key.
 * @param {Object} element 
 * @returns {string} 16-character SHA-256 hash
 */
function computeContentHash(element) {
  // Use text and location to uniquely identify the element's semantic content
  const text = element.text || element.textContent || '';
  const loc = element.location || element.selector || '';
  const hashInput = `${text}|${loc}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
}

/**
 * Compute hash for raw text.
 * @param {string} text 
 * @returns {string}
 */
function computeTextHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/**
 * Initialize all embedding services.
 * @param {Object} config 
 */
async function initialize(config) {
  const mlCfg = config?.intelligence?.searchClassifier?.miniLM || {};
  const modelName = mlCfg.model || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  const cacheDir = mlCfg.modelCacheDir || '.model-cache';

  // 1. Initialize load monitor
  loadMonitor.startLagMonitor();

  // 2. Load persistence store
  embedStore.load(cacheDir, modelName);

  // 3. Initialize worker pool
  try {
    await workerPool.initialize({ modelName, cacheDir });
    _embedStatus = 'ready';
  } catch (err) {
    console.error('[whiskor] Failed to initialize embed worker pool:', err.message);
    _embedStatus = 'unavailable';
    throw err;
  }
}

/**
 * Shutdown all services.
 */
function shutdown() {
  loadMonitor.stopLagMonitor();
  embedStore.flush();
  workerPool.shutdown();
  _embedStatus = 'unavailable';
}

/**
 * Process elements from a refresh_data call asynchronously.
 * Calculates differential updates and queues them.
 * 
 * @param {Array} elements - DOM elements from snapshot
 * @param {string} sessionId - Session ID to notify upon completion
 */
async function embedForCache(elements, sessionId) {
  if (!workerPool.isReady()) {
    _embedStatus = 'unavailable';
    return;
  }

  _embedStatus = 'pending';
  _metrics.totalRequests++;

  const uncachedElements = [];

  // Step 1: Differential check
  for (const el of elements) {
    if (!el.text && !el.textContent) continue; // Skip elements with no text
    
    const hash = computeContentHash(el);
    el._contentHash = hash;

    if (embedStore.has(hash)) {
      el._vec = embedStore.get(hash);
      _metrics.embeddingsFromCache++;
    } else {
      uncachedElements.push(el);
    }
  }

  if (uncachedElements.length === 0) {
    _embedStatus = 'ready';
    return;
  }

  // Step 2: Queue for embedding (Background processing)
  // We don't await this so the caller (refresh_data) can return immediately.
  _processQueueAsync(uncachedElements, sessionId).catch(err => {
    console.error('[whiskor] Async embedding failed:', err);
    _embedStatus = 'ready'; // Revert to ready so we don't get stuck in pending
  });
}

/**
 * Internal async loop for processing elements in adaptive batches.
 */
async function _processQueueAsync(elements, sessionId) {
  let currentIndex = 0;

  while (currentIndex < elements.length) {
    if (!workerPool.isReady()) {
      throw new Error('Worker pool became unavailable during processing');
    }

    // Adaptive batch size
    const batchSize = loadMonitor.getMaxBatchSize();
    const batch = elements.slice(currentIndex, currentIndex + batchSize);
    const texts = batch.map(el => (el.text || el.textContent).slice(0, 512)); // truncate long texts

    const startTime = Date.now();
    try {
      const vectors = await workerPool.embed(texts);
      
      const elapsed = Date.now() - startTime;
      loadMonitor.recordBatchTime(elapsed);

      // Save results
      for (let i = 0; i < batch.length; i++) {
        const el = batch[i];
        const vec = vectors[i];
        el._vec = vec;
        embedStore.set(el._contentHash, vec);
        _metrics.embeddingsGenerated++;
      }

    } catch (err) {
      console.error(`[whiskor] Batch embedding error (items ${currentIndex}-${currentIndex+batch.length}):`, err.message);
      // We continue with the next batch even if this one fails
    }

    currentIndex += batchSize;

    // Cooperative multitasking: yield to event loop between chunks
    await new Promise(resolve => setImmediate(resolve));
  }

  // Step 3: Completion and notification
  _embedStatus = 'ready';
  if (sessionId) {
    _pendingNotices.set(sessionId, {
      source: 'WHISKOR_SYSTEM',
      type: 'EMBED_READY',
      message: `MiniLM embed complete: ${elements.length} elements processed (${elements.length - currentIndex} new/changed).`
    });
  }
}

/**
 * Embed an array of texts synchronously (waits for completion).
 * Used for query embedding or fuzzy score matching.
 * 
 * @param {string[]} texts 
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts) {
  if (!workerPool.isReady()) {
    throw new Error('Worker pool not ready');
  }

  const results = new Array(texts.length);
  const uncachedIndices = [];
  const uncachedTexts = [];

  // Differential
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i].slice(0, 512);
    const hash = computeTextHash(text);
    if (embedStore.has(hash)) {
      results[i] = embedStore.get(hash);
      _metrics.embeddingsFromCache++;
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(text);
    }
  }

  if (uncachedTexts.length === 0) {
    return results;
  }

  // Process uncached in adaptive batches
  let currentUncachedIndex = 0;
  while (currentUncachedIndex < uncachedTexts.length) {
    const batchSize = loadMonitor.getMaxBatchSize();
    const batchTexts = uncachedTexts.slice(currentUncachedIndex, currentUncachedIndex + batchSize);
    const batchIndices = uncachedIndices.slice(currentUncachedIndex, currentUncachedIndex + batchSize);

    const startTime = Date.now();
    const vectors = await workerPool.embed(batchTexts);
    loadMonitor.recordBatchTime(Date.now() - startTime);

    for (let i = 0; i < batchTexts.length; i++) {
      const idx = batchIndices[i];
      const vec = vectors[i];
      results[idx] = vec;
      
      const hash = computeTextHash(batchTexts[i]);
      embedStore.set(hash, vec);
      _metrics.embeddingsGenerated++;
    }

    currentUncachedIndex += batchSize;
  }

  return results;
}

/**
 * Get current system-wide embed status.
 */
function getEmbedStatus() {
  return _embedStatus;
}

/**
 * Get a vector from the cache.
 */
function getCachedVector(hash) {
  return embedStore.get(hash);
}

/**
 * Consume and clear the pending ready notice for a session.
 */
function consumeReadyNotice(sessionId) {
  if (!sessionId) return null;
  const notice = _pendingNotices.get(sessionId);
  if (notice) {
    _pendingNotices.delete(sessionId);
  }
  return notice;
}

function getMetrics() {
  return {
    ..._metrics,
    status: _embedStatus,
    worker: workerPool.getHealth(),
    store: embedStore.getStats(),
    load: loadMonitor.getMetrics()
  };
}

module.exports = {
  initialize,
  shutdown,
  embedForCache,
  embedTexts,
  getEmbedStatus,
  getCachedVector,
  consumeReadyNotice,
  getMetrics,
  computeContentHash
};
