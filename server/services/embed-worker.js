/**
 * server/services/embed-worker.js
 * 
 * Worker thread for embedding generation.
 * Isolated to prevent event loop blocking in main thread.
 */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { pipeline } = require('@xenova/transformers');

let _pipe = null;

parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'embed':
        await handleEmbed(msg);
        break;
      case 'shutdown':
        process.exit(0);
        break;
      default:
        parentPort.postMessage({ type: 'error', id: msg.id, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: err.message });
  }
});

async function handleInit(msg) {
  const { modelName, cacheDir } = msg;
  _pipe = await pipeline('feature-extraction', modelName, {
    cacheDir,
    quantized: true, // Use quantized for smaller memory footprint
  });
  parentPort.postMessage({ type: 'ready' });
}

async function handleEmbed(msg) {
  if (!_pipe) {
    throw new Error('Pipeline not initialized');
  }
  const { id, texts } = msg;
  // normalize: true outputs normalized vectors (dot product = cosine similarity)
  const out = await _pipe(texts, { pooling: 'mean', normalize: true });
  parentPort.postMessage({ type: 'result', id, vectors: out.tolist() });
}
