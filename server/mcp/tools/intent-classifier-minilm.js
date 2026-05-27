/**
 * server/mcp/tools/intent-classifier-minilm.js
 * 
 * Thin wrapper delegating embedding and fuzzy scoring to embed-service.js.
 * Handles intent classification using loaded anchor words.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const embedService = require('../../services/embed-service');

let _anchors = null;

/**
 * Load raw anchors from JSON file.
 */
function loadRawAnchors() {
  try {
    const p = path.join(__dirname, '../../configs/intent-anchors.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const result = {};
    for (const [intent, words] of Object.entries(raw)) {
      if (!intent.startsWith('_')) {
        result[intent] = words;
      }
    }
    return result;
  } catch (e) {
    return {};
  }
}

/**
 * Cosine similarity.
 */
function cosineSim(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, dot);
}

/**
 * Initialize MiniLM by starting the embed service and pre-computing anchor embeddings.
 */
async function initMiniLM(config) {
  await embedService.initialize(config);

  const rawAnchors = loadRawAnchors();
  _anchors = {};
  
  // Collect all anchor words to embed them in batches
  for (const [intent, words] of Object.entries(rawAnchors)) {
    const vecs = await embedService.embedTexts(words);
    _anchors[intent] = words.map((text, i) => ({ text, vec: vecs[i] }));
  }
}

/**
 * Calculates a batch of fuzzy scores using cosine similarity of embeddings.
 * @param {string} query 
 * @param {string[]} texts 
 * @returns {Promise<number[]>} Array of scores 0.0-1.0
 */
async function batchFuzzyScoreMiniLM(query, texts) {
  if (!query || !texts || texts.length === 0) return [];
  if (embedService.getEmbedStatus() === 'unavailable') {
    return null;
  }

  // Combine query and texts for batched embedding
  const allTexts = [query, ...texts];
  const vectors = await embedService.embedTexts(allTexts);
  
  const queryVec = vectors[0];
  const scores = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    scores[i] = cosineSim(queryVec, vectors[i + 1]);
  }
  
  return scores;
}

/**
 * Classify intent using MiniLM embeddings.
 */
async function classifyIntentMiniLM(label, threshold = 0.35) {
  if (embedService.getEmbedStatus() === 'unavailable' || !_anchors) return null;
  
  const vecs = await embedService.embedTexts([label.slice(0, 128)]);
  const qVec = vecs[0];

  let best = { intent: 'UNKNOWN', score: -1, anchor: '' };

  for (const [intent, entries] of Object.entries(_anchors)) {
    for (const { text, vec } of entries) {
      const sim = cosineSim(qVec, vec);
      if (sim > best.score) {
        best = { intent, score: sim, anchor: text };
      }
    }
  }

  if (best.score < threshold) return null;
  return { intent: best.intent, confidence: best.score, topAnchor: best.anchor };
}

function isReady() {
  return embedService.getEmbedStatus() === 'ready';
}

function getCacheStats() {
  const metrics = embedService.getMetrics();
  return {
    size: metrics.store.size,
    batchSize: metrics.load.recommendedBatchSize,
    loadLevel: metrics.load.loadLevel,
  };
}

function getLoadLevel() {
  const metrics = embedService.getMetrics();
  return metrics.load.loadLevel;
}

module.exports = {
  initMiniLM,
  batchFuzzyScoreMiniLM,
  classifyIntentMiniLM,
  isReady,
  getCacheStats,
  getLoadLevel
};