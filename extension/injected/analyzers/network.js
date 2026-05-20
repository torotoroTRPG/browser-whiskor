/**
 * analyzers/network.js  –  MAIN world, patches before page JS runs
 */
'use strict';
(function () {
  const registry = window.__SI_REGISTRY__;
  if (!registry) return;

  const TOKEN_PATTERNS = [
    { name: 'Bearer',  re: /^bearer\s+(.+)/i },
    { name: 'Basic',   re: /^basic\s+(.+)/i },
    { name: 'JWT',     re: /^(ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/ },
    { name: 'API-Key', re: /^(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,})$/ },
  ];

  function detectToken(key, value) {
    if (!value) return null;
    const lower = key.toLowerCase();
    if (['authorization', 'x-auth-token', 'x-api-key', 'x-access-token'].includes(lower)) {
      for (const p of TOKEN_PATTERNS) {
        const m = value.match(p.re);
        if (m) return { type: p.name, header: key, preview: value.slice(0, 20) + '…' };
      }
      return { type: 'Unknown', header: key, preview: value.slice(0, 20) + '…' };
    }
    return null;
  }

  function safeBody(text, maxLen) {
    if (typeof text !== 'string') return null;
    return text.slice(0, maxLen) || null;
  }

  registry.register({
    id: 'network-hook',
    name: 'Network Interceptor',
    version: '1.0.0',
    runAt: 'document_start',
    realtime: true,
    priority: 2,
    emitType: 'NETWORK_REQUEST',
    cacheTarget: 'network/',

    install(api) {
      const self = this;

      // ── Patch fetch ───────────────────────────────────────────────────────
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const cfg = api.getConfig().options?.network || {};
        const maxLen = cfg.bodyMaxLength || 500;
        const input  = args[0];
        const init   = args[1] || {};
        const url    = (typeof input === 'string' ? input : input?.url) || '';
        const method = (init.method || 'GET').toUpperCase();

        // Extract tokens from request headers
        const tokens = [];
        const headers = {};
        const rawHeaders = init.headers || {};
        const iter = rawHeaders instanceof Headers
          ? rawHeaders.entries()
          : Object.entries(rawHeaders);
        for (const [k, v] of iter) {
          headers[k] = v;
          const t = detectToken(k, v);
          if (t) tokens.push(t);
        }

        const reqId = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

        api.emit('NETWORK_REQUEST', {
          reqId, url, method, headers,
          bodyPreview: cfg.captureBody ? safeBody(typeof init.body === 'string' ? init.body : null, maxLen) : null,
          ts: Date.now(), tokens,
        }, true);

        try {
          const response = await origFetch.apply(this, args);
          const clone    = response.clone();
          const resHeaders = {};
          clone.headers.forEach((v, k) => resHeaders[k] = v);

          let bodyPreview = null;
          if (cfg.captureBody) {
            try {
              const ct = resHeaders['content-type'] || '';
              if (ct.includes('text') || ct.includes('json') || ct.includes('xml')) {
                const text = await clone.text();
                bodyPreview = safeBody(text, maxLen);
              }
            } catch (_) {}
          }

          api.emit('NETWORK_RESPONSE', {
            reqId, url, status: response.status,
            headers: resHeaders, bodyPreview, ts: Date.now(),
          }, true);

          return response;
        } catch (err) {
          api.emit('NETWORK_ERROR', { reqId, url, error: err.message, ts: Date.now() }, true);
          throw err;
        }
      };

      // ── Patch XMLHttpRequest ───────────────────────────────────────────────
      const OrigXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = function () {
        const xhr    = new OrigXHR();
        const meta   = { url: '', method: 'GET', headers: {}, tokens: [] };
        const cfg    = () => api.getConfig().options?.network || {};
        const reqId  = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

        const origOpen = xhr.open.bind(xhr);
        xhr.open = function (method, url, ...rest) {
          meta.method = method; meta.url = url;
          return origOpen(method, url, ...rest);
        };

        const origSend = xhr.send.bind(xhr);
        xhr.send = function (body) {
          api.emit('NETWORK_REQUEST', {
            reqId, url: meta.url, method: meta.method,
            headers: meta.headers, tokens: meta.tokens,
            bodyPreview: cfg().captureBody ? safeBody(typeof body === 'string' ? body : null, cfg().bodyMaxLength || 500) : null,
            ts: Date.now(),
          }, true);
          return origSend(body);
        };

        const origSetHeader = xhr.setRequestHeader.bind(xhr);
        xhr.setRequestHeader = function (k, v) {
          meta.headers[k] = v;
          const t = detectToken(k, v);
          if (t) meta.tokens.push(t);
          return origSetHeader(k, v);
        };

        xhr.addEventListener('load', function () {
          const maxLen = cfg().bodyMaxLength || 500;
          let bodyPreview = null;
          if (cfg().captureBody && xhr.responseType === '') {
            bodyPreview = safeBody(xhr.responseText, maxLen);
          }
          const resHeaders = {};
          (xhr.getAllResponseHeaders() || '').split('\r\n').forEach(line => {
            const idx = line.indexOf(':');
            if (idx > 0) resHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          });
          api.emit('NETWORK_RESPONSE', {
            reqId, url: meta.url, status: xhr.status,
            headers: resHeaders, bodyPreview, ts: Date.now(),
          }, true);
        });

        xhr.addEventListener('error', function () {
          api.emit('NETWORK_ERROR', { reqId, url: meta.url, error: 'XHR error', ts: Date.now() }, true);
        });

        return xhr;
      };
      // Copy static properties
      Object.setPrototypeOf(window.XMLHttpRequest, OrigXHR);
      Object.defineProperty(window.XMLHttpRequest, 'prototype', {
        value: OrigXHR.prototype, writable: true,
      });

      // ── sendBeacon patch ──────────────────────────────────────────────────
      if (navigator.sendBeacon) {
        const origBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
          api.emit('NETWORK_REQUEST', {
            reqId: `beacon-${Date.now()}`, url, method: 'BEACON',
            headers: {}, tokens: [],
            bodyPreview: data ? String(data).slice(0, 200) : null,
            ts: Date.now(),
          }, true);
          return origBeacon(url, data);
        };
      }
    },

    collect(api) { return null; }, // realtime only; no snapshot collect needed
  });
})();
