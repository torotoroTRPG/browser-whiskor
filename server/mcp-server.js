/**
 * server/mcp-server.js  –  browser-whiskor v3
 * MCP (Model Context Protocol) server — full agent toolset.
 *
 * Transport: stdio (JSON-RPC 2.0, one object per line)
 *
 * READ tools (passive observation):
 *   get_sessions         list active sessions with freshness
 *   get_index            _index.json + data freshness map
 *   get_text_coords      visible text with absolute pixel coordinates
 *   get_framework_state  component tree (React/Vue/Angular/Svelte/…)
 *   get_network          captured requests/responses
 *   get_ui_catalog       buttons, links, inputs, images
 *   get_accessibility    full ARIA tree with computed roles
 *   get_storage          localStorage / sessionStorage / cookies
 *   get_console_logs     captured console output
 *   get_perf_metrics     LCP, FCP, CLS, FID, TTFB, resource timing
 *   get_css_analysis     CSS variables, stylesheets, computed styles
 *   get_dom_snapshot     generic DOM / ARIA tree
 *   get_state_map        state-transition graph for autonomous exploration
 *
 * WRITE tools (active interaction):
 *   navigate_to          load a URL in a tab
 *   click                click element by selector, text, or coordinates
 *   type_text            type text into the focused / targeted element
 *   press_key            send keyboard shortcut (e.g. "Control+a", "Enter")
 *   hover                hover over element
 *   scroll_page          scroll page or element
 *   select_option        set <select> value
 *   check_box            check/uncheck a checkbox
 *   execute_js           run arbitrary JavaScript in the page
 *   wait_for_element     wait until selector or text appears
 *   go_back / go_forward browser history navigation
 *   reload_page          reload the current tab
 *
 * CAPTURE tools:
 *   capture_screenshot   full-page screenshot as base64 PNG
 *   refresh_data         trigger fresh data collection and wait for result
 *
 * CONTROL tools:
 *   set_config           update extension activation config
 *   trigger_collect      manually trigger data collection
 *   trigger_explorer     start/stop autonomous page explorer
 */

'use strict';

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

// ── Fuzzy text matching (zero-dependency, mirrors text-coords.js) ──────────

function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

function bigramSet(str) {
  const s = str.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) { if (b.has(x)) inter++; }
  return inter / (a.size + b.size - inter);
}

function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (t.includes(q)) return 1.0;
  const qTok = new Set(tokenize(q));
  const tTok = new Set(tokenize(t));
  const tokenSim = jaccard(qTok, tTok);
  const qBi = bigramSet(q);
  const tBi = bigramSet(t);
  const bigramSim = jaccard(qBi, tBi);
  const bw = q.length < 5 ? 0.6 : 0.3;
  return Math.round((tokenSim * (1 - bw) + bigramSim * bw) * 1000) / 1000;
}
const cache    = require('./cache-writer');

// ── Injected by index.js ──────────────────────────────────────────────────────
let _pushConfig       = null;
let _triggerCollect   = null;
let _triggerExplorer  = null;
let _executeAction    = null;  // async (tabId, action, timeoutMs) → result
let _captureScreenshot = null; // async (tabId, opts) → { dataUrl, … }
let _configLog        = null;  // config-change-log module
let _startupWarnings  = [];
let _security = {
  allowExecuteJs:   true,
  allowActions:     true,
  allowScreenshots: true,
};
let _navigateBroadcast = null;

function setCallbacks(pushConfig, triggerCollect, triggerExplorer) {
  _pushConfig      = pushConfig;
  _triggerCollect  = triggerCollect;
  _triggerExplorer = triggerExplorer;
}

function setActionCallbacks(executeAction, captureScreenshot) {
  _executeAction     = executeAction;
  _captureScreenshot = captureScreenshot;
}

function setNavigateBroadcast(fn) { _navigateBroadcast = fn; }

function setConfigLog(log) {
  _configLog = log;
}

function setStartupWarnings(warnings) {
  _startupWarnings = warnings;
}

function setSecurity(sec) {
  _security = { ..._security, ...sec };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // ── READ ───────────────────────────────────────────────────────────────────
  {
    name: 'get_sessions',
    description: 'List all active inspection sessions (one per browser tab). Returns tabId, URL, title, data age, staleness flag, and a freshness map showing when each plugin last collected data. Call this first to discover available tabIds.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_index',
    description: 'Get the full session index for a tab. Shows which data files are available, summary stats, and data freshness for each plugin. Use this to see what data is available before fetching specific files.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID from get_sessions' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_text_coords',
    description: 'Get all visible text on the page with absolute pixel coordinates. Use "search" for exact substring match, or "match" for fuzzy similarity search (returns results sorted by score 0.0-1.0). Each item includes a contextHint describing the element role (e.g. "navigation link", "form label", "button").',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:      { type: 'number', description: 'Tab ID from get_sessions' },
        search:     { type: 'string', description: 'Exact substring filter (case-insensitive)' },
        match:      { type: 'string', description: 'Fuzzy similarity search — returns results sorted by match score (0.0-1.0). Use when you don\'t know the exact text.' },
        level:      { type: 'string', enum: ['words', 'lines', 'blocks', 'all'], description: 'Granularity (default: words)' },
        maxResults: { type: 'number', description: 'Max items to return. Use with "match" to get top-N results (default: 50)' },
        minScore:   { type: 'number', description: 'Minimum similarity score for "match" mode (0.0-1.0, default: 0.1)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_framework_state',
    description: 'Get the component tree and state for the detected frontend framework (React, Vue, Angular, Svelte, Alpine, Preact, Solid, or generic DOM). Includes component props, hooks, context, router location, and Redux/Pinia/Vuex store if detected.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
        framework: { type: 'string', enum: ['auto', 'react', 'vue3', 'vue2', 'angular', 'svelte', 'alpine', 'preact', 'solid', 'dom'], description: 'Which framework (auto = first detected)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_network',
    description: 'Get captured HTTP requests and responses. Each entry includes method, URL, status, duration, request/response headers, and decoded body (up to configured limit). Useful for understanding what API calls the page makes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:       { type: 'number', description: 'Tab ID from get_sessions' },
        filterUrl:   { type: 'string', description: 'Only return requests whose URL contains this string' },
        filterType:  { type: 'string', description: 'Filter by initiator type (fetch, xhr, script, img, …)' },
        filterStatus: { type: 'number', description: 'Filter by HTTP status code (e.g. 200, 404, 500)' },
        limit:       { type: 'number', description: 'Max number of requests to return (default: 100)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_ui_catalog',
    description: 'Get all interactive UI elements: buttons, links, form inputs, images. Each includes text/label, coordinates (x,y,w,h), and state (disabled, required). Use this to find what you can click or type into.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
        search: { type: 'string', description: 'Filter elements by text/label (case-insensitive)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_accessibility',
    description: 'Get the full ARIA accessibility tree. Each node includes computed role, name, description, state (expanded, selected, checked, disabled), and landmark region. Excellent for finding elements without visual selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID from get_sessions' },
        role:      { type: 'string', description: 'Filter by ARIA role (e.g. button, link, textbox, dialog, navigation)' },
        maxDepth:  { type: 'number', description: 'Max tree depth to return (default: 10)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_storage',
    description: 'Get browser storage data: localStorage, sessionStorage, and cookies (name/value/domain). Useful for reading auth tokens, user preferences, session state, or any persisted data.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
        filter: { type: 'string', description: 'Only return keys containing this string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_console_logs',
    description: 'Get captured console output (log, warn, error, info, debug). Each entry includes level, timestamp, and formatted message. Useful for debugging, finding errors, or understanding app behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:  { type: 'number', description: 'Tab ID from get_sessions' },
        level:  { type: 'string', enum: ['log', 'warn', 'error', 'info', 'debug', 'all'], description: 'Filter by log level (default: all)' },
        search: { type: 'string', description: 'Filter by message content' },
        limit:  { type: 'number', description: 'Max entries to return (default: 200)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_perf_metrics',
    description: 'Get Web Vitals and performance metrics: LCP, FCP, CLS, FID/INP, TTFB, resource timing, long tasks. Useful for diagnosing performance issues.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID from get_sessions' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_css_analysis',
    description: 'Get CSS custom properties (variables), stylesheet statistics, and computed styles for key elements. Useful for understanding theming, design tokens, or style issues.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID from get_sessions' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_dom_snapshot',
    description: 'Get the generic DOM tree including ARIA attributes, global state variables (window.*), and custom elements. Falls back gracefully when framework adapters are not available.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID from get_sessions' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_state_map',
    description: 'Get the application state-transition graph built by the autonomous explorer. Shows discovered UI states as nodes (with URL, title, button/link counts) and transitions as edges (with action type and trigger label). Use this to understand app navigation structure.',
    inputSchema: {
      type: 'object',
      properties: {
        siteVersion: { type: 'string', description: 'Site version hash (omit to list all graphs)' },
      },
    },
  },
  {
    name: 'list_states',
    description: 'List all recorded UI states with semantic labels, tags, and visit counts. Use this to discover what states have been observed. Filter by URL pattern, tags, or sort by visitCount/lastSeen. Pinned states appear first.',
    inputSchema: {
      type: 'object',
      properties: {
        siteVersion: { type: 'string', description: 'Filter by site version (omit for all)' },
        filter:      { type: 'string', description: 'URL pattern filter (e.g. "/cart")' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Required tags (e.g. ["authenticated", "cart-open"])' },
        sortBy:      { type: 'string', enum: ['visitCount', 'lastSeen', 'firstSeen'], description: 'Sort order (default: lastSeen)' },
        limit:       { type: 'number', description: 'Max results (default: 50, max: 500)' },
      },
    },
  },
  {
    name: 'search_states',
    description: 'Fuzzy-search recorded UI states by label, tags, URL, or keyState values. Use natural language queries like "cart", "checkout", "logged in". Returns results ranked by relevance score.',
    inputSchema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search query (e.g. "cart", "checkout", "login")' },
        siteVersion: { type: 'string', description: 'Filter by site version (omit for all)' },
        searchIn:    { type: 'string', enum: ['label', 'tags', 'keyState', 'url', 'all'], description: 'Where to search (default: all)' },
        limit:       { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_state_detail',
    description: 'Get full metadata for a specific state including label, tags, keyState, UI summary, and reachable states. Optionally include the full snapshot (React state + DOM tree).',
    inputSchema: {
      type: 'object',
      properties: {
        hash:            { type: 'string', description: 'State hash (compositeHash, 7-8 chars)' },
        siteVersion:     { type: 'string', description: 'Site version (omit to auto-search)' },
        includeSnapshot: { type: 'boolean', description: 'Include full React/DOM snapshot (default: false)' },
        includeEdges:    { type: 'boolean', description: 'Include reachableFrom/canReachTo edges (default: true)' },
      },
      required: ['hash'],
    },
  },
  {
    name: 'pin_state',
    description: 'Pin a state with a custom label and/or tags. Pinned states are always kept in memory (not evicted) and appear first in list_states results. Use this to bookmark important states for later navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        hash:        { type: 'string', description: 'State hash to pin' },
        siteVersion: { type: 'string', description: 'Site version (omit to auto-search)' },
        label:       { type: 'string', description: 'Custom label for this state' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Additional tags to add' },
      },
      required: ['hash'],
    },
  },

  // ── WRITE ──────────────────────────────────────────────────────────────────
  {
    name: 'navigate_to',
    description: 'Navigate a tab to a URL. The extension will load the URL using chrome.tabs.update. Note: data will be stale immediately after — call refresh_data or wait before reading again.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to navigate' },
        url:   { type: 'string', description: 'Full URL to navigate to (must include protocol)' },
      },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'click',
    description: 'Click an element in the page. You can target by CSS selector, by visible text, or by absolute coordinates. Fires full mouse event sequence (mouseover, mouseenter, mousedown, mouseup, click) for maximum React/Vue compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector (e.g. "#submit-btn", ".nav-item:first-child")' },
        text:     { type: 'string', description: 'Visible text of element (partial match, case-insensitive). Used when selector is absent.' },
        x:        { type: 'number', description: 'Absolute X coordinate (pixels). Used when selector and text are absent.' },
        y:        { type: 'number', description: 'Absolute Y coordinate (pixels).' },
        double:   { type: 'boolean', description: 'Double-click instead of single click (default: false)' },
        button:   { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into a form element. Types character-by-character firing keydown/keypress/input/keyup for React synthetic event compatibility. Optionally clears existing content first.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:      { type: 'number', description: 'Tab ID' },
        text:       { type: 'string', description: 'Text to type' },
        selector:   { type: 'string', description: 'CSS selector of target input (if absent, types into currently focused element)' },
        clear:      { type: 'boolean', description: 'Clear existing content before typing (default: false)' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
        timeoutMs:  { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Send a keyboard event to the focused element. Supports modifier combos like "Control+a", "Control+c", "Shift+Tab", "Escape", "Enter", "ArrowDown", etc.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        key:   { type: 'string', description: 'Key or combo (e.g. "Enter", "Escape", "Tab", "Control+a", "Shift+ArrowDown")' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId', 'key'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element (fires mouseover, mouseenter, mousemove). Useful for revealing dropdown menus or tooltips.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector' },
        text:     { type: 'string', description: 'Visible text (fallback if selector is absent)' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'scroll_page',
    description: 'Scroll the page or a specific element. Can scroll to absolute position, by delta amount, or directly to a target element.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        toElement: { type: 'string', description: 'CSS selector — scroll until this element is visible' },
        selector:  { type: 'string', description: 'CSS selector of scrollable container (default: window)' },
        x:         { type: 'number', description: 'Absolute scroll X position' },
        y:         { type: 'number', description: 'Absolute scroll Y position' },
        deltaX:    { type: 'number', description: 'Scroll by this many pixels horizontally' },
        deltaY:    { type: 'number', description: 'Scroll by this many pixels vertically' },
        behavior:  { type: 'string', enum: ['instant', 'smooth'], description: 'Scroll behavior (default: instant)' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'select_option',
    description: 'Set the value of a <select> dropdown element.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the <select> element' },
        value:    { type: 'string', description: 'Option value attribute to select' },
        label:    { type: 'string', description: 'Option text label to select (used if value is absent, partial match)' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId', 'selector'],
    },
  },
  {
    name: 'check_box',
    description: 'Check or uncheck a checkbox or radio button.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the checkbox/radio' },
        checked:  { type: 'boolean', description: 'true = check, false = uncheck (default: true)' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId', 'selector'],
    },
  },
  {
    name: 'execute_js',
    description: 'Execute arbitrary JavaScript in the page context. The code is evaluated as an expression — return a value or a Promise. Use for complex interactions not covered by other tools, or to read page state directly.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        code:  { type: 'string', description: 'JavaScript expression to evaluate (can be async, e.g. "await fetch(...).then(r=>r.json())")' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default: 15000)' },
      },
      required: ['tabId', 'code'],
    },
  },
  {
    name: 'wait_for_element',
    description: 'Wait until an element appears in the DOM (optionally requiring it to be visible). Useful after click/navigation to wait for the next state to load.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selector:  { type: 'string', description: 'CSS selector to wait for' },
        text:      { type: 'string', description: 'Text content to wait for (alternative to selector)' },
        visible:   { type: 'boolean', description: 'Require element to have non-zero dimensions (default: false)' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'go_back',
    description: 'Navigate the tab back in browser history.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'Tab ID' } },
      required: ['tabId'],
    },
  },
  {
    name: 'go_forward',
    description: 'Navigate the tab forward in browser history.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'Tab ID' } },
      required: ['tabId'],
    },
  },
  {
    name: 'reload_page',
    description: 'Reload the current page in the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        hard:  { type: 'boolean', description: 'Bypass cache (default: false)' },
      },
      required: ['tabId'],
    },
  },

  // ── CAPTURE ────────────────────────────────────────────────────────────────
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the visible tab area as a base64-encoded PNG. The image is also saved to disk. Use marks=true to overlay numbered markers on interactive elements (Set-of-Marks approach) — the response includes an elements map so you can reference elements by number instead of coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:       { type: 'number', description: 'Tab ID to screenshot' },
        returnImage: { type: 'boolean', description: 'Include base64 image data in response (default: true; set false to only get filePath)' },
        marks:       { type: 'boolean', description: 'Overlay numbered markers on interactive elements. Returns {elements: {1: {text, selector, x, y}, ...}} for Set-of-Marks interaction. Requires screenshotMarks=true in config.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'refresh_data',
    description: 'Trigger fresh data collection on a tab and wait for it to arrive. Optionally specify which plugins to refresh. Returns a summary of what was collected and data ages.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID to refresh' },
        plugins:   { type: 'array', items: { type: 'string' }, description: 'Specific plugin IDs to refresh (default: all). E.g. ["text-coords", "ui-catalog", "react-fiber"]' },
        waitMs:    { type: 'number', description: 'How long to wait for data after triggering (default: 3000ms)' },
      },
      required: ['tabId'],
    },
  },

  // ── CONTROL ────────────────────────────────────────────────────────────────
  {
    name: 'set_config',
    description: 'Update the browser-whiskor activation config pushed to all connected tabs. Can enable/disable individual plugins or change the overall activation mode. Note: requires allowAgentConfig=true in config.json. Non-recommended changes (e.g. disabling security features) are logged and may be auto-reverted on next server restart.',
    inputSchema: {
      type: 'object',
      properties: {
        mode:    { type: 'string', enum: ['always_on', 'manual', 'api', 'selective', 'off'], description: 'Activation mode' },
        plugins: { type: 'object', description: 'Map of pluginId → boolean. E.g. {"react-fiber": true, "css-analyzer": false}' },
        options: { type: 'object', description: 'Plugin-specific options, e.g. {"textCoords": {"level": "word"}, "network": {"captureBody": true}}' },
      },
    },
  },
  {
    name: 'get_config_changes',
    description: 'Get a log of config changes made during this session. Shows what was changed, when, and any warnings about non-recommended changes. Use this to review your own config modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: 'Only show non-reverted changes (default: true)' },
      },
    },
  },
  {
    name: 'trigger_collect',
    description: 'Manually trigger data collection for specific plugins on a tab (or all tabs if tabId omitted). Use after page changes to get fresh data.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:   { type: 'number', description: 'Tab ID to collect from (omit for all tabs)' },
        plugins: { type: 'array', items: { type: 'string' }, description: 'Plugin IDs to run (omit for all)' },
      },
    },
  },
  {
    name: 'trigger_explorer',
    description: 'Start or stop the autonomous page explorer on a tab. The explorer discovers the app\'s state graph by systematically clicking interactive elements and recording state transitions.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        active:   { type: 'boolean', description: 'true = start, false = stop' },
        strategy: { type: 'string', enum: ['breadth_first', 'depth_first', 'random'], description: 'Exploration strategy (default: breadth_first)' },
      },
      required: ['tabId', 'active'],
    },
  },
  {
    name: 'navigate_to_state',
    description: 'Navigate from the current UI state to a target state by replaying recorded actions. Uses BFS to find the shortest path on the state graph, then executes each action step-by-step with hash verification. If no path exists, falls back to direct URL navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:           { type: 'number', description: 'Tab ID to navigate' },
        hash:            { type: 'string', description: 'Target state hash (compositeHash)' },
        siteVersion:     { type: 'string', description: 'Site version (omit to auto-detect)' },
        timeoutMs:       { type: 'number', description: 'Total timeout in ms (default: 30000)' },
        maxSteps:        { type: 'number', description: 'Max actions to replay (default: 10)' },
        verifyEachStep:  { type: 'boolean', description: 'Verify hash after each step (default: true)' },
        allowUrlFallback: { type: 'boolean', description: 'Fall back to URL navigation if no path (default: true)' },
      },
      required: ['tabId', 'hash'],
    },
  },
  {
    name: 'get_navigation_path',
    description: 'Dry-run version of navigate_to_state. Returns the planned path and confidence without executing any actions. Use this to check if a state is reachable before committing to navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        fromHash:    { type: 'string', description: 'Starting state hash (omit for current state)' },
        toHash:      { type: 'string', description: 'Target state hash' },
        tabId:       { type: 'number', description: 'Tab ID (needed if fromHash omitted)' },
        siteVersion: { type: 'string', description: 'Site version (omit to auto-detect)' },
      },
      required: ['toHash'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSessionFile(tabId, relPath) {
  return cache.readSessionFile(tabId, relPath);
}

function withFreshness(tabId, pluginId, data) {
  if (!data) return null;
  const info = cache.freshnessInfo(tabId, pluginId);
  const warnings = [];

  // Stale data warning
  if (info && info.isStale) {
    warnings.push({
      code: 'STALE_DATA',
      ageMs: info.ageMs,
      message: `Data is ${Math.round(info.ageMs / 1000)}s old (threshold: 30s). Consider calling refresh_data.`,
    });
  }

  // Adapter note → warning (framework adapters emit notes about limitations)
  if (data.note) {
    warnings.push({
      code: 'ADAPTER_LIMITED',
      message: data.note,
    });
  }

  // Framework-specific completeness checks
  if (pluginId === 'solid' && data) {
    if (!data.ownerTree && !data.stores && !data.signals && data.hydrationKeys?.length === 0) {
      warnings.push({
        code: 'PARTIAL_TREE',
        message: 'SolidJS: only hydration markers found. Owner tree, stores, and signals not available (likely production build).',
      });
    }
  }
  if (pluginId === 'svelte' && data) {
    if (!data.components?.length && !data.ownerTree && !data.stores && data.scopedHashes?.length) {
      warnings.push({
        code: 'PARTIAL_TREE',
        message: 'Svelte: only CSS scoping hashes found. Component instances not accessible (production build limitation).',
      });
    }
  }
  if (pluginId === 'preact' && data) {
    if (!data.componentTree && data.detectionNote) {
      warnings.push({
        code: 'PARTIAL_TREE',
        message: data.detectionNote,
      });
    }
  }

  if (warnings.length > 0) {
    return { ...data, _freshness: info, _warnings: warnings };
  }
  return { ...data, _freshness: info };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function callTool(name, args) {
  switch (name) {

    // ── READ ──────────────────────────────────────────────────────────────────

    case 'get_sessions': {
      return { sessions: cache.getSessionList() };
    }

    case 'get_index': {
      const data = cache.getSessionData(args.tabId);
      if (!data) return { error: `No session for tabId ${args.tabId}. Call get_sessions first.` };
      return data;
    }

    case 'get_text_coords': {
      const raw = readSessionFile(args.tabId, 'raw/visual/text-coords.json');
      if (!raw) return { error: 'TEXT_COORDS not available. Trigger refresh_data first.' };

      const level      = args.level || 'words';
      const search     = args.search?.toLowerCase();
      const matchQuery = args.match;
      const maxResults = args.maxResults || 50;
      const minScore   = args.minScore != null ? args.minScore : 0.1;

      // Fuzzy match mode
      if (matchQuery) {
        if (level === 'all') {
          const scored = (arr) => arr
            .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
            .filter(i => i._score >= minScore)
            .sort((a, b) => b._score - a._score)
            .slice(0, maxResults);
          const w = scored(raw.words || []);
          const l = scored(raw.lines || []);
          const b = scored(raw.blocks || []);
          const result = {
            capturedAt: raw.capturedAt,
            pageUrl:    raw.pageUrl,
            viewport:   raw.viewport,
            query:      matchQuery,
            minScore,
            words:      w,
            lines:      l,
            blocks:     b,
          };
          if (!w.length && !l.length && !b.length) {
            result._warnings = [{ code: 'NO_MATCH', message: `No text matches "${matchQuery}" with score >= ${minScore}. Try a different query or lower minScore.` }];
          }
          return withFreshness(args.tabId, 'text-coords', result);
        }
        const items = (raw[level] || raw.words || [])
          .map(i => ({ ...i, _score: fuzzyScore(matchQuery, i.text) }))
          .filter(i => i._score >= minScore)
          .sort((a, b) => b._score - a._score)
          .slice(0, maxResults);
        const result = {
          capturedAt:   raw.capturedAt,
          pageUrl:      raw.pageUrl,
          viewport:     raw.viewport,
          query:        matchQuery,
          minScore,
          totalMatches: items.length,
          level,
          [level]:      items,
        };
        if (!items.length) {
          result._warnings = [{ code: 'NO_MATCH', message: `No ${level} match "${matchQuery}" with score >= ${minScore}.` }];
        }
        return withFreshness(args.tabId, 'text-coords', result);
      }

      // Exact substring mode
      if (level === 'all') {
        const result = { ...raw };
        if (search) {
          result.words  = (raw.words  || []).filter(w => w.text.toLowerCase().includes(search));
          result.lines  = (raw.lines  || []).filter(l => l.text.toLowerCase().includes(search));
          result.blocks = (raw.blocks || []).filter(b => b.text.toLowerCase().includes(search));
        }
        return withFreshness(args.tabId, 'text-coords', result);
      }

      let items = raw[level] || raw.words || [];
      if (search) items = items.filter(i => i.text.toLowerCase().includes(search));

      return withFreshness(args.tabId, 'text-coords', {
        capturedAt:   raw.capturedAt,
        pageUrl:      raw.pageUrl,
        viewport:     raw.viewport,
        totalItems:   items.length,
        level,
        [level]:      items,
        fullText:     search ? undefined : raw.fullText,
      });
    }

    case 'get_framework_state': {
      const index = cache.getSessionData(args.tabId);
      if (!index) return { error: `No session for tabId ${args.tabId}` };

      const fw = args.framework || 'auto';
      const files = (index.files && index.files.raw) || {};

      const fwFileMap = {
        react:   files.react_snapshot,
        vue3:    files.vue_snapshot,
        vue2:    files.vue2_snapshot,
        angular: files.angular_snapshot,
        svelte:  files.svelte_snapshot,
        alpine:  files.alpine_snapshot,
        preact:  files.preact_snapshot,
        solid:   files.solid_snapshot,
        dom:     files.dom_generic,
      };

      const fwPluginMap = {
        react: 'react-fiber', vue3: 'vue3', vue2: 'vue2',
        angular: 'angular', svelte: 'svelte', alpine: 'alpine',
        preact: 'preact', solid: 'solid', dom: 'dom-generic',
      };

      let targetFw = null;
      let targetFile = null;
      if (fw === 'auto') {
        const priority = ['react','vue3','vue2','angular','svelte','alpine','preact','solid','dom'];
        for (const key of priority) {
          if (fwFileMap[key]) { targetFw = key; targetFile = fwFileMap[key]; break; }
        }
      } else {
        targetFw = fw;
        targetFile = fwFileMap[fw];
      }

      if (!targetFile) return { error: `Framework '${fw}' not detected. Available: ${Object.keys(fwFileMap).filter(k => fwFileMap[k]).join(', ') || 'none'}` };
      const data = readSessionFile(args.tabId, targetFile);
      if (!data) return { error: `File ${targetFile} not readable.` };
      return withFreshness(args.tabId, fwPluginMap[targetFw] || targetFw, data);
    }

    case 'get_network': {
      const raw = readSessionFile(args.tabId, 'raw/network/requests.json');
      if (!raw) return { requests: [], totalRequests: 0, note: 'No network data yet. Trigger refresh_data.' };

      let reqs = raw.requests || [];
      if (args.filterUrl)    reqs = reqs.filter(r => r.url?.includes(args.filterUrl));
      if (args.filterType)   reqs = reqs.filter(r => r.initiatorType === args.filterType || r.type === args.filterType);
      if (args.filterStatus) reqs = reqs.filter(r => r.status === args.filterStatus);
      const limit = args.limit || 100;
      const total = reqs.length;
      reqs = reqs.slice(-limit);

      return withFreshness(args.tabId, 'network-hook', {
        capturedAt:    raw.capturedAt,
        totalRequests: total,
        returned:      reqs.length,
        requests:      reqs,
      });
    }

    case 'get_ui_catalog': {
      const raw = readSessionFile(args.tabId, 'raw/ui/elements.json');
      if (!raw) return { error: 'UI catalog not available. Trigger refresh_data.' };

      if (args.search) {
        const s = args.search.toLowerCase();
        const filter = arr => (arr || []).filter(el =>
          (el.text || el.label || el.placeholder || el.name || '').toLowerCase().includes(s)
        );
        return withFreshness(args.tabId, 'ui-catalog', {
          ...raw,
          buttons: filter(raw.buttons),
          links:   filter(raw.links),
          inputs:  filter(raw.inputs),
        });
      }
      return withFreshness(args.tabId, 'ui-catalog', raw);
    }

    case 'get_accessibility': {
      const raw = readSessionFile(args.tabId, 'raw/accessibility/tree.json');
      if (!raw) return { error: 'Accessibility tree not available. Trigger refresh_data with plugins: ["accessibility"].' };

      let tree = raw;
      if (args.role) {
        const filterRole = (node) => {
          if (!node) return null;
          const match = (node.role || '').toLowerCase() === args.role.toLowerCase();
          const filteredChildren = (node.children || []).map(filterRole).filter(Boolean);
          if (match || filteredChildren.length) {
            return { ...node, children: filteredChildren };
          }
          return null;
        };
        tree = { ...raw, tree: filterRole(raw.tree) };
      }

      const maxDepth = args.maxDepth || 10;
      const truncate = (node, depth) => {
        if (!node || depth > maxDepth) return null;
        return {
          ...node,
          children: (node.children || []).map(c => truncate(c, depth + 1)).filter(Boolean),
        };
      };

      return withFreshness(args.tabId, 'accessibility', {
        ...tree,
        tree: truncate(tree.tree, 0),
      });
    }

    case 'get_storage': {
      const raw = readSessionFile(args.tabId, 'raw/storage/data.json');
      if (!raw) return { error: 'Storage data not available. Trigger refresh_data with plugins: ["storage-reader"].' };

      if (args.filter) {
        const f = args.filter.toLowerCase();
        const filterObj = obj => Object.fromEntries(
          Object.entries(obj || {}).filter(([k]) => k.toLowerCase().includes(f))
        );
        return withFreshness(args.tabId, 'storage-reader', {
          ...raw,
          localStorage:   filterObj(raw.localStorage),
          sessionStorage: filterObj(raw.sessionStorage),
          cookies:        (raw.cookies || []).filter(c => c.name?.toLowerCase().includes(f)),
        });
      }
      return withFreshness(args.tabId, 'storage-reader', raw);
    }

    case 'get_console_logs': {
      const raw = readSessionFile(args.tabId, 'raw/console/logs.json');
      if (!raw) {
        // Try in-memory
        const logs = cache.getConsoleLogs(args.tabId);
        if (!logs.length) return { error: 'No console logs captured yet. Enable console-logger plugin and trigger refresh_data.' };
        return { totalEntries: logs.length, entries: logs };
      }

      let entries = raw.entries || [];
      if (args.level && args.level !== 'all') {
        entries = entries.filter(e => e.level === args.level);
      }
      if (args.search) {
        const s = args.search.toLowerCase();
        entries = entries.filter(e => (e.message || '').toLowerCase().includes(s));
      }
      const limit = args.limit || 200;
      entries = entries.slice(-limit);

      return withFreshness(args.tabId, 'console-logger', {
        capturedAt:   raw.capturedAt,
        totalEntries: raw.totalEntries || entries.length,
        returned:     entries.length,
        entries,
      });
    }

    case 'get_perf_metrics': {
      const raw = readSessionFile(args.tabId, 'raw/perf/metrics.json');
      if (!raw) return { error: 'Performance metrics not available. Trigger refresh_data.' };
      return withFreshness(args.tabId, 'perf-analyzer', raw);
    }

    case 'get_css_analysis': {
      const raw = readSessionFile(args.tabId, 'raw/css/analysis.json');
      if (!raw) return { error: 'CSS analysis not available.' };
      return withFreshness(args.tabId, 'css-analyzer', raw);
    }

    case 'get_dom_snapshot': {
      const raw = readSessionFile(args.tabId, 'raw/dom/snapshot.json');
      if (!raw) return { error: 'DOM snapshot not available.' };
      return withFreshness(args.tabId, 'dom-generic', raw);
    }

    case 'get_state_map': {
      if (!args.siteVersion) {
        const { getAllGraphs } = require('./state-machine');
        return { graphs: getAllGraphs() };
      }
      const { getGraph } = require('./state-machine');
      const g = getGraph(args.siteVersion);
      if (!g) {
        const graphFile = path.join(__dirname, '..', 'cache', 'graphs', `${args.siteVersion}.json`);
        if (fs.existsSync(graphFile)) {
          return JSON.parse(fs.readFileSync(graphFile, 'utf8'));
        }
        return { error: `No graph for siteVersion "${args.siteVersion}".` };
      }
      const nodeCount = Object.keys(g.nodes).length;
      const edgeCount = Object.values(g.edges).reduce((s, v) => s + Object.keys(v).length, 0);
      return { ...g, nodeCount, edgeCount };
    }

    // ── STATE SNAPSHOT NAVIGATION (NEW) ──────────────────────────────────────

    case 'list_states': {
      const stateStore = require('./state-store');
      const states = stateStore.getAllNodesFlat({
        siteVersion: args.siteVersion,
        filter: args.filter,
        tags: args.tags,
        sortBy: args.sortBy || 'lastSeen',
        limit: Math.min(args.limit || 50, 500),
      });
      return { totalStates: states.length, states };
    }

    case 'search_states': {
      const stateStore = require('./state-store');
      if (!args.query) return { error: 'query is required' };

      // Search across all graphs or specific one
      const graphs = args.siteVersion
        ? [stateStore.getGraph(args.siteVersion)].filter(Boolean)
        : stateStore.getAllGraphs().map(g => stateStore.getGraph(g.siteVersion)).filter(Boolean);

      const allResults = [];
      for (const g of graphs) {
        const semantic = require('./state-semantic');
        const results = semantic.searchStates(g, args.query, {
          searchIn: args.searchIn || 'all',
          limit: args.limit || 10,
        });
        for (const r of results) {
          r.siteVersion = g.siteVersion;
        }
        allResults.push(...results);
      }
      allResults.sort((a, b) => b.score - a.score);
      return { query: args.query, totalResults: allResults.length, results: allResults.slice(0, args.limit || 10) };
    }

    case 'get_state_detail': {
      if (!args.hash) return { error: 'hash is required' };
      const stateStore = require('./state-store');

      // Find the graph containing this hash
      let g = args.siteVersion
        ? stateStore.getGraph(args.siteVersion)
        : stateStore.findGraphContaining(args.hash);

      if (!g) return { error: `State "${args.hash}" not found in any graph.` };

      let node = stateStore.getNodeByHash(g.siteVersion, args.hash);
      if (!node) return { error: `State "${args.hash}" not found.` };

      const result = { ...node };

      // Include snapshot if requested
      if (args.includeSnapshot && node.snapshotRef) {
        const snapshot = stateStore.loadSnapshot(g.siteVersion, args.hash);
        result.snapshot = snapshot;
      }

      // Include edges if requested
      if (args.includeEdges !== false) {
        const inEdges = g.edgeIndex[args.hash] || [];
        const outEdges = g.edges[args.hash] || {};

        result.reachableFrom = [];
        for (const edgeKey of inEdges) {
          // Find which node this edge comes from
          for (const [fromHash, edges] of Object.entries(g.edges)) {
            if (edges[edgeKey]) {
              const fromNode = g.nodes[fromHash];
              if (fromNode) {
                result.reachableFrom.push({
                  fromHash,
                  fromLabel: fromNode.label,
                  action: edges[edgeKey].action,
                  trigger: edges[edgeKey].trigger,
                  confidence: edges[edgeKey].confidence,
                });
              }
              break;
            }
          }
        }

        result.canReachTo = [];
        for (const [edgeKey, edge] of Object.entries(outEdges)) {
          if (edge.to && g.nodes[edge.to]) {
            result.canReachTo.push({
              toHash: edge.to,
              toLabel: g.nodes[edge.to].label,
              action: edge.action,
              trigger: edge.trigger,
              confidence: edge.confidence,
            });
          }
        }
      }

      return result;
    }

    case 'pin_state': {
      if (!args.hash) return { error: 'hash is required' };
      const stateStore = require('./state-store');

      let g = args.siteVersion
        ? stateStore.getGraph(args.siteVersion)
        : stateStore.findGraphContaining(args.hash);

      if (!g) return { error: `State "${args.hash}" not found.` };

      const result = stateStore.pinNode(g.siteVersion, args.hash, args.label, args.tags);
      return result;
    }

    // ── WRITE ─────────────────────────────────────────────────────────────────

    case 'navigate_to':
      return _callAction(args.tabId, { type: 'navigate', url: args.url }, args.timeoutMs);

    case 'click':
      return _callAction(args.tabId, {
        type: 'click',
        selector: args.selector,
        text:     args.text,
        x:        args.x,
        y:        args.y,
        double:   args.double,
        button:   args.button,
      }, args.timeoutMs);

    case 'type_text':
      return _callAction(args.tabId, {
        type:       'type',
        text:       args.text,
        selector:   args.selector,
        clear:      args.clear,
        pressEnter: args.pressEnter,
      }, args.timeoutMs);

    case 'press_key':
      return _callAction(args.tabId, { type: 'press_key', key: args.key }, args.timeoutMs);

    case 'hover':
      return _callAction(args.tabId, { type: 'hover', selector: args.selector, text: args.text }, args.timeoutMs);

    case 'scroll_page':
      return _callAction(args.tabId, {
        type:      'scroll',
        toElement: args.toElement,
        selector:  args.selector,
        x:         args.x,
        y:         args.y,
        deltaX:    args.deltaX,
        deltaY:    args.deltaY,
        behavior:  args.behavior,
      }, args.timeoutMs);

    case 'select_option':
      return _callAction(args.tabId, {
        type: 'select_option', selector: args.selector, value: args.value, label: args.label,
      }, args.timeoutMs);

    case 'check_box':
      return _callAction(args.tabId, {
        type: 'check', selector: args.selector, checked: args.checked !== false,
      }, args.timeoutMs);

    case 'execute_js':
      if (!_security.allowExecuteJs) return { error: 'execute_js is disabled by server security config (allowExecuteJs=false).' };
      return _callAction(args.tabId, { type: 'execute_js', code: args.code, captureConsole: true }, args.timeoutMs);

    case 'wait_for_element':
      return _callAction(args.tabId, {
        type:      'wait_for_element',
        selector:  args.selector,
        text:      args.text,
        visible:   args.visible,
        timeoutMs: args.timeoutMs,
      }, (args.timeoutMs || 10000) + 3000);

    case 'go_back':
      return _callAction(args.tabId, { type: 'go_back' });

    case 'go_forward':
      return _callAction(args.tabId, { type: 'go_forward' });

    case 'reload_page':
      return _callAction(args.tabId, { type: 'reload', hard: args.hard });

    // ── CAPTURE ───────────────────────────────────────────────────────────────

    case 'capture_screenshot': {
      if (!_captureScreenshot) return { error: 'Screenshot service not available (no browser connected).' };
      try {
        const opts = { marks: args.marks === true };
        const result = await _captureScreenshot(args.tabId, opts);
        if (!result.ok) return { ok: false, error: result.error };
        const response = {
          ok: true,
          capturedAt:  result.capturedAt,
          filePath:    result.filePath,
          width:       result.width,
          height:      result.height,
        };
        if (args.returnImage !== false) {
          response.dataUrl = result.dataUrl;
        }
        if (result.elements) {
          // Build a numbered map for Set-of-Marks interaction
          response.elements = {};
          for (const el of result.elements) {
            response.elements[el.id] = {
              tag: el.tag,
              text: el.text,
              center: { x: el.x, y: el.y },
              size: { w: el.w, h: el.h },
              selector: el.selector,
            };
          }
          response._note = 'Use element numbers to reference elements. E.g. "click element 3" or describe what you see at marker N.';
        }
        return response;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'refresh_data': {
      if (!_triggerCollect) return { error: 'No browser connected.' };
      _triggerCollect(args.tabId, args.plugins || null);
      const waitMs = args.waitMs || 3000;
      await new Promise(r => setTimeout(r, waitMs));
      const session = cache.getSessionList().find(s => s.tabId === args.tabId);
      if (!session) return { ok: false, error: 'Session not found after refresh.' };
      return {
        ok: true,
        waitedMs: waitMs,
        session: {
          tabId:        session.tabId,
          url:          session.url,
          dataAgeMs:    session.dataAgeMs,
          isStale:      session.isStale,
          freshnessMap: session.freshnessMap,
          summary:      session.summary,
        },
      };
    }

    // ── CONTROL ───────────────────────────────────────────────────────────────

    case 'set_config': {
      if (!_pushConfig) return { error: 'Config service not available.' };

      // Check if agent config changes are allowed
      if (!_configLog || (_configLog && !_configLog._allowAgentConfig)) {
        // We need to check the actual config - for now, allow if _pushConfig exists
        // The actual gate is in index.js via _cfg.agentControl.allowAgentConfig
      }

      const result = _pushConfig({ mode: args.mode, plugins: args.plugins, options: args.options }, 'mcp-agent');
      return {
        ok: true,
        warnings: result?.warnings || [],
        _note: result?.warnings?.length
          ? 'Some changes are non-recommended and may be auto-reverted on next server restart. Use get_config_changes to review.'
          : undefined,
      };
    }

    case 'get_config_changes': {
      if (!_configLog) return { error: 'Config change log not available.' };
      const changes = args.activeOnly !== false
        ? _configLog.getActiveChanges()
        : _configLog._getAll?.() || [];
      return {
        changes,
        totalChanges: changes.length,
        startupWarnings: _startupWarnings,
      };
    }

    case 'trigger_collect': {
      if (!_triggerCollect) return { error: 'No browser connected.' };
      _triggerCollect(args.tabId || null, args.plugins || null);
      return { ok: true, tabId: args.tabId || 'all', plugins: args.plugins || 'all' };
    }

    case 'trigger_explorer': {
      if (!_triggerExplorer) return { error: 'Explorer service not available.' };
      _triggerExplorer(args.tabId, args.active, args.strategy);
      return { ok: true, tabId: args.tabId, active: args.active, strategy: args.strategy || 'breadth_first' };
    }

    // ── STATE NAVIGATION ─────────────────────────────────────────────────────

    case 'navigate_to_state': {
      if (!_executeAction) return { ok: false, error: 'No browser connected.' };
      const navigator = require('./state-navigator');
      try {
        return await navigator.navigate(args.tabId, args.hash, {
          siteVersion: args.siteVersion,
          timeoutMs: args.timeoutMs,
          maxSteps: args.maxSteps,
          verifyEachStep: args.verifyEachStep !== false,
          allowUrlFallback: args.allowUrlFallback !== false,
          stepTimeoutMs: 5000,
        }, _executeAction, _navigateBroadcast || (() => {}));
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'get_navigation_path': {
      const navigator = require('./state-navigator');
      let fromHash = args.fromHash;
      if (!fromHash && args.tabId && _executeAction) {
        // Could request current hash, but for dry-run just return error
        return { error: 'fromHash is required for dry-run. Use navigate_to_state to navigate from current state.' };
      }
      if (!fromHash) return { error: 'fromHash is required' };
      return navigator.getNavigationPath(fromHash, args.toHash, args.siteVersion);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Action helper ─────────────────────────────────────────────────────────────

async function _callAction(tabId, action, timeoutMs) {
  if (!_executeAction) {
    return { ok: false, error: 'No browser connected — action execution requires an active extension WebSocket connection.' };
  }
  try {
    return await _executeAction(tabId, action, timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── MCP stdio transport ───────────────────────────────────────────────────────

function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try { request = JSON.parse(trimmed); }
    catch { return; }

    const { id, method, params } = request;

    try {
      let result;

      if (method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities:    { tools: {} },
          serverInfo:      { name: 'browser-whiskor', version: '3.0.0' },
        };
      } else if (method === 'notifications/initialized') {
        return; // No response needed
      } else if (method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (method === 'tools/call') {
        const toolResult = await callTool(params.name, params.arguments || {});
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
      } else {
        result = {};
      }

      const response = JSON.stringify({ jsonrpc: '2.0', id, result });
      process.stdout.write(response + '\n');
    } catch (err) {
      const errResponse = JSON.stringify({
        jsonrpc: '2.0', id,
        error: { code: -32603, message: err.message },
      });
      process.stdout.write(errResponse + '\n');
    }
  });

  process.stderr.write('[whiskor:mcp] MCP server ready — ' + TOOLS.length + ' tools available\n');
}

module.exports = { startMcpServer, setCallbacks, setActionCallbacks, setSecurity, setNavigateBroadcast, setConfigLog };
