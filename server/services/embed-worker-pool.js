/**
 * server/services/embed-worker-pool.js
 * 
 * Worker thread pool manager for embedding generation.
 * Handles worker lifecycle, watchdogs, and request routing.
 */
'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

let _worker = null;
let _status = 'UNINITIALIZED'; // UNINITIALIZED, LOADING, READY, ERROR, TERMINATED
let _pendingRequests = new Map();
let _requestId = 0;
let _restarts = 0;
const MAX_RESTARTS = 5;

let _config = null;
let _health = {
  lastResponse: Date.now(),
  restarts: 0,
  avgLatency: 0,
  totalRequests: 0,
};

let _watchdogTimer = null;
const WATCHDOG_INTERVAL_MS = 30000; // 30 seconds

/**
 * Initialize worker thread.
 * @param {Object} config 
 */
async function initialize(config) {
  _config = config;
  return _createWorker();
}

/**
 * Create a new worker instance.
 */
function _createWorker() {
  if (_worker) {
    _worker.terminate();
  }

  _status = 'LOADING';
  _worker = new Worker(path.join(__dirname, 'embed-worker.js'));

  _worker.on('message', _handleMessage);
  _worker.on('error', _handleError);
  _worker.on('exit', (code) => {
    if (code !== 0) _handleError(new Error(`Worker stopped with exit code ${code}`));
  });

  _startWatchdog();

  return new Promise((resolve, reject) => {
    // Override the generic message handler for the init response
    const initHandler = (msg) => {
      if (msg.type === 'ready') {
        _status = 'READY';
        _worker.off('message', initHandler);
        _worker.on('message', _handleMessage); // Restore generic handler
        resolve();
      } else if (msg.type === 'error') {
        _status = 'ERROR';
        _worker.off('message', initHandler);
        reject(new Error(msg.error));
      }
    };
    
    // We temporarily clear the generic handler to avoid conflicts during init
    _worker.off('message', _handleMessage);
    _worker.on('message', initHandler);

    _worker.postMessage({
      type: 'init',
      modelName: _config?.modelName || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      cacheDir: _config?.cacheDir || '.model-cache'
    });
  });
}

function _handleMessage(msg) {
  _health.lastResponse = Date.now();

  if (msg.id && _pendingRequests.has(msg.id)) {
    const req = _pendingRequests.get(msg.id);
    _pendingRequests.delete(msg.id);

    const latency = Date.now() - req.startTime;
    _health.totalRequests++;
    _health.avgLatency = _health.avgLatency * 0.9 + latency * 0.1;

    if (msg.type === 'result') {
      req.resolve(msg.vectors);
    } else if (msg.type === 'error') {
      req.reject(new Error(msg.error));
    }
  }
}

function _handleError(err) {
  console.error('[whiskor] Embed worker error:', err);
  _status = 'ERROR';
  _restartWorker();
}

async function _restartWorker() {
  if (_restarts >= MAX_RESTARTS) {
    console.error('[whiskor] Max worker restarts reached. Falling back to main thread or unavailable.');
    _status = 'TERMINATED';
    _rejectAll(new Error('Worker terminated after max restarts'));
    return;
  }

  _restarts++;
  _health.restarts++;
  const backoffMs = Math.min(1000 * Math.pow(2, _restarts), 30000);
  console.warn(`[whiskor] Restarting worker in ${backoffMs}ms (attempt ${_restarts})`);

  setTimeout(async () => {
    try {
      await _createWorker();
      console.log('[whiskor] Worker restarted successfully');
    } catch (e) {
      console.error('[whiskor] Failed to restart worker:', e);
    }
  }, backoffMs);
}

function _rejectAll(error) {
  for (const [id, req] of _pendingRequests.entries()) {
    req.reject(error);
  }
  _pendingRequests.clear();
}

function _startWatchdog() {
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _watchdogTimer = setInterval(() => {
    const idleTime = Date.now() - _health.lastResponse;
    if (_pendingRequests.size > 0 && idleTime > WATCHDOG_INTERVAL_MS) {
      console.warn(`[whiskor] Worker watchdog timeout (${idleTime}ms). Restarting.`);
      _restartWorker();
    }
  }, 10000);
  _watchdogTimer.unref();
}

/**
 * Send a batch of texts to the worker for embedding.
 * @param {string[]} texts 
 * @returns {Promise<number[][]>}
 */
async function embed(texts) {
  if (_status !== 'READY' || !_worker) {
    throw new Error(`Worker not ready (status: ${_status})`);
  }

  const id = String(++_requestId);
  return new Promise((resolve, reject) => {
    _pendingRequests.set(id, {
      resolve,
      reject,
      startTime: Date.now()
    });
    _worker.postMessage({ type: 'embed', id, texts });
  });
}

function isReady() {
  return _status === 'READY';
}

function getHealth() {
  return {
    status: _status,
    pendingJobs: _pendingRequests.size,
    ..._health
  };
}

function shutdown() {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
  }
  _rejectAll(new Error('Worker shutting down'));
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
  _status = 'TERMINATED';
}

module.exports = {
  initialize,
  embed,
  isReady,
  getHealth,
  shutdown
};
