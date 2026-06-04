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
      description: 'Capture a screenshot of the visible tab area. The image is always saved to disk (filePath is returned) and viewable on the dashboard. By default the image is NOT returned, to save tokens (configurable via agentControl.screenshot.returnImageByDefault) — set returnImage=true to include it. When returned, it comes back as a viewable image block (not base64 text), encoded per the configured format/quality and downscaled to maxWidth. Use marks=true to overlay numbered markers on interactive elements (Set-of-Marks approach) — the response includes an elements map so you can reference elements by number instead of coordinates.',
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
          const b64 = (result.dataUrl || '').split(',')[1] || '';
          const mimeMatch = /^data:(image\/\w+);base64,/.exec(result.dataUrl || '');
          // base64 は MCP の image ブロックとして返す（transport が変換）。
          // JSON(text) には埋め込まない — トークン浪費＆非視覚化を避けるため。
          response._mcpImage = { data: b64, mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg' };
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

  // 32b. capture_packed_som
  tools.push({
    definition: {
      name: 'capture_packed_som',
      description: 'Capture a COMPACT Set-of-Marks image of just the interactive elements (buttons, links, inputs), each cropped from the real page and packed tightly together with a number. Far smaller than a full screenshot while keeping a visual of every actionable element. The response is a viewable image plus a "marks" map; to act on a mark, click its selector (or its rect center) with the click tool. Best for point-and-click flows; not for drag/gesture interactions.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          max:   { type: 'number', description: 'Max elements to include (default 40, capped by what fits).' },
          types: { type: 'array', items: { type: 'string', enum: ['button', 'link', 'input'] }, description: 'Restrict to these element kinds (default: all interactive).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._capturePackedSom) return { error: 'Packed SoM capture not available (no browser connected).' };
      try {
        const opts = {
          max:   typeof args.max === 'number' ? args.max : 40,
          types: Array.isArray(args.types) ? args.types : null,
        };
        const result = await cb._capturePackedSom(args.tabId, opts);
        if (!result.ok) return { ok: false, error: result.error, ...(result.tabGone ? { tabGone: true, liveTabs: result.liveTabs } : {}) };

        const marks = (result.marks || []).map((m) => ({ n: m.n, text: m.text, selector: m.selector, rect: m.rect }));

        // Usage-stats bias: annotate each mark with a likelihood score and list
        // the likely targets first. The image numbers (n) are unchanged — only
        // the marks array order changes — so it never hides or relabels anything.
        let ordered = false;
        if (cb._somStats && typeof cb._somStats.rank === 'function') {
          try {
            const ranked = cb._somStats.rank(marks.map((m) => m.text));
            const scoreByText = new Map(ranked.map((r) => [r.text, r.score]));
            for (const m of marks) m.score = scoreByText.get(m.text) || 0;
            marks.sort((a, b) => (b.score - a.score) || (a.n - b.n));
            ordered = marks.some((m) => m.score > 0);
          } catch (_) { /* stats are best-effort */ }
        }

        const response = {
          ok: true,
          filePath: result.filePath,
          count: marks.length,
          marks,
          _note: 'Each mark is an interactive element cropped from the page (the number n matches the badge in the image). To act on one, click its selector (or its rect center) with the click tool.'
            + (ordered ? ' Marks are ordered by likely relevance (score) from past usage; the image numbering is unchanged.' : ''),
        };
        const b64 = (result.dataUrl || '').split(',')[1] || '';
        const mimeMatch = /^data:(image\/\w+);base64,/.exec(result.dataUrl || '');
        if (b64) response._mcpImage = { data: b64, mimeType: mimeMatch ? mimeMatch[1] : 'image/png' };
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
