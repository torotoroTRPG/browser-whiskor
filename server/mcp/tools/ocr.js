/**
 * server/mcp/tools/ocr.js
 *
 * ocr_region — read text from pixels via a native OCR engine.
 *
 * Complements get_text_coords (DOM-based): use this when text lives only in pixels
 * — canvas/WebGL apps (Unity, games, charts) where the DOM is one <canvas>, or
 * icon-only controls with no text node. The output schema matches text-coords'
 * Tesseract-compatible word boxes, so results slot into the same workflow.
 *
 * The capture+recognize work runs worker-side via the _ocrRegion callback (so it
 * behaves identically over MCP stdio, HTTP, and the proxy forward). With no
 * selector/rect it OCRs the full visible tab; with a selector or rect it OCRs just
 * that cropped element.
 */
'use strict';

module.exports = function registerOcrTools(registry) {
  const tools = [];

  tools.push({
    definition: {
      name: 'ocr_region',
      description: [
        'Read text from the rendered pixels of a tab using a native OCR engine.',
        'Use this when get_text_coords returns nothing because the text is not in the DOM:',
        'canvas/WebGL apps (Unity, games, charts) or icon-only buttons with no text node.',
        'Omit selector/rect to OCR the whole visible tab; pass a selector or rect to OCR just that region (smaller + more accurate).',
        'Returns recognized text plus word boxes in the same Tesseract-compatible schema as get_text_coords (level/page_num/block_num/.../x/y/w/h/confidence).',
        'Coordinates are in the captured image\'s pixel space. Requires a local OCR binary (Tesseract); if none is installed the call returns ocr_unavailable with setup steps.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          tabId:    { type: 'number', description: 'Tab ID from get_sessions' },
          selector: { type: 'string', description: 'CSS selector to OCR a single element (cropped). Takes priority over rect.' },
          rect:     {
            type: 'object',
            description: 'Bounding rect in CSS px to OCR (from get_ui_catalog / get_viewport). Omit selector and rect to OCR the whole visible tab.',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
            required: ['x', 'y', 'w', 'h'],
          },
          lang:     { type: 'string', description: "OCR language(s), Tesseract codes (default from config, usually 'eng'). Combine with '+', e.g. 'eng+jpn'. The language data must be installed in the engine." },
          psm:      { type: 'number', description: 'Tesseract page segmentation mode (default 3 = auto). Try 6 (uniform block), 7 (single line), 8 (single word), or 11 (sparse text) for small/odd regions.' },
          padding:  { type: 'number', description: 'Extra px around a selector/rect crop before OCR (default 4).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._ocrRegion) return { error: 'OCR not available (no browser connected).' };
      try {
        const result = await cb._ocrRegion({
          tabId:    args.tabId,
          selector: args.selector,
          rect:     args.rect,
          lang:     args.lang,
          psm:      args.psm,
          padding:  args.padding,
        });
        if (!result || !result.ok) {
          if (result && result.error === 'ocr_unavailable') {
            return {
              ok: false,
              error: 'ocr_unavailable',
              _note: result.hint || 'No OCR engine found. Install Tesseract and put it on PATH, set WHISKOR_OCR_PATH, or set intelligence.ocr.binPath in config.json.',
            };
          }
          return {
            ok: false,
            error: result && result.error,
            ...(result && result.detail ? { detail: result.detail } : {}),
            ...(result && result.tabGone ? { tabGone: true, liveTabs: result.liveTabs } : {}),
          };
        }
        const empty = !result.words || result.words.length === 0;
        return {
          ok: true,
          text: result.text,
          words: result.words,
          wordCount: result.wordCount,
          rect: result.rect || null,
          lang: result.lang,
          engine: result.engine,
          _note: empty
            ? 'OCR found no text in the region. Try a different psm (6/7/8/11), a larger region, or a language that matches the content (lang).'
            : 'Text read from pixels via OCR. Boxes are in image pixel space; fields match get_text_coords (Tesseract-compatible).',
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  });

  registry.registerTools(tools);
};
