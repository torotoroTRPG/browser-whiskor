/**
 * sw-element-capture.patch.js
 *
 * browser-whiskor – 要素単位スクリーンショット機能
 *
 * sw.js の CAPTURE_SCREENSHOT ケースの直後に追加するコードブロック。
 *
 * ─── sw.js への追加方法 ────────────────────────────────────────────────────
 *
 * 1. cropImage() 関数をトップレベルに追加（drawMarksOnImage の直後）
 * 2. switch(msg.type) の 'CAPTURE_SCREENSHOT' case 直後に 'CAPTURE_ELEMENT' case を追加
 *
 * ─── フロー ────────────────────────────────────────────────────────────────
 *
 * 1. サーバーが CAPTURE_ELEMENT { reqId, tabId, opts } を broadcast
 * 2. SW が executeScript でブラウザ側から rect を取得 (getBoundingClientRect)
 * 3. captureVisibleTab でフルスクリーンショット
 * 4. OffscreenCanvas でクロップ
 * 5. ELEMENT_CAPTURE_RESULT を sendToServer
 *
 * 座標系:
 *   getBoundingClientRect → viewport相対 (scrollOffset なし)
 *   captureVisibleTab     → 現在の viewport を PNG化
 *   → そのままクロップできる。スクロールオフセット不要。
 *
 *   devicePixelRatio > 1 (Retina) の場合、PNG の実ピクセルは CSS px * dpr になる。
 *   screen.width / image width から dpr を推定してクロップ座標をスケールする。
 */

/* cropImage() — drawMarksOnImage の直下に追加
async function cropImage(dataUrl, rect, padding, format, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const imgW = img.width;
        const imgH = img.height;
        const viewW = window.innerWidth || document.documentElement.clientWidth || 1920;
        const dpr = Math.round((imgW / viewW) * 10) / 10 || 1;

        const sx = Math.max(0, Math.round((rect.x - padding) * dpr));
        const sy = Math.max(0, Math.round((rect.y - padding) * dpr));
        const sw = Math.min(imgW - sx, Math.round((rect.w + padding * 2) * dpr));
        const sh = Math.min(imgH - sy, Math.round((rect.h + padding * 2) * dpr));

        if (sw <= 0 || sh <= 0) {
          reject(new Error('Crop region is outside the visible viewport'));
          return;
        }

        const canvas = new OffscreenCanvas(sw, sh);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const blobOpts = format === 'jpeg'
          ? { type: mimeType, quality: (quality ?? 85) / 100 }
          : { type: mimeType };

        canvas.convertToBlob(blobOpts).then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror   = () => reject(new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        }).catch(reject);

      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Failed to load screenshot for crop'));
    img.src = dataUrl;
  });
}
*/

/* CAPTURE_ELEMENT case — switch(msg.type) の 'CAPTURE_SCREENSHOT' 直後に追加
case 'CAPTURE_ELEMENT': {
  const { reqId, tabId, opts = {} } = msg;

  try {
    const tab = await chrome.tabs.get(tabId);
    let rect = null;

    if (opts.selector) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        },
        args: [opts.selector],
      });
      rect = results?.[0]?.result || null;
      if (!rect) {
        sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
          error: 'selector not found: ' + opts.selector });
        break;
      }
    } else if (opts.rect) {
      rect = opts.rect;
    } else {
      sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId,
        error: 'CAPTURE_ELEMENT requires opts.selector or opts.rect' });
      break;
    }

    const pad = typeof opts.padding === 'number' ? Math.max(0, opts.padding) : 4;
    const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
    const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
      quality: format === 'jpeg' ? (opts.quality ?? 85) : undefined,
    });

    const croppedDataUrl = await cropImage(fullDataUrl, rect, pad, format, opts.quality);

    sendToServer({
      type:       'ELEMENT_CAPTURE_RESULT',
      reqId,
      dataUrl:    croppedDataUrl,
      rect,
      padding:    pad,
      capturedAt: Date.now(),
    });

  } catch (e) {
    sendToServer({ type: 'ELEMENT_CAPTURE_RESULT', reqId, error: e.message });
  }
  break;
}
*/

/**
 * ─── server/screenshot-manager.js への追加 ─────────────────────────────────
 *
 * function captureElement(tabId, opts = {}) {
 *   return new Promise((resolve, reject) => {
 *     const reqId = randomUUID();
 *     const timer = setTimeout(() => {
 *       pending.delete(reqId);
 *       reject(new Error('Element capture timed out for tabId=' + tabId));
 *     }, TIMEOUT_MS);
 *     pending.set(reqId, { resolve, reject, timer, tabId, isElement: true });
 *     _broadcast({ type: 'CAPTURE_ELEMENT', reqId, tabId, opts });
 *   });
 * }
 *
 * handleResult() に ELEMENT_CAPTURE_RESULT 分岐を追加
 */

/**
 * ─── server/index.js WebSocket ハンドラへの追加 ────────────────────────────
 *
 * case 'ELEMENT_CAPTURE_RESULT':
 *   screenshots.handleResult(msg);
 *   break;
 */
