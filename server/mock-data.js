/**
 * server/mock-data.js
 * Injects realistic mock messages into cache-writer so you can test
 * the server and dashboard without a running browser extension.
 *
 * Usage:  node server/index.js --mock
 */

'use strict';

const cache = require('./cache-writer');

const MOCK_TAB_ID = 1001;
const MOCK_URL    = 'https://example-react-app.com/dashboard';

function injectMockData() {
  console.log('[mock] Injecting mock session data for tabId', MOCK_TAB_ID);

  // ── Framework detection ───────────────────────────────────────────────────
  cache.handleMessage({
    type: 'FRAMEWORK_DETECTION',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      url: MOCK_URL,
      detected: [
        { id: 'react-fiber', frameworkId: 'react', name: 'React Fiber Analyzer' },
        { id: 'dom-generic', frameworkId: 'vanilla', name: 'Generic DOM Analyzer' },
      ],
    },
  });

  // ── React snapshot ────────────────────────────────────────────────────────
  cache.handleMessage({
    type: 'REACT_SNAPSHOT',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      url: MOCK_URL,
      componentTree: {
        name: 'App',
        type: 'component',
        depth: 0,
        props: {},
        state: { theme: 'dark', user: { name: 'Alice', role: 'admin' } },
        hooks: [{ name: 'useState', value: { theme: 'dark' } }],
        children: [
          {
            name: 'Sidebar',
            type: 'component',
            depth: 1,
            props: { collapsed: false },
            children: [],
          },
          {
            name: 'Dashboard',
            type: 'component',
            depth: 1,
            props: { section: 'overview' },
            children: [
              { name: 'MetricCard', type: 'component', depth: 2, props: { title: 'Revenue', value: 84200 }, children: [] },
              { name: 'MetricCard', type: 'component', depth: 2, props: { title: 'Users', value: 1340 }, children: [] },
              { name: 'Chart',      type: 'component', depth: 2, props: { type: 'line', data: '[…]' }, children: [] },
            ],
          },
        ],
      },
      redux: {
        state: {
          auth:   { user: { name: 'Alice', role: 'admin' }, loggedIn: true },
          ui:     { sidebar: 'expanded', modal: null },
          data:   { metrics: { revenue: 84200, users: 1340 }, loading: false },
        },
        actionLog: [
          { type: 'auth/LOGIN_SUCCESS', ts: Date.now() - 5000 },
          { type: 'data/FETCH_METRICS', ts: Date.now() - 2000 },
          { type: 'data/METRICS_LOADED', ts: Date.now() - 1800 },
        ],
      },
    },
  });

  // ── Text coordinates ──────────────────────────────────────────────────────
  const words = [
    mkWord(1, 1, 1, 1, 1,  80,  60,  80, 22, 'Dashboard',  'h1', 'main-title'),
    mkWord(1, 1, 1, 1, 2, 170,  60,  50, 22, 'Overview',   'h1', 'main-title'),
    mkWord(1, 2, 1, 2, 1,  80, 120,  60, 16, 'Revenue',    'span', 'metric-label'),
    mkWord(1, 2, 1, 2, 2, 150, 120,  80, 16, '$84,200',    'span', 'metric-value'),
    mkWord(1, 3, 1, 3, 1,  80, 160,  40, 16, 'Users',      'span', 'metric-label'),
    mkWord(1, 3, 1, 3, 2, 130, 160,  50, 16, '1,340',      'span', 'metric-value'),
    mkWord(1, 4, 2, 4, 1,  80, 220,  30, 14, 'Sidebar',    'nav',  'sidebar'),
    mkWord(1, 4, 2, 4, 2, 120, 220,  40, 14, 'Home',       'a',    'nav-link'),
    mkWord(1, 4, 2, 4, 3, 170, 220,  60, 14, 'Analytics',  'a',    'nav-link'),
    mkWord(1, 4, 2, 4, 4, 240, 220,  50, 14, 'Settings',   'a',    'nav-link'),
  ];

  const lines = [
    { level: 4, page_num: 1, block_num: 1, par_num: 1, line_num: 1, left: 80, top: 60, width: 140, height: 22, conf: 100, text: 'Dashboard Overview', wordCount: 2, element: 'h1', absoluteX: 80, absoluteY: 60, viewportX: 80, viewportY: 60 },
    { level: 4, page_num: 1, block_num: 2, par_num: 1, line_num: 2, left: 80, top: 120, width: 150, height: 16, conf: 100, text: 'Revenue $84,200', wordCount: 2, element: 'span', absoluteX: 80, absoluteY: 120, viewportX: 80, viewportY: 120 },
  ];

  const blocks = [
    { level: 2, page_num: 1, block_num: 1, left: 60, top: 40, width: 400, height: 50, conf: 100, text: 'Dashboard Overview', element: 'header', elementId: 'header', role: 'banner', absoluteX: 60, absoluteY: 40, viewportX: 60, viewportY: 40 },
    { level: 2, page_num: 1, block_num: 2, left: 60, top: 100, width: 400, height: 100, conf: 100, text: 'Revenue $84,200 Users 1,340', element: 'main', elementId: 'metrics', role: 'main', absoluteX: 60, absoluteY: 100, viewportX: 60, viewportY: 100 },
  ];

  cache.handleMessage({
    type: 'TEXT_COORDS',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      pageUrl: MOCK_URL,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
      totalWords: words.length,
      totalLines: lines.length,
      totalBlocks: blocks.length,
      words,
      lines,
      blocks,
      fullText: words.map(w => w.text).join(' '),
    },
  });

  // ── Network ───────────────────────────────────────────────────────────────
  const baseTs = Date.now() - 3000;
  [
    { requestId: 'r1', method: 'GET',  url: 'https://api.example.com/metrics',    status: 200, duration: 120, startTime: baseTs,       body: '{"revenue":84200,"users":1340}' },
    { requestId: 'r2', method: 'POST', url: 'https://api.example.com/analytics',  status: 200, duration: 85,  startTime: baseTs + 200, body: '{"event":"page_view"}' },
    { requestId: 'r3', method: 'GET',  url: 'https://api.example.com/user/me',    status: 200, duration: 60,  startTime: baseTs + 500, body: '{"name":"Alice","role":"admin"}' },
    { requestId: 'r4', method: 'GET',  url: 'https://cdn.example.com/bundle.js',  status: 200, duration: 340, startTime: baseTs + 10,  initiatorType: 'script' },
  ].forEach(r => {
    cache.handleMessage({ type: 'NETWORK_REQUEST',  tabId: MOCK_TAB_ID, tabUrl: MOCK_URL, payload: { requestId: r.requestId, method: r.method, url: r.url, startTime: r.startTime, initiatorType: r.initiatorType || 'fetch' } });
    cache.handleMessage({ type: 'NETWORK_RESPONSE', tabId: MOCK_TAB_ID, tabUrl: MOCK_URL, payload: { requestId: r.requestId, status: r.status, duration: r.duration, responseBody: r.body || null } });
  });

  // ── UI catalog ────────────────────────────────────────────────────────────
  cache.handleMessage({
    type: 'UI_CATALOG',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      elements: [
        { type: 'button', text: 'Export CSV',   x: 900, y: 60,  width: 110, height: 36, enabled: true  },
        { type: 'button', text: 'Add Widget',   x: 1020, y: 60, width: 110, height: 36, enabled: true  },
        { type: 'input',  placeholder: 'Search…', x: 400, y: 60, width: 200, height: 36 },
        { type: 'select', label: 'Date Range',  x: 620, y: 60,  width: 160, height: 36, options: ['7d', '30d', '90d'] },
        { type: 'link',   text: 'Home',         href: '/',          x: 120, y: 220 },
        { type: 'link',   text: 'Analytics',    href: '/analytics', x: 170, y: 220 },
        { type: 'link',   text: 'Settings',     href: '/settings',  x: 240, y: 220 },
      ],
    },
  });

  // ── CSS analysis ──────────────────────────────────────────────────────────
  cache.handleMessage({
    type: 'CSS_ANALYSIS',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      customProperties: {
        '--color-primary':    '#6366f1',
        '--color-bg':         '#0f172a',
        '--color-surface':    '#1e293b',
        '--color-text':       '#f1f5f9',
        '--color-muted':      '#94a3b8',
        '--radius-md':        '8px',
        '--font-sans':        '"Inter", system-ui, sans-serif',
      },
      stylesheets: 3,
      totalRules: 842,
      inlineStyles: 14,
    },
  });

  // ── DOM generic ───────────────────────────────────────────────────────────
  cache.handleMessage({
    type: 'DOM_GENERIC_SNAPSHOT',
    tabId: MOCK_TAB_ID,
    tabUrl: MOCK_URL,
    payload: {
      capturedAt: Date.now(),
      docTitle:     'Dashboard — Example App',
      documentLang: 'en',
      ariaTree: {
        tag: 'body', role: null, label: null,
        children: [
          { tag: 'header', role: 'banner',      label: 'Main navigation', children: [] },
          { tag: 'nav',    role: 'navigation',  label: 'Sidebar',         children: [] },
          { tag: 'main',   role: 'main',        label: null,              children: [] },
        ],
      },
      globals: {
        __NEXT_DATA__: null,
        __PRELOADED_STATE__: { auth: { loggedIn: true } },
      },
      customElements: [],
      metaTags: [
        { key: 'description', value: 'Example React dashboard app' },
        { key: 'og:title',    value: 'Dashboard' },
      ],
    },
  });

  console.log('[mock] Mock data injected. Session tabId =', MOCK_TAB_ID);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkWord(page, block, par, line, word, left, top, width, height, text, element, cls) {
  const scrollX = 0, scrollY = 0;
  return {
    level: 5, page_num: page,
    block_num: block, par_num: par, line_num: line, word_num: word,
    left: left + scrollX, top: top + scrollY,
    width, height,
    conf: 100, text,
    element,
    elementId: null,
    elementClasses: cls,
    xpath: `/html/body/main//${element}[1]`,
    fontSize: height * 0.8,
    fontFamily: 'Inter',
    fontWeight: element === 'h1' ? '700' : '400',
    fontStyle: 'normal',
    color: 'rgb(241, 245, 249)',
    backgroundColor: 'rgba(0,0,0,0)',
    isLink: element === 'a',
    inViewport: true,
    isHidden: false,
    viewportX: left,
    viewportY: top,
    absoluteX: left,
    absoluteY: top,
  };
}

module.exports = { injectMockData, MOCK_TAB_ID };
