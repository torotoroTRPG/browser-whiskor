/**
 * server/config-loader.js
 * Loads config.json from the project root.
 *
 * Override layers, applied lowest-to-highest precedence:
 *   1. config.json            — committed public defaults (the published baseline)
 *   2. config.local.json      — git-ignored personal/machine overrides, deep-merged
 *   3. WHISKOR_* env / .env    — final per-process overrides
 *
 * config.local.json lets a developer keep personal values (e.g. enabling
 * execute_js locally, or text-first HTTP screenshots) WITHOUT editing the
 * committed config.json — so the published defaults can never drift on push.
 * Only the keys present in config.local.json are overridden; everything else
 * falls through to config.json. It is deep-merged (nested objects merge; arrays
 * and scalars replace).
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
const CONFIG_LOCAL_PATH = path.join(__dirname, '..', 'config.local.json');
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
// Supports nested keys: WHISKOR_PRIVACY_SECRETGUARD_ENABLED → privacy.secretGuard
// .enabled. Each '_'-separated part descends one level, matched case-insensitively
// against the config keys (underscores in the key name are ignored). At each level
// the longest run of parts that names an existing key wins, so multi-word keys
// (whether written maxConsoleLogs or MAX_CONSOLE_LOGS) resolve. A part that matches
// nothing is ignored — unknown env vars never create keys.
function _norm(k) { return String(k).toLowerCase().replace(/_/g, ''); }

function _applyEnvPath(root, parts, value) {
  let cur = root;
  let i = 0;
  while (i < parts.length) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
    const keys = Object.keys(cur);
    let matchKey = null, consumed = 0;
    // Prefer the longest prefix of remaining parts that names a key at this level.
    for (let j = parts.length; j > i; j--) {
      const joined = parts.slice(i, j).join('');
      const found = keys.find((k) => _norm(k) === joined);
      if (found) { matchKey = found; consumed = j - i; break; }
    }
    if (matchKey == null) return;       // no key matches → ignore this env var
    i += consumed;
    if (i >= parts.length) { cur[matchKey] = value; return; } // leaf → set
    cur = cur[matchKey];                // descend
  }
}

function applyEnvOverrides(config) {
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith('WHISKOR_')) continue;
    if (envKey.startsWith('WHISKOR_MCP_')) continue; // handled in loadMcpToolsConfig
    const parts = envKey.slice('WHISKOR_'.length).toLowerCase().split('_').filter(Boolean);
    if (parts.length < 2) continue;     // need at least section + key
    _applyEnvPath(config, parts, parseValue(envVal));
  }
  return config;
}

// ── Deep-merge an override object into a base config (mutates base) ───────────
// Plain objects merge recursively; arrays and scalars replace wholesale. This is
// the predictable semantics for config overrides — overriding updateFrequencies
// replaces the array rather than splicing element-wise.
function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  for (const key of Object.keys(override)) {
    const ov = override[key];
    const bv = base[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) &&
        bv && typeof bv === 'object' && !Array.isArray(bv)) {
      deepMerge(bv, ov);
    } else {
      base[key] = ov;
    }
  }
  return base;
}

// ── Load git-ignored config.local.json (personal/machine overrides) ───────────
// Returns {} when absent. A malformed local file is a hard error: it almost
// always means the developer typo'd their own overrides, and silently ignoring
// it would run with the published defaults they meant to change.
function loadLocalConfig() {
  if (!fs.existsSync(CONFIG_LOCAL_PATH)) return {};
  try {
    const local = JSON.parse(fs.readFileSync(CONFIG_LOCAL_PATH, 'utf8'));
    stripComments(local);
    return local;
  } catch (e) {
    console.error('[config] Failed to parse config.local.json:', e.message);
    console.error('[config] Fix or remove config.local.json — ignoring it for now.');
    return {};
  }
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

  deepMerge(config, loadLocalConfig());  // personal/machine overrides
  applyEnvOverrides(config);             // env wins over everything
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
    mcpServer:  { staticTools: false },
    security:   { allowExecuteJs: false, allowActions: true, allowScreenshots: true, allowExplorer: true, executeJsTimeoutMs: 15000, actionTimeoutMs: 15000, allowedMcpOrigins: ['*'] },
    collection: { staleThresholdMs: 30000, pollingIntervalMs: 0, maxConsoleLogs: 2000, maxNetworkRequests: 500, networkBodyMaxBytes: 4096, maxReactStateHistory: 100 },
    plugins:    { 'react-fiber': true, 'vue3': true, 'text-coords': true, 'network-hook': true, 'ui-catalog': true, 'css-analyzer': true, 'perf-analyzer': true, 'accessibility': true, 'console-logger': true, 'storage-reader': true },
    react:      { maxDepth: 80, maxProps: 30, maxHooks: 25, trackStateTransitions: true, captureRedux: true, captureZustand: true, captureReactQuery: true, debounceMs: 200 },
    textCoords: { level: 'word', includeHidden: false, includeOffscreen: false, maxWords: 5000 },
    executeJs:  { captureConsoleDuringExec: true },
    // Auto-reload a stale extension once per version when it connects with a
    // manifest version differing from the server (after `whk setup` refreshes
    // the managed extension files). See core.js EXT_HELLO handling.
    extensionUpdate: { autoReload: true },
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

module.exports = { loadConfig, getDefaults, loadMcpToolsConfig, applyEnvOverrides, deepMerge, loadLocalConfig };
