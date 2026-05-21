/**
 * server/mcp/tools/write.js
 * WRITEカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

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
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type: 'click',
        selector: args.selector,
        text:     args.text,
        x:        args.x,
        y:        args.y,
        double:   args.double,
        button:   args.button,
      }, args.timeoutMs);
    },
  });

  // 21. type_text
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
        },
        required: ['tabId', 'text'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type:       'type',
        text:       args.text,
        selector:   args.selector,
        clear:      args.clear,
        pressEnter: args.pressEnter,
      }, args.timeoutMs);
    },
  });

  // 22. press_key
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
        },
        required: ['tabId', 'key'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'press_key', key: args.key }, args.timeoutMs);
    },
  });

  // 23. hover
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
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, { type: 'hover', selector: args.selector, text: args.text }, args.timeoutMs);
    },
  });

  // 24. scroll_page
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
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type:      'scroll',
        toElement: args.toElement,
        selector:  args.selector,
        x:         args.x,
        y:         args.y,
        deltaX:    args.deltaX,
        deltaY:    args.deltaY,
        behavior:  args.behavior,
      }, args.timeoutMs);
    },
  });

  // 25. select_option
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
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type: 'select_option', selector: args.selector, value: args.value, label: args.label,
      }, args.timeoutMs);
    },
  });

  // 26. check_box
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
        },
        required: ['tabId', 'selector'],
      },
    },
    handler: async (args, cb) => {
      return cb._callAction(args.tabId, {
        type: 'check', selector: args.selector, checked: args.checked !== false,
      }, args.timeoutMs);
    },
  });

  // 27. execute_js
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
      return cb._callAction(args.tabId, { type: 'execute_js', code: args.code, captureConsole: true }, args.timeoutMs);
    },
  });

  // 28. wait_for_element
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

  // 29. go_back
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

  // 30. go_forward
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

  // 31. reload_page
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
