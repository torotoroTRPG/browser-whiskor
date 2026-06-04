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
const MCP_TOOLS_CONFIG_PATH = path.join(__dirname, 'configs', 'mcp-tools.json');

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
    config = JSON.parse(raw);
    stripComments(config);
  } catch (e) {
    console.error('[config] Failed to load config.json:', e.message);
    console.error('[config] Using built-in defaults.');
    config = getDefaults();
  }

  applyEnvOverrides(config);
  return config;
}

function stripComments(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(stripComments);
  } else if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (key.startsWith('_comment')) {
        delete obj[key];
      } else {
        stripComments(obj[key]);
      }
    }
  }
}

function getDefaults() {
  return {
    server:     { wsPort: 7891, httpPort: 7892, host: '127.0.0.1' },
    security:   { allowExecuteJs: false, allowActions: true, allowScreenshots: true, allowExplorer: true, executeJsTimeoutMs: 15000, actionTimeoutMs: 15000, allowedMcpOrigins: ['*'] },
    collection: { staleThresholdMs: 30000, pollingIntervalMs: 0, maxConsoleLogs: 2000, maxNetworkRequests: 500, networkBodyMaxBytes: 4096, maxReactStateHistory: 100 },
    plugins:    { 'react-fiber': true, 'vue3': true, 'text-coords': true, 'network-hook': true, 'ui-catalog': true, 'css-analyzer': true, 'perf-analyzer': true, 'accessibility': true, 'console-logger': true, 'storage-reader': true },
    react:      { maxDepth: 80, maxProps: 30, maxHooks: 25, trackStateTransitions: true, captureRedux: true, captureZustand: true, captureReactQuery: true, debounceMs: 200 },
    textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000 },
    executeJs:  { captureConsoleDuringExec: true },
    adaptiveCollection: { enabled: false, activeIntervalMs: 5000, quiescentIntervalMs: 30000, quiescentAfterMs: 60000 },
    agentControl: { allowAgentConfig: false, autoRevertConfig: false, screenshotMarks: false, packedSom: { prefetchOnNavigate: false } },
    privacy: {
      secretGuard: {
        enabled: false,          // opt-in. Redacts the user's secrets from agent/cache/logs.
        knownValues: 'file',     // 'file' (secrets.local.json) | 'env' (WHISKOR_SECRETS) | 'off'
        patterns: { email: true, creditCard: true, jwt: true }, // auto-detect without pre-registration
        sensitiveKeys: true,     // redact values whose key implies a secret (password, api_key, …)
        redactScreenshots: true, // mask sensitive boxes in screenshots (later slice)
        dashboardSeesRaw: false, // local dashboard shows redacted values too
      },
    },
    intelligence: {
      clickability: {
        enabled: true,
        autoUnblock: true,
        autoUnblockStrategies: ["closeButton", "escape", "backdrop"]
      },
      cssOrigin: {
        enabled: true,
        maxPropertiesPerElement: 20,
        maxElements: 50,
        acquisitionLevel: 4
      },
      sourceFetcher: {
        enabled: true,
        storeJs: false,
        maxCssSizeBytes: 524288,
        updateDetection: true
      },
      correlator: {
        enabled: true,
        bufferCapacityPerTab: 200,
        retentionMs: 5000,
        confidenceFloor: 0.50,
        maxChainsPerSession: 500
      },
      frameworkDomMap: {
        enabled: true
      }
    },
  };
}

// ── Load MCP tools config ───────────────────────────────────────────────────
function loadMcpToolsConfig() {
  const defaults = getMcpToolsDefaults();

  try {
    const raw = fs.readFileSync(MCP_TOOLS_CONFIG_PATH, 'utf8');
    const config = JSON.parse(
      raw
        .replace(/,\s*"_comment[^"]*"\s*:\s*"[^"]*"/g, '')
        .replace(/"_comment[^"]*"\s*:\s*"[^"]*"\s*,?/g, '')
    );

    // Apply env var overrides: WHISKOR_MCP_<TOOL_NAME>=false
    for (const [envKey, envVal] of Object.entries(process.env)) {
      if (!envKey.startsWith('WHISKOR_MCP_')) continue;
      const toolName = envKey.slice('WHISKOR_MCP_'.length).toLowerCase();
      if (config.tools && config.tools[toolName]) {
        config.tools[toolName].enabled = parseValue(envVal) !== false;
      }
    }

    // Merge with defaults (ensure all tools present)
    const merged = {
      categories: { ...defaults.categories, ...(config.categories || {}) },
      tools: { ...defaults.tools, ...(config.tools || {}) },
      presets: config.presets || defaults.presets,
    };

    // Ensure each tool has enabled and category
    for (const [name, tool] of Object.entries(merged.tools)) {
      if (tool.enabled === undefined) tool.enabled = true;
      if (!tool.category) {
        // Find category from defaults
        tool.category = defaults.tools[name]?.category || 'read';
      }
    }

    return merged;
  } catch (e) {
    console.error('[config] Failed to load mcp-tools.json:', e.message);
    console.error('[config] Using built-in defaults.');
    return defaults;
  }
}

function getMcpToolsDefaults() {
  return {
    categories: {
      read:     { enabled: true },
      write:    { enabled: true },
      capture:  { enabled: true },
      control:  { enabled: true },
      intelligence: { enabled: true },
    },
    tools: {
      get_sessions:       { enabled: true, category: 'read' },
      get_index:          { enabled: true, category: 'read' },
      get_text_coords:    { enabled: true, category: 'read' },
      get_viewport:       { enabled: true, category: 'read' },
      get_framework_state: { enabled: true, category: 'read' },
      get_network:        { enabled: true, category: 'read' },
      get_ui_catalog:     { enabled: true, category: 'read' },
      get_accessibility:  { enabled: true, category: 'read' },
      get_storage:        { enabled: true, category: 'read' },
      get_console_logs:   { enabled: true, category: 'read' },
      get_perf_metrics:   { enabled: true, category: 'read' },
      get_css_analysis:   { enabled: true, category: 'read' },
      get_dom_snapshot:   { enabled: true, category: 'read' },
      get_state_map:      { enabled: true, category: 'read' },
      list_states:        { enabled: true, category: 'read' },
      search_states:      { enabled: true, category: 'read' },
      get_state_detail:   { enabled: true, category: 'read' },
      pin_state:          { enabled: true, category: 'read' },
      navigate_to:        { enabled: true, category: 'write' },
      click:              { enabled: true, category: 'write' },
      right_click:        { enabled: true, category: 'write' },
      type_text:          { enabled: true, category: 'write' },
      type_secret:        { enabled: true, category: 'write' },
      press_key:          { enabled: true, category: 'write' },
      hover:              { enabled: true, category: 'write' },
      scroll_page:        { enabled: true, category: 'write' },
      select_option:      { enabled: true, category: 'write' },
      check_box:          { enabled: true, category: 'write' },
      drag:               { enabled: true, category: 'write' },
      mouse_scroll:       { enabled: true, category: 'write' },
      execute_js:         { enabled: true, category: 'write' },
      wait_for_element:   { enabled: true, category: 'write' },
      go_back:            { enabled: true, category: 'write' },
      go_forward:         { enabled: true, category: 'write' },
      reload_page:        { enabled: true, category: 'write' },
      capture_screenshot: { enabled: true, category: 'capture' },
      refresh_data:       { enabled: true, category: 'capture' },
      set_config:         { enabled: true, category: 'control' },
      get_config_changes: { enabled: true, category: 'control' },
      trigger_collect:    { enabled: true, category: 'control' },
      trigger_explorer:   { enabled: true, category: 'control' },
      navigate_to_state:  { enabled: true, category: 'control' },
      get_navigation_path: { enabled: true, category: 'control' },
      analyze_click:      { enabled: true, category: 'intelligence' },
      explain_element:    { enabled: true, category: 'intelligence' },
      why_did_this_change:{ enabled: true, category: 'intelligence' },
      get_source_file:    { enabled: true, category: 'intelligence' },
      detect_site_updates:{ enabled: true, category: 'intelligence' },
    },
    presets: {},
  };
}

module.exports = { loadConfig, getDefaults, loadMcpToolsConfig };
