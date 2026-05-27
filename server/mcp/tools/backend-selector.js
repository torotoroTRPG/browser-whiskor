/**
 * server/mcp/tools/backend-selector.js
 * Unified interface for dictionary and MiniLM backends.
 * Resolves config setting and provides fallback handling.
 */
'use strict';

const dict = require('./read-helpers');
const minilm = require('./intent-classifier-minilm');

let _backend = null;

/**
 * Resolve backend from config and return unified interface.
 */
async function resolveBackend(config) {
  const setting = config?.intelligence?.searchClassifier?.backend ?? 'auto';
  const mlCfg = config?.intelligence?.searchClassifier?.miniLM ?? {};
  const useFor = mlCfg.useFor ?? {};

  if (setting === 'dictionary') {
    return makeDictBackend(useFor);
  }

  if (setting === 'minilm' || setting === 'auto') {
    try {
      await minilm.initMiniLM(mlCfg);
      return makeMiniLMBackend(useFor);
    } catch (err) {
      if (setting === 'minilm') throw err;
      if (mlCfg.fallbackToDictionary !== false) {
        console.warn('[whiskor] MiniLM load failed, falling back to dictionary:', err.message);
        return makeDictBackend(useFor);
      }
      throw err;
    }
  }

  return makeDictBackend(useFor);
}

/**
 * Create dictionary backend interface.
 */
function makeDictBackend(useFor) {
  return {
    classifyIntent: dict.classifyIntent,
    batchFuzzyScore: null, // Dictionary uses sync fuzzyScore per-item
    suggestionsAsync: false,
    isMiniLM: false,
  };
}

/**
 * Create MiniLM backend interface.
 */
function makeMiniLMBackend(useFor) {
  return {
    classifyIntent: useFor.intentClassification !== false
      ? minilm.classifyIntentMiniLM.bind(minilm)
      : dict.classifyIntent,
    batchFuzzyScore: useFor.fuzzyMatch !== false
      ? minilm.batchFuzzyScoreMiniLM.bind(minilm)
      : null,
    suggestionsAsync: useFor.suggestions !== false,
    isMiniLM: true,
  };
}

/**
 * Get current backend (for checking status).
 */
function getBackend() {
  return _backend;
}

/**
 * Set backend (used after resolveBackend).
 */
function setBackend(backend) {
  _backend = backend;
}

module.exports = {
  resolveBackend,
  getBackend,
  setBackend,
};