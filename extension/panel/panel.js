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
  container.innerHTML = '';
  if (!data?.componentTree) { container.innerHTML = '<span class="empty">No fiber tree</span>'; return; }
  const FW_COLORS = { vue3:'#42b883', vue2:'#42b883', angular:'#dd0031',
                      svelte:'#ff3e00', react:'var(--blue)' };
  function renderNode(node) {
    if (!node) return null;
    const div = document.createElement('div');
    div.className = 'tree-node';
    const label = document.createElement('div');
    label.className = 'label';
    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    caret.textContent = (node.c?.length) ? '▾' : ' ';
    const name = document.createElement('span');
    name.className = 'comp-name';
    name.textContent = node.n || 'Unknown';
    label.append(caret, name);
    if (node.n?.match(/^[a-z]/)) {
      const tag = document.createElement('span');
      tag.className = 'comp-tag';
      tag.textContent = ` <${node.n}>`;
      label.appendChild(tag);
    }
    div.appendChild(label);
    const children = document.createElement('div');
    children.style.display = 'none';
    (node.c || []).forEach(child => {
      const c = renderNode(child);
      if (c) children.appendChild(c);
    });
    if (children.children.length) {
      label.addEventListener('click', () => {
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        caret.textContent = open ? '▸' : '▾';
      });
    }
    div.appendChild(children);
    // Auto-expand top 3 levels
    if (node.d < 3) children.style.display = '';
    return div;
  }
  container.appendChild(renderNode(data.componentTree));
}

function onVue(data, ver) {
  state.vueData = data;
  const container = document.getElementById('fw-vue');
  container.innerHTML = `<pre>${JSON.stringify(data, null, 2).slice(0, 3000)}</pre>`;
}

function onAngular(data) {
  state.angularData = data;
  document.getElementById('fw-angular').innerHTML = `<pre>${JSON.stringify(data, null, 2).slice(0, 3000)}</pre>`;
}

function onOtherFw(type, data) {
  const container = document.getElementById('fw-other');
  const sec = document.createElement('div');
  sec.innerHTML = `<div class="section-title">${type.replace('_SNAPSHOT','')}</div>
    <pre>${JSON.stringify(data, null, 2).slice(0, 1500)}</pre>`;
  if (container.querySelector('.empty')) container.innerHTML = '';
  container.appendChild(sec);
}

function onGeneric(data) {
  state.genericData = data;
  const el = document.getElementById('fw-generic');
  el.innerHTML = `<pre>${JSON.stringify(data, null, 2).slice(0, 3000)}</pre>`;
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
      <span class="method ${method}">${method}</span>
      <span class="net-status status-2" style="min-width:28px;text-align:right;color:var(--dim)">…</span>
      <span class="net-url" title="${url}">${url}</span>
      ${req.tokens?.length ? `<span class="token-badge">🔑 ${req.tokens.map(t=>t.type).join(',')}</span>` : ''}
    `;
    container.appendChild(row);
  }
}

function renderTokens() {
  const el = document.getElementById('net-tokens');
  if (!state.tokens.length) { el.innerHTML = '<span class="empty">None detected</span>'; return; }
  el.innerHTML = state.tokens.map(t =>
    `<div style="font-family:var(--mono);font-size:10px;padding:2px 5px">
      <span style="color:var(--purple)">${t.type}</span>
      <span style="color:var(--dim)">${t.header}: ${t.preview}</span>
    </div>`
  ).join('');
}

function renderEndpoints() {
  const el = document.getElementById('net-endpoints');
  if (!state.endpoints.size) { el.innerHTML = '<span class="empty">None yet</span>'; return; }
  el.innerHTML = [...state.endpoints].sort().map(e =>
    `<div style="font-family:var(--mono);font-size:10px;padding:1px 5px;color:var(--green)">${e}</div>`
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
      <span class="text-coords">(${w.absoluteX},${w.absoluteY}) ${w.width}×${w.height}</span>
      <span class="text-elem">&lt;${w.element}&gt;</span>
      <span class="text-style">${w.fontSize}px ${w.fontFamily || ''}</span>
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
    .map(k => `<span class="badge">${k}</span>`).join('') || '<span class="empty">None detected</span>';

  // Colors
  const colorEl = document.getElementById('css-colors');
  colorEl.innerHTML = '';
  for (const t of (data.tokens?.colors || []).slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'token-row';
    row.innerHTML = `<div class="color-swatch" style="background:${t.value}"></div>
      <span style="color:var(--accent)">${t.prop}</span>
      <span style="color:var(--dim)">${t.value}</span>`;
    colorEl.appendChild(row);
  }

  // Spacing/Radii
  const spEl = document.getElementById('css-spacing');
  spEl.innerHTML = [...(data.tokens?.spacing||[]),...(data.tokens?.radii||[])]
    .slice(0,40).map(t =>
      `<div class="token-row"><span style="color:var(--accent)">${t.prop}</span>
       <span style="color:var(--dim)">${t.value}</span></div>`
    ).join('');

  // Fonts
  const ftEl = document.getElementById('css-type');
  ftEl.innerHTML = (data.tokens?.fonts||[]).slice(0,20).map(t =>
    `<div class="token-row"><span style="color:var(--yellow)">${t.prop}</span>
     <span style="color:var(--dim)">${t.value}</span></div>`
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
      <span style="color:var(--yellow)">[${i.type}]</span>
      <span style="color:var(--dim)">${i.name||i.id||'(unnamed)'}</span>
      ${i.placeholder ? `<span style="color:var(--dim)"> "${esc(i.placeholder)}"</span>` : ''}
    </div>`
  ).join('');

  const linksEl = document.getElementById('ui-links');
  linksEl.innerHTML = (data.links||[]).slice(0,30).map(l =>
    `<div style="padding:2px 5px;font-size:10px;font-family:var(--mono)">
      <span style="color:var(--accent)">${esc(l.text||'(no text)')}</span>
      <span style="color:var(--dim)"> → ${l.href?.slice(0,80)}</span>
    </div>`
  ).join('');
}

function onFrameworks(data) {
  state.fwData = data;
  const el = document.getElementById('ov-frameworks');
  if (!data?.detected?.length) { el.innerHTML = '<span class="empty">None</span>'; return; }
  el.innerHTML = data.detected.map(f => {
    const cls = f.frameworkId || 'generic';
    return `<span class="badge ${cls}">${f.name}</span>`;
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
  row.innerHTML = `<span class="etype">${msg.type||'?'}</span>
    <span class="etime">${time}</span>
    <span class="epayload">${esc(preview)}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > STREAM_MAX) list.lastChild.remove();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
