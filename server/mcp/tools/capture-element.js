/**
 * server/mcp/tools/capture-element.js
 *
 * capture_element_screenshot — 要素単位スクリーンショット MCPツール
 *
 * agent が get_ui_catalog や get_text_coords で要素の rect や selector を
 * 取得済みの場合、その情報をそのまま渡すだけで最小サイズのスクリーンショットが得られる。
 *
 * 例1: selector 指定
 *   { tabId: 1, selector: "#add-to-cart" }
 *
 * 例2: rect 直接指定（ui_catalog の rect をそのまま渡す）
 *   { tabId: 1, rect: { x: 120, y: 340, w: 200, h: 48 } }
 *
 * 例3: 全体を取りたいとき
 *   { tabId: 1, selector: "body" }
 */
'use strict';

module.exports = function registerElementCaptureTools(registry) {
  const tools = [];

  tools.push({
    definition: {
      name: 'capture_element_screenshot',
      description: [
        'Capture a screenshot cropped to a specific DOM element or bounding rect.',
        'Far smaller than a full screenshot — ideal for inspecting individual UI components.',
        'Supply either `selector` (CSS selector) or `rect` (x/y/w/h in CSS px).',
        'When returnImage is on, the cropped image is returned as a viewable image block (not base64 text) alongside the resolved rect.',
        'Tip: pass selector="body" or selector=":root" to capture the full page without marks overhead.',
        'Tip: rect values from get_ui_catalog and get_text_coords can be passed directly.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type:        'number',
            description: 'Tab ID from get_sessions',
          },
          selector: {
            type:        'string',
            description: 'CSS selector of the element to capture. Takes priority over rect.',
          },
          rect: {
            type:        'object',
            description: 'Bounding rect in CSS px. Use values from get_ui_catalog or get_text_coords.',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          padding: {
            type:        'number',
            description: 'Extra pixels around the element (default: 4)',
          },
          format: {
            type:        'string',
            enum:        ['png', 'jpeg'],
            description: "Image format (default: 'png'). Use 'jpeg' for large elements to reduce size.",
          },
          quality: {
            type:        'number',
            description: 'JPEG quality 1-100 (default: 85, ignored for PNG)',
          },
          returnImage: {
            type:        'boolean',
            description: 'Include base64 dataUrl in response (default: true). Set false to only get metadata.',
          },
        },
        required: ['tabId'],
      },
    },

    handler: async (args, cb) => {
      if (!cb._captureElement && !cb._captureScreenshot) {
        return { error: 'Screenshot service not available (no browser connected).' };
      }

      if (!args.selector && !args.rect) {
        return { error: 'Provide either selector or rect.' };
      }

      const opts = {
        selector: args.selector || undefined,
        rect:     args.rect     || undefined,
        padding:  typeof args.padding  === 'number' ? args.padding  : 4,
        format:   args.format  || 'png',
        quality:  typeof args.quality  === 'number' ? args.quality  : 85,
      };

      try {
        let result;
        if (cb._captureElement) {
          result = await cb._captureElement(args.tabId, opts);
        } else {
          result = await captureAndCropFallback(args.tabId, opts, cb);
        }

        if (!result.ok) return { ok: false, error: result.error, ...(result.tabGone ? { tabGone: true, liveTabs: result.liveTabs } : {}) };

        const response = {
          ok:         true,
          capturedAt: result.capturedAt,
          rect:       result.rect,
          padding:    opts.padding,
        };

        if (result.rect) {
          response._note = `${result.rect.w}×${result.rect.h}px element (padding: ${opts.padding}px)`;
        }

        if (args.returnImage !== false && result.dataUrl) {
          const b64 = result.dataUrl.split(',')[1] || '';
          const mimeMatch = /^data:(image\/\w+);base64,/.exec(result.dataUrl);
          // base64 は MCP の image ブロックとして返す（transport が変換）。
          response._mcpImage = { data: b64, mimeType: mimeMatch ? mimeMatch[1] : 'image/png' };
          response.sizeBytes = Math.round(b64.length * 0.75);
        }

        return response;

      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  });

  // get_element_thumbnail — cache-backed single-element crop (T2 / packed-SoM
  // slice 2). Same input as capture_element_screenshot, but a repeat reference to
  // an unchanged element is served from a worker-side view-aware cache (no
  // re-capture), so the agent can cheaply re-look at or prefetch one element.
  tools.push({
    definition: {
      name: 'get_element_thumbnail',
      description: [
        'Get a cropped image of one element, served from a per-element cache when the page has not changed since.',
        'Cheaper than capture_element_screenshot for repeat looks at the same element, and lets you reference elements one at a time.',
        'Supply `selector` (preferred) or `rect` (x/y/w/h in CSS px). The image returns as a viewable block; `_cached` says whether it came from cache.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID from get_sessions' },
          selector: { type: 'string', description: 'CSS selector of the element (preferred — stable cache key).' },
          rect:     {
            type: 'object', description: 'Bounding rect in CSS px (from get_ui_catalog / get_text_coords).',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
            required: ['x', 'y', 'w', 'h'],
          },
          padding:  { type: 'number', description: 'Extra pixels around the element (default: 4)' },
          maxPx:    { type: 'number', description: 'Cap the thumbnail\'s longer side in px (default: 96). The extension downscales the crop to this.' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._captureElementThumbnail) return { error: 'Element thumbnail capture not available (no browser connected).' };
      if (!args.selector && !args.rect) return { error: 'Provide either selector or rect.' };
      const opts = {
        selector: args.selector || undefined,
        rect:     args.rect     || undefined,
        padding:  typeof args.padding === 'number' ? args.padding : 4,
        maxPx:    typeof args.maxPx   === 'number' ? args.maxPx   : 96, // low-res thumbnail
        format:   'jpeg', quality: 60, // a thumbnail — keep it small
      };
      try {
        const result = await cb._captureElementThumbnail(args.tabId, opts);
        if (!result || !result.ok) return { ok: false, error: result && result.error, ...(result && result.tabGone ? { tabGone: true, liveTabs: result.liveTabs } : {}) };
        const response = {
          ok: true, rect: result.rect, capturedAt: result.capturedAt, _cached: !!result._cached,
          _note: (result._cached ? 'Reused a cached thumbnail (page unchanged since). ' : '')
            + (result.rect ? `${result.rect.w}×${result.rect.h}px element.` : ''),
        };
        const b64 = (result.dataUrl || '').split(',')[1] || '';
        const mimeMatch = /^data:(image\/\w+);base64,/.exec(result.dataUrl || '');
        if (b64) response._mcpImage = { data: b64, mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg' };
        return response;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  });

  registry.registerTools(tools);
};

async function captureAndCropFallback(tabId, opts, cb) {
  const full = await cb._captureScreenshot(tabId, { marks: false });
  if (!full.ok) return full;

  if (!opts.rect) {
    return {
      ok:         true,
      dataUrl:    full.dataUrl,
      rect:       null,
      capturedAt: full.capturedAt,
      _note:      'SW patch not applied; returning full screenshot. Apply sw-element-capture.patch.js for element crops.',
    };
  }

  return {
    ok:         true,
    dataUrl:    full.dataUrl,
    rect:       opts.rect,
    capturedAt: full.capturedAt,
    _note:      'SW patch not applied; full screenshot returned. Crop using rect client-side.',
  };
}
