/**
 * panel/panel.js
 * Full DevTools panel logic: port connection, tab switching, data rendering.
 */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  requests:  [],
  tokens:    [],
  endpoints: new Set(),
  textData:  null,
  reactData: null,
  vueData:   null,
  angularData: null,
  cssData:   null,
  uiData:    null,
  fwData:    null,
  genericData: null,
  lcp:       null,
};

// ── Port ──────────────────────────────────────────────────────────────────
const tabId = chrome.devtools.inspectedWindow.tabId;
const port  = chrome.runtime.connect({ name: `devtools-${tabId}` });

port.onMessage.addListener(handleMessage);
port.onDisconnect.addListener(() => setConnected(false));

function handleMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'SERVER_STATUS':   setConnected(msg.connected); break;
    case 'REACT_SNAPSHOT':  onReact(msg.payload);  break;
    case 'VUE3_SNAPSHOT':   onVue(msg.payload, 'vue3'); break;
    case 'VUE2_SNAPSHOT':   onVue(msg.payload, 'vue2'); break;
    case 'ANGULAR_SNAPSHOT':onAngular(msg.payload); break;
    case 'SVELTE_SNAPSHOT':
    case 'ALPINE_SNAPSHOT':
    case 'PREACT_SNAPSHOT':
    case 'SOLID_SNAPSHOT':  onOtherFw(msg.type, msg.payload); break;
    case 'DOM_GENERIC_SNAPSHOT': onGeneric(msg.payload); break;
    case 'NETWORK_REQUEST': onNetRequest(msg.payload); break;
    case 'NETWORK_RESPONSE':onNetResponse(msg.payload); break;
    case 'TEXT_COORDS':     onTextCoords(msg.payload); break;
    case 'CSS_ANALYSIS':    onCss(msg.payload); break;
    case 'UI_CATALOG':      onUi(msg.payload); break;
    case 'FRAMEWORK_DETECTION': onFrameworks(msg.payload); break;
    case 'PERF_LCP':        onLcp(msg.payload); break;
    case 'SOURCE_CATALOG':  onSources(msg.payload); break;
    case 'SESSION_UPDATE':  onSession(msg); break;
    // ── CSS Origin Level 1 bridge ──────────────────────────────────────────
    case 'CSS_ORIGIN_RESOURCE_REQUEST': onCssOriginResourceRequest(msg); return; // skip addToStream
    case 'SOURCE_CAPTURE_REQUEST':      onSourceCaptureRequest(msg); return;     // skip addToStream
  }
  addToStream(msg);
}

// ── CSS Origin Level 1: getResources() handler ────────────────────────────
// SW sends this when css-origin.js (MAIN world) requests DevTools resources.
// Only DevTools page scripts have access to chrome.devtools.inspectedWindow.
function onCssOriginResourceRequest(msg) {
  const { reqId, tabId } = msg;
  if (!chrome.devtools?.inspectedWindow?.getResources) {
    // Fallback: no getResources API
    chrome.runtime.sendMessage({ type: 'CSS_ORIGIN_RESOURCE_RESPONSE', reqId, tabId, resources: [] });
    return;
  }
  chrome.devtools.inspectedWindow.getResources((resources) => {
    const cssItems = (resources || []).filter(r => r.type === 'stylesheet');
    if (cssItems.length === 0) {
      chrome.runtime.sendMessage({ type: 'CSS_ORIGIN_RESOURCE_RESPONSE', reqId, tabId, resources: [] });
      return;
    }
    let pending = cssItems.length;
    const result = [];
    cssItems.forEach((r) => {
      r.getContent((content, encoding) => {
        if (encoding !== 'base64') {
          // Extract /*# sourceMappingURL=... */ comment
          const smMatch = (content || '').match(/\/\*#\s*sourceMappingURL=([^\s*]+)\s*\*\//);
          result.push({
            href: r.url,
            content: content || null,
            sourceMapURL: smMatch ? smMatch[1] : null,
          });
        }
        if (--pending === 0) {
          chrome.runtime.sendMessage({ type: 'CSS_ORIGIN_RESOURCE_RESPONSE', reqId, tabId, resources: result });
        }
      });
    });
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    document.getElementById(`tab-${id}`)?.classList.add('active');
  });
});

// ── Controls ──────────────────────────────────────────────────────────────
document.getElementById('btn-clear').addEventListener('click', () => {
  state.requests = []; state.tokens = []; state.endpoints.clear();
  ['net-requests','net-tokens','net-endpoints','stream-list',
   'text-words','text-lines','text-full'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="empty">Cleared</span>';
  });
  document.getElementById('badge-net').textContent = '0';
  document.getElementById('badge-text').textContent = '0';
  document.getElementById('req-count').textContent = '';
});

document.getElementById('btn-collect').addEventListener('click', () => {
  port.postMessage({ type: 'MANUAL_COLLECT', plugins: null });
});

document.getElementById('mode-select').addEventListener('change', (e) => {
  port.postMessage({ type: 'SET_CONFIG', config: { mode: e.target.value } });
});

document.getElementById('btn-export').addEventListener('click', () => {
  window.open('http://localhost:7892/export', '_blank');
});

// ── Source capture (DevTools getResources → server) ───────────────────────
// getResources() reads from the browser's resource cache, so it bypasses the
// CORS limits that block the page-context fetch() in source-fetcher.js. We
// capture text resources and emit them as SOURCE_CONTENT (the same shape Layer
// 1 uses), so the server stores them under raw/sources/content/ via the
// existing pipeline. DevTools must be open on the inspected tab for this.
const CAPTURE_MAX_BYTES = 10 * 1024 * 1024; // safety valve; larger → hash-only
const MAX_NET_FILES = 200;                  // cap network bodies per capture (WS transfer guard)

// Same hash as Layer 1 (source-fetcher.js hashContent) so identical content
// dedups across acquisition paths.
function srcFnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function srcHash(text) { return srcFnv32(text) + '_' + text.length; }

const SRC_TEXT_EXTS = ['js', 'css', 'html', 'json', 'svg', 'txt', 'map', 'xml'];
function srcKind(r, includeBinary) {
  switch (r.type) {
    case 'script':     return 'js';
    case 'stylesheet': return 'css';
    case 'document':   return 'html';
  }
  const u = (r.url || '').split('?')[0].split('#')[0].toLowerCase();
  const m = u.match(/\.([a-z0-9]{1,8})$/);
  const ext = m ? m[1] : null;
  if (ext === 'mjs' || ext === 'cjs')     return 'js';
  if (ext === 'htm')                      return 'html';
  if (ext && SRC_TEXT_EXTS.includes(ext)) return ext;
  if (!includeBinary) return null;                                     // binary only when opted in
  if (ext)            return ext;                                      // png/jpg/woff2/… real ext
  if (r.type === 'image' || r.type === 'font' || r.type === 'media') return r.type;
  return null;
}

function srcGetContent(resource, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    try {
      resource.getContent((content, encoding) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ content, encoding });
      });
    } catch (_) { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
  });
}

// ── Network capture (Layer 2: XHR/fetch bodies via the DevTools HAR) ────────
// getResources() only sees cached static resources (script/stylesheet/document/
// image/font/media). The response bodies of XHR/fetch calls — the API JSON a
// SPA actually runs on — live in the network panel's HAR instead. We read them
// with chrome.devtools.network.getHAR() and, optionally, reload the page first
// so the initial load's requests are recorded too. Emitted as the same
// SOURCE_CONTENT file shape with acquisition_level:2. Feature-detected, so
// browsers without devtools.network.getHAR just skip it (graceful degrade).

// content-type / URL → storage extension (mirrors srcKind for the network side).
function netKind(url, mime, includeBinary) {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  if (m === 'application/json' || m.endsWith('+json')) return 'json';
  if (m === 'text/html')                               return 'html';
  if (m === 'text/css')                                return 'css';
  if (m.includes('javascript') || m === 'application/ecmascript') return 'js';
  if (m === 'image/svg+xml')                           return 'svg';
  if (m === 'application/xml' || m === 'text/xml')     return 'xml';
  if (m.startsWith('text/'))                           return 'txt';
  const u = (url || '').split('?')[0].split('#')[0].toLowerCase();
  const em = u.match(/\.([a-z0-9]{1,8})$/);
  const ext = em ? em[1] : null;
  if (ext === 'mjs' || ext === 'cjs')      return 'js';
  if (ext === 'htm')                       return 'html';
  if (ext && SRC_TEXT_EXTS.includes(ext))  return ext;
  if (!includeBinary)                      return null;
  if (ext)                                 return ext;
  return null;
}

// getContent() on a HAR entry (same callback shape as resource.getContent).
function srcEntryContent(entry, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    try {
      entry.getContent((content, encoding) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ content, encoding });
      });
    } catch (_) { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
  });
}

// Reload the inspected page and resolve once the network has been quiet for
// `idleMs` (or `maxMs` elapses) — so getHAR() afterwards holds the full load.
function srcReloadAndWait(net, idleMs = 1200, maxMs = 8000) {
  return new Promise((resolve) => {
    let last = Date.now();
    let settled = false;
    const onFin = () => { last = Date.now(); };
    try { net.onRequestFinished.addListener(onFin); } catch (_) {}
    try { chrome.devtools.inspectedWindow.reload({}); } catch (_) {}
    const start = Date.now();
    const iv = setInterval(() => {
      if (settled) return;
      if (Date.now() - last > idleMs || Date.now() - start > maxMs) {
        settled = true;
        clearInterval(iv);
        try { net.onRequestFinished.removeListener(onFin); } catch (_) {}
        resolve();
      }
    }, 200);
  });
}

async function captureNetworkSources(opts, seenUrls) {
  const net = chrome.devtools && chrome.devtools.network;
  if (!net || typeof net.getHAR !== 'function') return { files: [], stored: 0, supported: false };
  const includeBinary = !!(opts && opts.includeBinary);

  // Buffer requests finishing from now on (covers a reload's traffic and any
  // late XHR); getHAR() below also returns the history DevTools already holds.
  const buffered = [];
  const onFin = (req) => { try { buffered.push(req); } catch (_) {} };
  let listening = false;
  try { net.onRequestFinished.addListener(onFin); listening = true; } catch (_) {}

  try {
    if (opts && opts.reload && chrome.devtools?.inspectedWindow?.reload) {
      setCaptureStatus('Reloading for full network capture…');
      await srcReloadAndWait(net);
    }
    const har = await new Promise((resolve) => net.getHAR((h) => resolve(h || {})));

    // Merge HAR history + buffered (buffered wins — fresher body), dedup by URL.
    const byUrl = new Map();
    for (const e of (har.entries || [])) { const u = e?.request?.url; if (u) byUrl.set(u, e); }
    for (const e of buffered)             { const u = e?.request?.url; if (u) byUrl.set(u, e); }

    const files = [];
    let stored = 0;
    let i = 0;
    const total = byUrl.size;
    for (const entry of byUrl.values()) {
      i++;
      if (files.length >= MAX_NET_FILES) break;
      const url = entry.request && entry.request.url;
      if (!url) continue;
      const rt = String(entry._resourceType || '').toLowerCase();
      const isApi = rt === 'xhr' || rt === 'fetch';
      // Skip what getResources() already covered, unless it's an API call —
      // those carry response bodies getResources never sees.
      if (!isApi && seenUrls && seenUrls.has(url)) continue;
      const mime = entry.response?.content?.mimeType || '';
      const kind = netKind(url, mime, includeBinary);
      if (!kind) continue;
      setCaptureStatus(`Network ${i}/${total}…`);
      const got = await srcEntryContent(entry, 5000);
      if (!got || got.content == null) {
        files.push({ url, kind, acquisition_level: 2, hash: null, byteLength: null, stored: false });
        continue;
      }
      const isBin = got.encoding === 'base64';
      if (isBin && !includeBinary) {
        files.push({ url, kind, acquisition_level: 2, hash: null, byteLength: null, stored: false });
        continue;
      }
      const data = got.content;
      const hash = srcHash(data);
      if (data.length > CAPTURE_MAX_BYTES) {
        files.push({ url, kind, acquisition_level: 2, hash, byteLength: data.length, stored: false, capped: true });
        continue;
      }
      files.push({ url, kind, acquisition_level: 2, hash, byteLength: data.length, stored: true, content: data, encoding: isBin ? 'base64' : 'utf-8' });
      stored++;
    }
    return { files, stored, supported: true };
  } finally {
    if (listening) { try { net.onRequestFinished.removeListener(onFin); } catch (_) {} }
  }
}

function setCaptureStatus(s) {
  const el = document.getElementById('capture-status');
  if (el) el.textContent = s || '';
}

async function captureAllSources(reqId = null, opts = null) {
  const includeBinary = !!(opts && opts.includeBinary);
  const dw = chrome.devtools?.inspectedWindow;
  if (!dw?.getResources) { setCaptureStatus('getResources() unavailable here'); srcCaptureDone(reqId, { ok: false, error: 'no_getResources' }); return; }
  setCaptureStatus('Scanning…');
  const resources = await new Promise((resolve) => dw.getResources((r) => resolve(r || [])));

  const seen = new Set();
  const targets = [];
  for (const r of resources) {
    if (!r || !r.url || seen.has(r.url)) continue;
    const kind = srcKind(r, includeBinary);
    if (!kind) continue;
    seen.add(r.url);
    targets.push({ r, kind });
  }
  if (!targets.length) { setCaptureStatus('No resources found'); srcCaptureDone(reqId, { ok: true, stored: 0, count: 0 }); return; }

  const files = [];
  let stored = 0;
  for (let i = 0; i < targets.length; i++) {
    const { r, kind } = targets[i];
    setCaptureStatus(`Fetching ${i + 1}/${targets.length}…`);
    const res = await srcGetContent(r, 5000);
    if (!res || res.content == null) {
      files.push({ url: r.url, kind, acquisition_level: 1, hash: null, byteLength: null, stored: false });
      continue;
    }
    const isBin = res.encoding === 'base64';
    if (isBin && !includeBinary) {
      files.push({ url: r.url, kind, acquisition_level: 1, hash: null, byteLength: null, stored: false });
      continue;
    }
    const data = res.content;
    const hash = srcHash(data);
    if (data.length > CAPTURE_MAX_BYTES) {
      files.push({ url: r.url, kind, acquisition_level: 1, hash, byteLength: data.length, stored: false, capped: true });
      continue;
    }
    files.push({ url: r.url, kind, acquisition_level: 1, hash, byteLength: data.length, stored: true, content: data, encoding: isBin ? 'base64' : 'utf-8' });
    stored++;
  }

  // Layer 2: optionally append XHR/fetch response bodies from the network HAR.
  let netStored = 0;
  if (opts && opts.includeNetwork) {
    const net = await captureNetworkSources(opts, seen);
    if (!net.supported) {
      setCaptureStatus('Network capture unavailable here (no devtools.network.getHAR)');
    } else {
      for (const f of net.files) files.push(f);
      netStored = net.stored;
    }
  }

  chrome.runtime.sendMessage({
    type: 'SOURCE_CAPTURE_RESULT',
    tabId,
    payload: { timestamp: Date.now(), files, count: files.length },
  });
  setCaptureStatus(`Captured ${stored}/${targets.length} resources${opts && opts.includeNetwork ? ` + ${netStored} network` : ''} → server`);
  const ov = document.getElementById('ov-sources');
  if (ov) ov.textContent = stored + netStored;
  srcCaptureDone(reqId, { ok: true, stored: stored + netStored, count: files.length });
}

// Ack a server-initiated capture so core.requestSourceCapture() resolves.
// Button-initiated captures pass no reqId and skip this.
function srcCaptureDone(reqId, info) {
  if (!reqId) return;
  chrome.runtime.sendMessage({ type: 'SOURCE_CAPTURE_DONE', tabId, reqId, ...info });
}

// Server → panel: an agent requested a capture for this tab (via the SW).
function onSourceCaptureRequest(msg) {
  setCaptureStatus('Capturing (agent)…');
  captureAllSources(msg.reqId, msg.opts).catch((e) => srcCaptureDone(msg.reqId, { ok: false, error: String((e && e.message) || e) }));
}

document.getElementById('btn-capture-sources').addEventListener('click', () => {
  captureAllSources().catch((e) => setCaptureStatus('Capture failed: ' + (e?.message || e)));
});

// Text search filter
document.getElementById('text-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.text-word-row').forEach(row => {
    const text = row.dataset.text || '';
    row.style.display = (!q || text.toLowerCase().includes(q)) ? '' : 'none';
  });
});

// ── Handlers ──────────────────────────────────────────────────────────────
function setConnected(v) {
  state.connected = v;
  document.getElementById('dot').classList.toggle('on', v);
  document.getElementById('server-status').textContent = v ? 'Connected' : 'Disconnected';
}

function onReact(data) {
  if (!data) return;
  state.reactData = data;
  // Count components
  let count = 0;
  function countNodes(n) { if (!n) return; count++; (n.c || []).forEach(countNodes); }
  countNodes(data.componentTree);
  document.getElementById('ov-components').textContent = count;
  renderReactTree(data);
}

function renderReactTree(data) {
  const container = document.getElementById('fw-react');
  // A fresh REACT_SNAPSHOT rebuilds the whole tree; preserve the panel's scroll
  // position so the user isn't jumped away from the node they were inspecting.
  const scroller = container.closest('.panel');
  const prevScroll = scroller ? scroller.scrollTop : 0;
  container.innerHTML = '';
  if (!data?.componentTree) { container.innerHTML = '<span class="empty">No fiber tree</span>'; return; }
  // Remember which nodes the user expanded/collapsed so a fresh REACT_SNAPSHOT
  // (which re-renders the whole tree) doesn't reset the tree back to the default
  // and collapse what they were looking at. Keyed by structural path + name.
  if (!state.reactExpand) state.reactExpand = new Map();
  const expandState = state.reactExpand;

  function renderNode(node, path) {
    if (!node) return null;
    const key = path + ':' + (node.n || '');
    const div = document.createElement('div');
    div.className = 'tree-node';
    const label = document.createElement('div');
    label.className = 'label';
    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    const name = document.createElement('span');
    name.className = 'comp-name';
    name.textContent = node.n || 'Unknown';
    if (node.w || !node.n) name.classList.add('anon'); // derived/kind-label name → dim
    label.append(caret, name);
    if (node.n?.match(/^[a-z]/)) {
      const tag = document.createElement('span');
      tag.className = 'comp-tag';
      tag.textContent = ` <${node.n}>`;
      label.appendChild(tag);
    }
    div.appendChild(label);

    const children = document.createElement('div');
    (node.c || []).forEach((child, i) => {
      const c = renderNode(child, path + '.' + i);
      if (c) children.appendChild(c);
    });
    const hasChildren = children.children.length > 0;

    // User override wins; otherwise auto-expand the top 3 levels.
    const override = expandState.get(key);
    let expanded = override !== undefined ? override : (node.d < 3);
    const apply = () => {
      children.style.display = expanded ? '' : 'none';
      caret.textContent = hasChildren ? (expanded ? '▾' : '▸') : ' ';
    };
    apply();
    if (hasChildren) {
      label.addEventListener('click', () => {
        expanded = !expanded;
        expandState.set(key, expanded);
        apply();
      });
    }
    div.appendChild(children);
    return div;
  }
  container.appendChild(renderNode(data.componentTree, '0'));
  if (scroller) scroller.scrollTop = prevScroll;
}

function onVue(data, ver) {
  state.vueData = data;
  const container = document.getElementById('fw-vue');
  container.innerHTML = `<pre>${esc(JSON.stringify(data, null, 2).slice(0, 3000))}</pre>`;
}

function onAngular(data) {
  state.angularData = data;
  document.getElementById('fw-angular').innerHTML = `<pre>${esc(JSON.stringify(data, null, 2).slice(0, 3000))}</pre>`;
}

function onOtherFw(type, data) {
  // Keep the latest snapshot per framework and rebuild — appending grew the list
  // with duplicate dumps on every snapshot.
  if (!state.otherFw) state.otherFw = {};
  state.otherFw[type] = data;
  const container = document.getElementById('fw-other');
  container.innerHTML = Object.keys(state.otherFw).map(t =>
    `<div class="section-title">${esc(t.replace('_SNAPSHOT',''))}</div>
     <pre>${esc(JSON.stringify(state.otherFw[t], null, 2).slice(0, 1500))}</pre>`
  ).join('') || '<span class="empty">None detected</span>';
}

function onGeneric(data) {
  state.genericData = data;
  const el = document.getElementById('fw-generic');
  el.innerHTML = `<pre>${esc(JSON.stringify(data, null, 2).slice(0, 3000))}</pre>`;
}

function onNetRequest(data) {
  if (!data) return;
  state.requests.push(data);
  if (data.tokens?.length) state.tokens.push(...data.tokens);
  if (data.url) state.endpoints.add(new URL(data.url, location.href).pathname);
  document.getElementById('ov-requests').textContent = state.requests.length;
  document.getElementById('badge-net').textContent = state.requests.length;
  document.getElementById('req-count').textContent = `(${state.requests.length})`;
  renderNetRequests();
  renderTokens();
  renderEndpoints();
}

function onNetResponse(data) {
  // Update matching request row status
  const row = document.querySelector(`[data-reqid="${data.reqId}"] .net-status`);
  if (row) {
    row.textContent = data.status;
    const cls = data.status >= 500 ? 'status-5' : data.status >= 400 ? 'status-4' :
                data.status >= 300 ? 'status-3' : 'status-2';
    row.className = `net-status ${cls}`;
  }
}

function renderNetRequests() {
  const container = document.getElementById('net-requests');
  container.innerHTML = '';
  const recent = state.requests.slice(-100).reverse();
  for (const req of recent) {
    const row = document.createElement('div');
    row.className = 'net-row';
    row.dataset.reqid = req.reqId;
    const method = (req.method || 'GET').toUpperCase();
    const url    = req.url || '';
    row.innerHTML = `
      <span class="method ${safeId(method)}">${esc(method)}</span>
      <span class="net-status status-2" style="min-width:28px;text-align:right;color:var(--dim)">…</span>
      <span class="net-url" title="${esc(url)}">${esc(url)}</span>
      ${req.tokens?.length ? `<span class="token-badge">🔑 ${esc(req.tokens.map(t=>t.type).join(','))}</span>` : ''}
    `;
    container.appendChild(row);
  }
}

function renderTokens() {
  const el = document.getElementById('net-tokens');
  if (!state.tokens.length) { el.innerHTML = '<span class="empty">None detected</span>'; return; }
  el.innerHTML = state.tokens.map(t =>
    `<div style="font-family:var(--mono);font-size:10px;padding:2px 5px">
      <span style="color:var(--purple)">${esc(t.type)}</span>
      <span style="color:var(--dim)">${esc(t.header)}: ${esc(t.preview)}</span>
    </div>`
  ).join('');
}

function renderEndpoints() {
  const el = document.getElementById('net-endpoints');
  if (!state.endpoints.size) { el.innerHTML = '<span class="empty">None yet</span>'; return; }
  el.innerHTML = [...state.endpoints].sort().map(e =>
    `<div style="font-family:var(--mono);font-size:10px;padding:1px 5px;color:var(--green)">${esc(e)}</div>`
  ).join('');
}

function onTextCoords(data) {
  if (!data) return;
  state.textData = data;
  document.getElementById('ov-words').textContent = data.totalWords || 0;
  document.getElementById('badge-text').textContent = data.totalWords || 0;
  renderTextWords(data);
  renderTextLines(data);
  document.getElementById('text-full').textContent = (data.fullText || '').slice(0, 5000);
}

function renderTextWords(data) {
  const container = document.getElementById('text-words');
  const count     = document.getElementById('text-word-count');
  container.innerHTML = '';
  const words = data.words || [];
  count.textContent = `(${words.length})`;
  for (const w of words.slice(0, 300)) {
    const row = document.createElement('div');
    row.className = 'text-word-row';
    row.dataset.text = w.text;
    row.innerHTML = `
      <span class="text-word">${esc(w.text)}</span>
      <span class="text-coords">(${esc(w.absoluteX)},${esc(w.absoluteY)}) ${esc(w.width)}×${esc(w.height)}</span>
      <span class="text-elem">&lt;${esc(w.element)}&gt;</span>
      <span class="text-style">${esc(w.fontSize)}px ${esc(w.fontFamily || '')}</span>
    `;
    container.appendChild(row);
  }
  if (words.length > 300) {
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = `…and ${words.length - 300} more words`;
    container.appendChild(more);
  }
}

function renderTextLines(data) {
  const container = document.getElementById('text-lines');
  const count     = document.getElementById('text-line-count');
  const lines = data.lines || [];
  count.textContent = `(${lines.length})`;
  container.innerHTML = '';
  for (const line of lines.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'text-word-row';
    row.innerHTML = `
      <span class="text-word" style="flex:1">${esc(line.text?.slice(0, 80))}</span>
      <span class="text-coords">(${line.absoluteX},${line.absoluteY})</span>
    `;
    container.appendChild(row);
  }
}

function onCss(data) {
  if (!data) return;
  state.cssData = data;

  // Frameworks
  const fwEl = document.getElementById('css-frameworks');
  const fws  = data.frameworks || {};
  fwEl.innerHTML = Object.keys(fws).filter(k=>fws[k])
    .map(k => `<span class="badge">${esc(k)}</span>`).join('') || '<span class="empty">None detected</span>';

  // Colors
  const colorEl = document.getElementById('css-colors');
  colorEl.innerHTML = '';
  for (const t of (data.tokens?.colors || []).slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'token-row';
    row.innerHTML = `<div class="color-swatch" style="background:${esc(t.value)}"></div>
      <span style="color:var(--accent)">${esc(t.prop)}</span>
      <span style="color:var(--dim)">${esc(t.value)}</span>`;
    colorEl.appendChild(row);
  }

  // Spacing/Radii
  const spEl = document.getElementById('css-spacing');
  spEl.innerHTML = [...(data.tokens?.spacing||[]),...(data.tokens?.radii||[])]
    .slice(0,40).map(t =>
      `<div class="token-row"><span style="color:var(--accent)">${esc(t.prop)}</span>
       <span style="color:var(--dim)">${esc(t.value)}</span></div>`
    ).join('');

  // Fonts
  const ftEl = document.getElementById('css-type');
  ftEl.innerHTML = (data.tokens?.fonts||[]).slice(0,20).map(t =>
    `<div class="token-row"><span style="color:var(--yellow)">${esc(t.prop)}</span>
     <span style="color:var(--dim)">${esc(t.value)}</span></div>`
  ).join('');
}

function onUi(data) {
  if (!data) return;
  state.uiData = data;

  const btnsEl = document.getElementById('ui-buttons');
  document.getElementById('ui-btn-count').textContent = `(${data.counts?.buttons || 0})`;
  btnsEl.innerHTML = (data.buttons||[]).slice(0,50).map(b =>
    `<div style="padding:2px 5px;font-size:10px;font-family:var(--mono)">
      <span style="color:var(--accent)">[btn]</span>
      <span>${esc(b.text||'(no text)')}</span>
      ${b.disabled ? '<span style="color:var(--red)"> disabled</span>' : ''}
    </div>`
  ).join('');

  const inputsEl = document.getElementById('ui-inputs');
  inputsEl.innerHTML = (data.inputs||[]).slice(0,30).map(i =>
    `<div style="padding:2px 5px;font-size:10px;font-family:var(--mono)">
      <span style="color:var(--yellow)">[${esc(i.type)}]</span>
      <span style="color:var(--dim)">${esc(i.name||i.id||'(unnamed)')}</span>
      ${i.placeholder ? `<span style="color:var(--dim)"> "${esc(i.placeholder)}"</span>` : ''}
    </div>`
  ).join('');

  const linksEl = document.getElementById('ui-links');
  linksEl.innerHTML = (data.links||[]).slice(0,30).map(l =>
    `<div style="padding:2px 5px;font-size:10px;font-family:var(--mono)">
      <span style="color:var(--accent)">${esc(l.text||'(no text)')}</span>
      <span style="color:var(--dim)"> → ${esc(l.href?.slice(0,80) || '')}</span>
    </div>`
  ).join('');
}

function onFrameworks(data) {
  state.fwData = data;
  const el = document.getElementById('ov-frameworks');
  if (!data?.detected?.length) { el.innerHTML = '<span class="empty">None</span>'; return; }
  el.innerHTML = data.detected.map(f => {
    const cls = safeId(f.frameworkId || 'generic');
    return `<span class="badge ${cls}">${esc(f.name)}</span>`;
  }).join('');
}

function onLcp(data) {
  state.lcp = data?.value;
  document.getElementById('ov-lcp').textContent = data?.value ? Math.round(data.value) : '–';
}

function onSources(data) {
  const count = data?.resources?.length || 0;
  document.getElementById('ov-sources').textContent = count;
}

function onSession(msg) {
  const el = document.getElementById('ov-cache');
  el.textContent = msg.sessionId || 'active';
  document.getElementById('ov-url').textContent = msg.url || '';
}

// ── Stream ────────────────────────────────────────────────────────────────
const STREAM_MAX = 200;
function addToStream(msg) {
  const list = document.getElementById('stream-list');
  const row  = document.createElement('div');
  const cls  = msg.realtime ? 'realtime'
    : msg.type?.startsWith('REACT') ? 'react'
    : msg.type?.startsWith('CSS')   ? 'css'
    : msg.type?.startsWith('TEXT')  ? 'text'
    : msg.type?.startsWith('NETWORK') ? 'network'
    : '';
  row.className = `event ${cls}`;
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  let preview = '';
  try { preview = JSON.stringify(msg.payload || msg).slice(0, 120); }
  catch (_) {}
  row.innerHTML = `<span class="etype">${esc(msg.type||'?')}</span>
    <span class="etime">${time}</span>
    <span class="epayload">${esc(preview)}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > STREAM_MAX) list.lastChild.remove();
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Escape for BOTH text and attribute contexts (quotes too) — panel data is
// page-controlled and the DevTools panel page is privileged, so an unescaped
// component name / URL / CSS value must never inject markup.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Safe identifier for use in a class attribute (e.g. framework id → CSS class).
function safeId(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, ''); }
