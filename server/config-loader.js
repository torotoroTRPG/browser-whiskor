/**
 * server/config-loader.js
 * Loads config.json from the project root.
 * Supports .env and environment variable overrides via WHISKOR_* prefix.
 *
 * .env example:
 *   WHISKOR_SECURITY_ALLOWEXECUTEJS=false
 *   WHISKOR_SERVER_WSPORT=7891
 *   WHISKOR_COLLECTION_MAXCONSOLELOGS=500
 *
 * Environment variables use the pattern:
 *   WHISKOR_<SECTION>_<KEY>=<value>
 * Keys are matched case-insensitively.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DOTENV_PATH = path.join(__dirname, '..', '.env');

// ── Load .env file (if present) ──────────────────────────────────────────────
function loadDotEnv() {
  if (!fs.existsSync(DOTENV_PATH)) return;
  try {
    const lines = fs.readFileSync(DOTENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error('[config] Failed to load .env:', e.message);
  }
}

// ── Parse a string value to its likely type ─────────────────────────────────
function parseValue(str) {
  if (str === 'true')  return true;
  if (str === 'false') return false;
  const n = Number(str);
  if (!isNaN(n) && str.trim() !== '') return n;
  try {
    // Allow JSON arrays/objects in env vars: WHISKOR_SECURITY_ALLOWEDMCPORIGINS=["*"]
    if (str.startsWith('[') || str.startsWith('{')) return JSON.parse(str);
  } catch (_) {}
  return str;
}

// ── Apply WHISKOR_* env vars as overrides ────────────────────────────────────
function applyEnvOverrides(config) {
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith('WHISKOR_')) continue;
    const parts = envKey.slice('WHISKOR_'.length).toLowerCase().split('_');
    if (parts.length < 2) continue;

    const section = parts[0];              // e.g. "security"
    const key     = parts.slice(1).join('_'); // e.g. "allowexecutejs"

    if (!config[section] || typeof config[section] !== 'object') continue;

    // Case-insensitive key match
    for (const cfgKey of Object.keys(config[section])) {
      if (cfgKey.toLowerCase() === key.toLowerCase()) {
        config[section][cfgKey] = parseValue(envVal);
        break;
      }
    }
  }
  return config;
}

// ── Main loader ───────────────────────────────────────────────────────────────
function loadConfig() {
  loadDotEnv();

  let config = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    // Strip _comment keys before parsing (they're just documentation).
    // Two passes: remove leading-comma form (when _comment is not first key)
    // and trailing-comma form (when it is first key).
    config = JSON.parse(
      raw
        .replace(/,\s*"_comment[^"]*"\s*:\s*"[^"]*"/g, '')  // not-first key
        .replace(/"_comment[^"]*"\s*:\s*"[^"]*"\s*,?/g, '') // first key (may leave trailing comma)
    );
  } catch (e) {
    console.error('[config] Failed to load config.json:', e.message);
    console.error('[config] Using built-in defaults.');
    config = getDefaults();
  }

  applyEnvOverrides(config);
  return config;
}

function getDefaults() {
  return {
    server:     { wsPort: 7891, httpPort: 7892, host: '127.0.0.1' },
    security:   { allowExecuteJs: true, allowActions: true, allowScreenshots: true, allowExplorer: true, executeJsTimeoutMs: 15000, actionTimeoutMs: 15000, allowedMcpOrigins: ['*'] },
    collection: { staleThresholdMs: 30000, pollingIntervalMs: 0, maxConsoleLogs: 2000, maxNetworkRequests: 500, networkBodyMaxBytes: 4096, maxReactStateHistory: 100 },
    plugins:    { 'react-fiber': true, 'vue3': true, 'text-coords': true, 'network-hook': true, 'ui-catalog': true, 'css-analyzer': true, 'perf-analyzer': true, 'accessibility': true, 'console-logger': true, 'storage-reader': true },
    react:      { maxDepth: 80, maxProps: 30, maxHooks: 25, trackStateTransitions: true, captureRedux: true, captureZustand: true, captureReactQuery: true, debounceMs: 200 },
    textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000 },
    executeJs:  { captureConsoleDuringExec: true },
    agentControl: { allowAgentConfig: false, autoRevertConfig: false, screenshotMarks: false },
  };
}

module.exports = { loadConfig, getDefaults };
