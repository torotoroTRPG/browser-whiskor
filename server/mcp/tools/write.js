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
// Defaults for the post-action settle loop. Overridable via config.json `observe`.
const OBSERVE_DEFAULTS = {
  adaptive:    true,
  intervalsMs: [60, 60, 120, 200], // fast first reads catch quick SPA transitions
  intervalMs:  200,                // fixed interval used when adaptive=false (legacy)
  settleReads: 2,                  // consecutive equal reads required
  quiescentMs: 150,                // min quiet time after the last change before settling
};

// Resolve observe tuning from the live server config (cb._config.observe),
// falling back to the legacy-compatible defaults.
function _observeOpts(cb) {
  const c = (cb && cb._config && cb._config.observe) || {};
  const adaptive = c.adaptive !== false;
  return {
    adaptive,
    intervalsMs: Array.isArray(c.intervalsMs) && c.intervalsMs.length ? c.intervalsMs : OBSERVE_DEFAULTS.intervalsMs,
    intervalMs:  c.intervalMs  > 0 ? c.intervalMs  : OBSERVE_DEFAULTS.intervalMs,
    settleReads: c.settleReads > 0 ? c.settleReads : OBSERVE_DEFAULTS.settleReads,
    // quiescent window only applies in adaptive mode; legacy stays immediate.
    quiescentMs: adaptive ? (c.quiescentMs != null ? c.quiescentMs : OBSERVE_DEFAULTS.quiescentMs) : 0,
  };
}

// High-fidelity input mode from config (agentControl.input.highFidelity).
// 'off' | 'fallback' | 'always'. Travels on the action so the SW (where
// chrome.debugger lives) can route click/type/press_key through CDP. Firefox
// ignores the field and stays synthetic.
function _inputMode(cb) {
  return cb._config?.agentControl?.input?.highFidelity || 'off';
}

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

  const observation = await _awaitSettled(navigator, tabId, broadcast, fromHash, maxWaitMs, _observeOpts(cb));
  return { ...result, _observation: observation };
}

/**
 * Poll the page state hash until it settles or the deadline passes, then
 * summarise the transition relative to `fromHash`.
 *
 * Adaptive mode (default): the first reads fire quickly (intervalsMs) so brief
 * SPA transitions aren't missed, then back off. "Settled" requires `settleReads`
 * consecutive equal reads AND at least `quiescentMs` of quiet since the last
 * change — so a fast A→B→A flip resets the window instead of falsely settling.
 *
 * Legacy mode (adaptive=false): fixed interval, immediate settle on N equal
 * reads — identical to the original behaviour.
 */
async function _awaitSettled(navigator, tabId, broadcast, fromHash, maxWaitMs, opts = OBSERVE_DEFAULTS) {
  const start = Date.now();

  let lastHash     = null;
  let stable       = 0;
  let latest       = null;
  let lastChangeAt = start;
  let reads        = 0;

  while (Date.now() - start < maxWaitMs) {
    let h = null;
    try {
      const r = await navigator.requestHash(tabId, broadcast, 1500);
      h = r?.compositeHash || null;
    } catch (_) {
      break; // hash channel unresponsive — stop polling
    }
    if (h == null) break;
    reads++;
    latest = h;

    if (h === lastHash) {
      stable++;
    } else {
      stable = 1;
      lastHash = h;
      lastChangeAt = Date.now();
    }

    const quiet = Date.now() - lastChangeAt >= opts.quiescentMs;
    if (stable >= opts.settleReads && quiet) break;

    const interval = opts.adaptive
      ? opts.intervalsMs[Math.min(reads - 1, opts.intervalsMs.length - 1)]
      : opts.intervalMs;
    const remaining = maxWaitMs - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(interval, remaining)));
  }

  if (latest == null) {
    return { available: false, reason: 'Page did not report a state hash (explorer/state graph may be inactive).' };
  }

  return {
    available: true,
    fromHash,
    toHash: latest,
    hashChanged: fromHash != null ? fromHash !== latest : null,
    settled: stable >= opts.settleReads,
    reads,
    mode: opts.adaptive ? 'adaptive' : 'fixed',
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
          dialog:   { type: 'object', description: 'How to auto-answer native dialogs this action triggers (they never block the page): { confirm: boolean (default true = OK), prompt: string|null (default null = Cancel) }. alert is always auto-dismissed. Any dialog that fires is returned in result.dialogs with its content, response, and causality (direct/indirect/none).' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      // Usage stats: learn which labels get clicked (best-effort; SoM ranking).
      if (cb._somStats && args.text) { try { cb._somStats.record(args.text); } catch (_) {} }
      return observeAction(cb, args.tabId, {
        type: 'click',
        selector: args.selector,
        text:     args.text,
        x:        args.x,
        y:        args.y,
        double:   args.double,
        button:   args.button,
        dialog:   args.dialog,
        inputMode: _inputMode(cb),
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
      description: 'Type text into a form element (input, textarea, or contenteditable/rich-text editor). Types character-by-character firing keydown/keypress/input/keyup for React/framework compatibility; contenteditable editors are driven via insertText. Optionally clears first and/or presses a submit key afterwards. You can also omit text and send only a submit key (e.g. submit="enter") to submit an already-filled field without loading the press_key profile.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:      { type: 'number', description: 'Tab ID' },
          text:       { type: 'string', description: 'Text to type. Optional — omit (or pass "") to only send the submit key.' },
          selector:   { type: 'string', description: 'CSS selector of target input (if absent, types into currently focused element)' },
          clear:      { type: 'boolean', description: 'Clear existing content before typing (default: false)' },
          submit:     { type: 'string', enum: ['none', 'enter', 'shift-enter', 'ctrl-enter', 'cmd-enter', 'auto'], description: 'Key to press after typing: enter (submit in most chats), shift-enter (newline), ctrl-enter/cmd-enter (submit in Slack/forms/editors), none (default), or auto (infer from enterkeyhint / native form / hint text). Best-effort: synthetic keys may be ignored by editors that require trusted events. With auto, the response includes submitInference {key, confidence, evidence}; key=null means it could not be inferred (no guess is made).' },
          onFail:     { type: 'string', enum: ['type-only', 'abort'], description: 'When submit="auto" cannot infer a key: type-only (default) types the text and skips submit; abort types nothing and returns. Defaults to agentControl.submitInference.onFail.' },
          pressEnter: { type: 'boolean', description: 'Legacy alias for submit="enter". Prefer submit (default: false).' },
          dialog:     { type: 'object', description: 'How to auto-answer native dialogs this action triggers (they never block the page): { confirm: boolean (default true), prompt: string|null }. alert is always auto-dismissed. Triggered dialogs are returned in result.dialogs with content and causality.' },
          timeoutMs:  { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      const onFail = args.onFail || cb._config?.agentControl?.submitInference?.onFail || 'type-only';
      return observeAction(cb, args.tabId, {
        type:         'type',
        text:         args.text,
        selector:     args.selector,
        clear:        args.clear,
        submit:       args.submit,
        submitOnFail: onFail,
        pressEnter:   args.pressEnter,
        dialog:       args.dialog,
        inputMode:    _inputMode(cb),
      }, args);
    },
  });

  // 22b. type_secret — inject a registered secret WITHOUT exposing it to the agent
  tools.push({
    definition: {
      name: 'type_secret',
      description: 'Type one of the user\'s pre-registered secrets into a field WITHOUT ever seeing the value. You pass a "ref" name (e.g. "user_password"), not the secret itself; the server resolves it from secrets.local.json and types the real value into the page. Requires privacy.secretGuard enabled with a secret that has a matching "ref". The value never appears in the tool result, logs, or cache. Use this instead of type_text whenever a password/token/email you should not handle must be entered.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID' },
          ref:      { type: 'string', description: 'Name of the registered secret — the "ref" field in secrets.local.json, e.g. "user_password". NOT the value.' },
          selector: { type: 'string', description: 'CSS selector of the target input (if absent, types into the focused element)' },
          clear:    { type: 'boolean', description: 'Clear existing content before typing (default: false)' },
          submit:   { type: 'string', enum: ['none', 'enter', 'shift-enter', 'ctrl-enter', 'cmd-enter'], description: 'Key to press after typing (default: none)' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000)' },
          ...OBSERVE_SCHEMA,
        },
        required: ['tabId', 'ref'],
      },
    },
    handler: async (args, cb) => {
      const guard = cb._secretGuard;
      if (!guard || !guard.active || typeof guard.resolveSecret !== 'function') {
        return { ok: false, error: 'Secret guard is not enabled. Set privacy.secretGuard.enabled=true and register a secret with a "ref" in secrets.local.json.' };
      }
      const value = guard.resolveSecret(args.ref);
      if (value == null) {
        return {
          ok: false,
          error: `No secret registered for ref "${args.ref}".`,
          availableRefs: (guard.listRefs && guard.listRefs()) || [],
        };
      }
      const result = await observeAction(cb, args.tabId, {
        type:         'type',
        text:         value,          // real value → page only; never returned to the agent
        selector:     args.selector,
        clear:        args.clear,
        submit:       args.submit,
        submitOnFail: 'type-only',
        inputMode:    _inputMode(cb),
        _sensitive:   true,
      }, args);
      // Never echo the value or the raw executor payload — only a safe status.
      const ok = result?.ok !== false;
      return { ok, ref: args.ref, typed: ok, _observation: result?._observation };
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
      return observeAction(cb, args.tabId, { type: 'press_key', key: args.key, inputMode: _inputMode(cb) }, args);
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

// Exposed for unit tests (not part of the public tool API).
module.exports._internals = { _awaitSettled, _observeOpts, OBSERVE_DEFAULTS };
