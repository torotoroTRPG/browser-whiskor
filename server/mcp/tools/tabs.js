/**
 * server/mcp/tools/tabs.js
 * Browser tab lifecycle tools: list / switch / open / close.
 *
 * These operate on the browser's tab set via the extension background layer
 * (chrome.tabs.* / browser.tabs.*). Unlike most write tools they are not scoped
 * to a single instrumented tab — list_tabs enumerates every open tab (including
 * tabs whiskor has never collected from), and open/switch/close target tabs by
 * id. They flow through the same action executor channel as other write tools.
 */
'use strict';

module.exports = function registerTabTools(registry) {
  const tools = [];

  // list_tabs
  tools.push({
    definition: {
      name: 'list_tabs',
      description: 'List all open browser tabs (across every window), including tabs whiskor has not instrumented. Returns tabId, url, title, window, active state and load status. Use this to discover popups, auth redirects, or other tabs before switching to them. Complements get_sessions, which only lists whiskor-active tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          currentWindowOnly: { type: 'boolean', description: 'Only list tabs in the currently focused window (default: false — list all windows).' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._callAction) return { ok: false, error: 'No browser connected.' };
      const result = await cb._callAction(null, {
        type: 'list_tabs',
        currentWindowOnly: args.currentWindowOnly === true,
      }, args.timeoutMs);
      // _callAction wraps the extension payload in { ok, result }.
      const payload = result?.result || result;
      if (result && result.ok === false) return result;
      return { ok: true, tabs: payload?.tabs || [], count: (payload?.tabs || []).length };
    },
  });

  // switch_tab
  tools.push({
    definition: {
      name: 'switch_tab',
      description: 'Activate (focus) a tab by its tabId and bring its window to the foreground. Use after list_tabs to move attention to a popup, auth window, or background tab. Does not navigate — only changes which tab is active.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID to activate (from list_tabs or get_sessions).' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._callAction) return { ok: false, error: 'No browser connected.' };
      const result = await cb._callAction(args.tabId, {
        type: 'switch_tab',
        targetTabId: args.tabId,
      }, args.timeoutMs);
      return result?.result || result;
    },
  });

  // open_tab
  tools.push({
    definition: {
      name: 'open_tab',
      description: 'Open a new browser tab. Optionally navigate it to a URL and choose whether it becomes the active tab. Returns the new tabId. Note: a freshly opened tab has no collected data yet — call refresh_data (or wait for collection) before reading from it.',
      inputSchema: {
        type: 'object',
        properties: {
          url:       { type: 'string', description: 'URL to open (must include protocol). Omit for a blank tab.' },
          active:    { type: 'boolean', description: 'Make the new tab the active/focused tab (default: true).' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000).' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._callAction) return { ok: false, error: 'No browser connected.' };
      const result = await cb._callAction(null, {
        type: 'open_tab',
        url: args.url,
        active: args.active !== false,
      }, args.timeoutMs);
      return result?.result || result;
    },
  });

  // close_tab
  tools.push({
    definition: {
      name: 'close_tab',
      description: 'Close a browser tab by its tabId. Use to dismiss popups or clean up after a multi-tab flow. The associated whiskor session (if any) is cleaned up by the server on tab removal.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:     { type: 'number', description: 'Tab ID to close.' },
          timeoutMs: { type: 'number', description: 'Action timeout in milliseconds (default: 15000).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._callAction) return { ok: false, error: 'No browser connected.' };
      const result = await cb._callAction(args.tabId, {
        type: 'close_tab',
        targetTabId: args.tabId,
      }, args.timeoutMs);
      return result?.result || result;
    },
  });

  registry.registerTools(tools);
};
