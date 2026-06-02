/**
 * server/mcp/tools/capture.js
 * CAPTUREカテゴリのMCPツール定義とハンドラ。
 */
'use strict';

const embedService = require('../../services/embed-service');

module.exports = function registerCaptureTools(registry) {
  const tools = [];

  // 32. capture_screenshot
  tools.push({
    definition: {
      name: 'capture_screenshot',
      description: 'Capture a screenshot of the visible tab area. The image is always saved to disk (filePath is returned) and viewable on the dashboard. By default the base64 image is NOT inlined in the response to save tokens (configurable via agentControl.screenshot.returnImageByDefault) — set returnImage=true to include it. When returned, the image is encoded per the configured format/quality and downscaled to maxWidth. Use marks=true to overlay numbered markers on interactive elements (Set-of-Marks approach) — the response includes an elements map so you can reference elements by number instead of coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:       { type: 'number', description: 'Tab ID to screenshot' },
          returnImage: { type: 'boolean', description: 'Include base64 image data in response. Defaults to agentControl.screenshot.returnImageByDefault (false unless configured). filePath is always returned regardless.' },
          format:      { type: 'string', enum: ['png', 'jpeg'], description: 'Image format override (default from config, typically jpeg for smaller payloads).' },
          quality:     { type: 'number', description: 'JPEG quality 1-100 override (default from config, ignored for png).' },
          maxWidth:    { type: 'number', description: 'Downscale so the image is at most this many CSS px wide (default from config; 0 disables).' },
          marks:       { type: 'boolean', description: 'Overlay numbered markers on interactive elements. Returns {elements: {1: {text, selector, x, y}, ...}} for Set-of-Marks interaction. Requires screenshotMarks=true in config.' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._captureScreenshot) return { error: 'Screenshot service not available (no browser connected).' };
      try {
        const sc = (cb._config && cb._config.agentControl && cb._config.agentControl.screenshot) || {};
        const wantImage = args.returnImage != null ? args.returnImage !== false : sc.returnImageByDefault === true;
        const opts = {
          marks:    args.marks === true,
          format:   args.format || sc.format || 'jpeg',
          quality:  typeof args.quality  === 'number' ? args.quality  : (typeof sc.quality  === 'number' ? sc.quality  : 70),
          maxWidth: typeof args.maxWidth === 'number' ? args.maxWidth : (typeof sc.maxWidth === 'number' ? sc.maxWidth : 0),
        };
        const result = await cb._captureScreenshot(args.tabId, opts);
        if (!result.ok) return { ok: false, error: result.error, ...(result.tabGone ? { tabGone: true, liveTabs: result.liveTabs } : {}) };
        const response = {
          ok: true,
          capturedAt:  result.capturedAt,
          filePath:    result.filePath,
          width:       result.width,
          height:      result.height,
        };
        if (wantImage) {
          response.dataUrl = result.dataUrl;
          const b64 = (result.dataUrl || '').split(',')[1] || '';
          response.sizeBytes = Math.round(b64.length * 0.75);
        } else {
          response._note = 'Image saved to disk (filePath). base64 omitted to save tokens — pass returnImage:true to include it.';
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
      const session = (await cb.cache.getSessionList()).find(s => s.tabId === args.tabId);
      if (!session) return { ok: false, error: 'Session not found after refresh.' };

      // Trigger async embedding calculation for caching
      let embedStatus = embedService.getEmbedStatus();
      if (embedStatus === 'ready' || embedStatus === 'pending') {
        const raw = await cb.cache.readSessionFile(args.tabId, 'raw/visual/text-coords.json');
        if (raw) {
          const allItems = [...(raw.words || []), ...(raw.lines || []), ...(raw.blocks || [])];
          // We don't await this, it runs in the background
          embedService.embedForCache(allItems, args._sessionId).catch(console.error);
          embedStatus = embedService.getEmbedStatus(); // Get updated status (likely 'pending')
        }
      }

      return {
        ok: true,
        waitedMs: waitMs,
        embedStatus,
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
  // Element-level capture tool
  require('./capture-element')(registry);
};
