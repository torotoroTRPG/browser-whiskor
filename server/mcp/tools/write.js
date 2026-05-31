/**
 * server/mcp/tools/write.js
 * WRITEカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

// JSON-schema fragment shared by interaction tools that support post-action
// state observation. Spread into each tool's `properties`.
const OBSERVE_SCHEMA = {
  observe: {
    type: 'boolean',
    description: 'After the action, watch the page state hash until it settles and report whether the action changed the UI state. Lets you skip a separate refresh_data round-trip to check if anything happened. Requires the page to expose a composite state hash (explorer/state graph active); otherwise reported as unavailable.',
  },
  observeTimeoutMs: {
    type: 'number',
    description: 'Max time to wait for the state hash to settle when observe=true (default: 3000ms).',
  },
};

/**
 * Observe the page state hash before and after an action so the agent learns
 * whether the action actually transitioned the UI — without a separate read.
 *
 * Degrades gracefully: if the hash channel is unavailable (proxy mode, explorer
 * not running, or the page never reports a composite hash) the action still runs
 * and `_observation.available` is false. Never lets observation failure mask the
 * underlying action result.
 *
 * @returns the action result, with an attached `_observation` when observe=true.
 */
async function observeAction(cb, tabId, action, args) {
  if (args.observe !== true) {
    return cb._callAction(tabId, action, args.timeoutMs);
  }

  const navigator = require('../../state-navigator');
  const broadcast = cb._navigateBroadcast;
  const maxWaitMs = args.observeTimeoutMs || 3000;

  if (typeof broadcast !== 'function') {
    const result = await cb._callAction(tabId, action, args.timeoutMs);
    return { ...result, _observation: { available: false, reason: 'State hash observation not available in this server mode.' } };
  }

  // Pre-action hash (best effort — short timeout so we never stall the action).
  let fromHash = null;
  try {
    const pre = await navigator.requestHash(tabId, broadcast, 1500);
    fromHash = pre?.compositeHash || null;
  } catch (_) { /* page does not report a hash yet */ }

  const result = await cb._callAction(tabId, action, args.timeoutMs);

  const observation = await _awaitSettled(navigator, tabId, broadcast, fromHash, maxWaitMs);
  return { ...result, _observation: observation };
}

/**
 * Poll the page state hash until two consecutive reads agree (settled) or the
 * deadline passes, then summarise the transition relative to `fromHash`.
 */
async function _awaitSettled(navigator, tabId, broadcast, fromHash, maxWaitMs) {
  const SETTLE_READS = 2;
  const INTERVAL_MS  = 200;
  const start = Date.now();

  let lastHash = null;
  let stable   = 0;
  let latest   = null;

  while (Date.now() - start < maxWaitMs) {
    let h = null;
    try {
      const r = await navigator.requestHash(tabId, broadcast, 1500);
      h = r?.compositeHash || null;
    } catch (_) {
      break; // hash channel unresponsive — stop polling
    }
    if (h == null) break;
    latest = h;

    if (h === lastHash) {
      if (++stable >= SETTLE_READS) break;
    } else {
      stable = 1;
      lastHash = h;
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  if (latest == null) {
    return { available: false, reason: 'Page did not report a state hash (explorer/state graph may be inactive).' };
  }

  return {
    available: true,
    fromHash,
    toHash: latest,
    hashChanged: fromHash != null ? fromHash !== latest : null,
    settled: stable >= SETTLE_READS,
    elapsedMs: Date.now() - start,
  };
}

module.exports = function registerWriteTools(registry) {
  const tools = [];

  // 19. navigate_to
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'navigate', url: args.url }, args.timeoutMs);
    },
  });

  // 20. click
  tools.push({
    definition: {
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
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type: 'click',
        selector: args.selector,
        text:     args.text,
        x:        args.x,
        y:        args.y,
        double:   args.double,
        button:   args.button,
      }, args);
    },
  });

  // 21. right_click
  tools.push({
    definition: {
      name: 'right_click',
      description: 'Right-click (context menu) on an element. Fires contextmenu event. Target by CSS selector, visible text, or absolute coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          text:     { type: 'string', description: 'Visible text of element (partial match, case-insensitive)' },
          x:        { type: 'number', description: 'Absolute X coordinate' },
          y:        { type: 'number', description: 'Absolute Y coordinate' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type:     'right_click',
        selector: args.selector,
        text:     args.text,
        x:        args.x,
        y:        args.y,
      }, args);
    },
  });

  // 22. type_text
  tools.push({
    definition: {
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
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId', 'text'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type:       'type',
        text:       args.text,
        selector:   args.selector,
        clear:      args.clear,
        pressEnter: args.pressEnter,
      }, args);
    },
  });

  // 23. press_key
  tools.push({
    definition: {
      name: 'press_key',
      description: 'Send a keyboard event to the focused element. Supports modifier combos like "Control+a", "Control+c", "Shift+Tab", "Escape", "Enter", "ArrowDown", etc.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          key:   { type: 'string', description: 'Key or combo (e.g. "Enter", "Escape", "Tab", "Control+a", "Shift+ArrowDown")' },
          timeoutMs: { type: 'number' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId', 'key'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, { type: 'press_key', key: args.key }, args);
    },
  });

  // 24. hover
  tools.push({
    definition: {
      name: 'hover',
      description: 'Hover over an element (fires mouseover, mouseenter, mousemove). Useful for revealing dropdown menus or tooltips.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          text:     { type: 'string', description: 'Visible text (fallback if selector is absent)' },
          timeoutMs: { type: 'number' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, { type: 'hover', selector: args.selector, text: args.text }, args);
    },
  });

  // 25. scroll_page
  tools.push({
    definition: {
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
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type:      'scroll',
        toElement: args.toElement,
        selector:  args.selector,
        x:         args.x,
        y:         args.y,
        deltaX:    args.deltaX,
        deltaY:    args.deltaY,
        behavior:  args.behavior,
      }, args);
    },
  });

  // 26. select_option
  tools.push({
    definition: {
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
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type: 'select_option', selector: args.selector, value: args.value, label: args.label,
      }, args);
    },
  });

  // 27. check_box
  tools.push({
    definition: {
      name: 'check_box',
      description: 'Check or uncheck a checkbox or radio button.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector of the checkbox/radio' },
          checked:  { type: 'boolean', description: 'true = check, false = uncheck (default: true)' },
          timeoutMs: { type: 'number' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type: 'check', selector: args.selector, checked: args.checked !== false,
      }, args);
    },
  });

  // 28. drag
  tools.push({
    definition: {
      name: 'drag',
      description: 'Drag from one position to another on the page. Fires mousedown → mousemove → mouseup with dragenter/dragover/drop events for HTML5 drag-and-drop compatibility. Use absolute page coordinates or CSS selectors.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:        { type: 'number', description: 'Tab ID' },
          fromX:        { type: 'number', description: 'Absolute X coordinate of drag start' },
          fromY:        { type: 'number', description: 'Absolute Y coordinate of drag start' },
          toX:          { type: 'number', description: 'Absolute X coordinate of drag end' },
          toY:          { type: 'number', description: 'Absolute Y coordinate of drag end' },
          fromSelector: { type: 'string', description: 'CSS selector of drag source (alternative to fromX/fromY — uses element center)' },
          timeoutMs:    { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type:        'drag',
        fromX:       args.fromX,
        fromY:       args.fromY,
        toX:         args.toX,
        toY:         args.toY,
        fromSelector: args.fromSelector,
      }, args);
    },
  });

  // 29. mouse_scroll
  tools.push({
    definition: {
      name: 'mouse_scroll',
      description: 'Fire a wheel event at a specific position on the page. Useful for scrollable areas that require wheel events rather than scrollBy/scrollTo. Can specify delta or number of lines.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID' },
          x:         { type: 'number', description: 'Absolute X coordinate to fire wheel event at' },
          y:         { type: 'number', description: 'Absolute Y coordinate to fire wheel event at' },
          deltaX:    { type: 'number', description: 'Horizontal scroll delta (default: 0)' },
          deltaY:    { type: 'number', description: 'Vertical scroll delta (positive = scroll down)' },
          lines:     { type: 'number', description: 'Number of lines to scroll (alternative to deltaY; 1 line ≈ 100px)' },
          selector:  { type: 'string', description: 'CSS selector — fires wheel at element center (alternative to x/y)' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return observeAction(cb, args.tabId, {
        type:     'mouse_scroll',
        x:        args.x,
        y:        args.y,
        deltaX:   args.deltaX,
        deltaY:   args.deltaY,
        lines:    args.lines,
        selector: args.selector,
      }, args);
    },
  });

  // 30. execute_js
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      if (!cb._security?.allowExecuteJs) return { error: 'execute_js is disabled by server security config (allowExecuteJs=false).' };
      console.warn('[SECURITY] execute_js invoked — arbitrary JS execution in page context (tabId=%s, code=%s)', args.tabId, args.code?.slice(0, 120));
      return cb._callAction(args.tabId, { type: 'execute_js', code: args.code, captureConsole: true }, args.timeoutMs);
    },
  });

  // 31. wait_for_element
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type:      'wait_for_element',
        selector:  args.selector,
        text:      args.text,
        visible:   args.visible,
        timeoutMs: args.timeoutMs,
      }, (args.timeoutMs || 10000) + 3000);
    },
  });

  // 32. go_back
  tools.push({
    definition: {
      name: 'go_back',
      description: 'Navigate the tab back in browser history.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'number', description: 'Tab ID' } },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'go_back' });
    },
  });

  // 33. go_forward
  tools.push({
    definition: {
      name: 'go_forward',
      description: 'Navigate the tab forward in browser history.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'number', description: 'Tab ID' } },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'go_forward' });
    },
  });

  // 34. reload_page
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'reload', hard: args.hard });
    },
  });

  registry.registerTools(tools);
};
