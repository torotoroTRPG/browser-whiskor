/**
 * server/mcp/tools/capture.js
 * CAPTUREカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

module.exports = function registerCaptureTools(registry) {
  const tools = [];

  // 32. capture_screenshot
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      if (!cb._captureScreenshot) return { error: 'Screenshot service not available (no browser connected).' };
      try {
        const opts = { marks: args.marks === true };
        const result = await cb._captureScreenshot(args.tabId, opts);
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
    },
  });

  // 33. refresh_data
  tools.push({
    definition: {
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
    handler: async (args, cb) => {
      if (!cb._triggerCollect) return { error: 'No browser connected.' };
      cb._triggerCollect(args.tabId, args.plugins || null);
      const waitMs = args.waitMs || 3000;
      await new Promise(r => setTimeout(r, waitMs));
      const session = cb.cache.getSessionList().find(s => s.tabId === args.tabId);
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
    },
  });

  registry.registerTools(tools);
};
