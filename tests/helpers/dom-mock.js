/**
 * dom-mock.js
 * Minimal browser-environment mock for Node.js.
 *
 * Sets up globalThis.window, globalThis.document, Event constructors,
 * canvas, requestAnimationFrame, and performance — enough for testing
 * executor.js, beacon.js, and canvas-*.js without any npm test deps.
 *
 * Usage:
 *   import './dom-mock.js';          // side-effect: patches globalThis
 *   import { createMockDocument } from './dom-mock.js';  // per-test DOM
 */

// ── Event system ────────────────────────────────────────────────────────────

export class MockEvent {
  constructor(type, init = {}) {
    this.type             = type;
    this.bubbles          = init.bubbles          ?? false;
    this.cancelable       = init.cancelable        ?? false;
    this.composed         = init.composed          ?? false;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediatePropagationStopped = false;
    this.target           = null;
    this.currentTarget    = null;
    this.timeStamp        = Date.now();
  }
  preventDefault()             { this.defaultPrevented = true; }
  stopPropagation()            { this.propagationStopped = true; }
  stopImmediatePropagation()   { this.immediatePropagationStopped = true; }
}

export class MockUIEvent extends MockEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? 0;
    this.view   = init.view   ?? null;
  }
}

export class MockMouseEvent extends MockUIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.clientX  = init.clientX  ?? 0;
    this.clientY  = init.clientY  ?? 0;
    this.pageX    = init.pageX    ?? 0;
    this.pageY    = init.pageY    ?? 0;
    this.screenX  = init.screenX  ?? 0;
    this.screenY  = init.screenY  ?? 0;
    this.button   = init.button   ?? 0;
    this.buttons  = init.buttons  ?? 0;
    this.ctrlKey  = init.ctrlKey  ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey   = init.altKey   ?? false;
    this.metaKey  = init.metaKey  ?? false;
    this.relatedTarget = init.relatedTarget ?? null;
  }
}

export class MockKeyboardEvent extends MockUIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key      = init.key      ?? '';
    this.code     = init.code     ?? '';
    this.keyCode  = init.keyCode  ?? 0;
    this.charCode = init.charCode ?? 0;
    this.which    = init.which    ?? 0;
    this.ctrlKey  = init.ctrlKey  ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey   = init.altKey   ?? false;
    this.metaKey  = init.metaKey  ?? false;
    this.repeat   = init.repeat   ?? false;
  }
}

export class MockWheelEvent extends MockMouseEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.deltaX    = init.deltaX    ?? 0;
    this.deltaY    = init.deltaY    ?? 0;
    this.deltaZ    = init.deltaZ    ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}

export class MockInputEvent extends MockUIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.inputType = init.inputType ?? '';
    this.data      = init.data      ?? null;
  }
}

// ── DOM Element ─────────────────────────────────────────────────────────────

export class MockElement {
  constructor(tag = 'div') {
    this.tagName       = tag.toUpperCase();
    this.nodeName      = this.tagName;
    this.nodeType      = 1;
    this.id            = '';
    this.className     = '';
    this.textContent   = '';
    this.innerHTML     = '';
    this.value         = '';
    this.checked       = false;
    this.disabled      = false;
    this.type          = '';
    this.href          = '';
    this.src           = '';
    this.dataset       = {};
    this.style         = {};
    this.attributes    = {};
    this.children      = [];
    this.childNodes    = [];
    this.parentNode    = null;
    this.parentElement = null;
    this._listeners    = {};
    this._dispatchedEvents = [];
    this.getBoundingClientRect = () => ({
      top: 10, left: 10, bottom: 50, right: 50,
      width: 40, height: 40, x: 10, y: 10,
    });
    this.scrollIntoView  = () => {};
    this.focus           = () => { mockDocument.activeElement = this; };
    this.blur            = () => {};
    this.click           = () => this.dispatchEvent(new MockMouseEvent('click', { bubbles: true }));
    this.setAttribute    = (k, v) => { this.attributes[k] = v; };
    this.getAttribute    = k     => this.attributes[k] ?? null;
    this.hasAttribute    = k     => k in this.attributes;
    this.removeAttribute = k     => { delete this.attributes[k]; };
    this.querySelector   = sel  => this._queryOne(sel);
    this.querySelectorAll = sel => this._queryAll(sel);
    this.append          = (...nodes) => { for (const n of nodes) { this.children.push(n); this.childNodes.push(n); if (n instanceof MockElement) n.parentNode = this; } };
    this.remove          = () => { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); } };
    this.matches         = () => false;
    this.closest         = () => null;
    this.scrollBy        = () => {};
    this.scrollTo        = () => {};
    this.offsetWidth     = 100;
    this.offsetHeight    = 100;
    this.scrollWidth     = 100;
    this.scrollHeight    = 200;
    this.scrollTop       = 0;
    this.scrollLeft      = 0;
  }

  addEventListener(type, fn, opts) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(f => f !== fn);
    }
  }

  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    this._dispatchedEvents.push(event);
    const fns = this._listeners[event.type] ?? [];
    for (const fn of fns) fn(event);
    return !event.defaultPrevented;
  }

  _queryOne(sel) { return this.children.find(c => c._matchesSel(sel)) ?? null; }
  _queryAll(sel) { return this.children.filter(c => c._matchesSel(sel)); }
  _matchesSel(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.className.split(' ').includes(sel.slice(1));
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  /** All dispatched events of a given type (for assertions). */
  events(type) { return this._dispatchedEvents.filter(e => e.type === type); }
}

export class MockCanvasElement extends MockElement {
  constructor() {
    super('canvas');
    this.width  = 300;
    this.height = 150;
    this._ctx   = new MockCanvas2DContext(this);
  }
  getContext(type) { return type === '2d' ? this._ctx : null; }
}

export class MockCanvas2DContext {
  constructor(canvas) {
    this.canvas      = canvas;
    this.calls       = [];          // recorded draw calls for assertions
    this.fillStyle   = '#000';
    this.strokeStyle = '#000';
    this.lineWidth   = 1;
    this.globalAlpha = 1;
    this.font        = '10px sans-serif';
    this.textBaseline = 'alphabetic';
    this.textAlign   = 'left';
    this.imageSmoothingEnabled = true;
    this._transform  = [1,0,0,1,0,0];
    this._savedStates = [];
  }
  _record(name, args) { this.calls.push({ name, args }); }
  clearRect(...a)     { this._record('clearRect', a); }
  fillRect(...a)      { this._record('fillRect', a); }
  strokeRect(...a)    { this._record('strokeRect', a); }
  fillText(...a)      { this._record('fillText', a); }
  strokeText(...a)    { this._record('strokeText', a); }
  beginPath()         { this._record('beginPath', []); }
  closePath()         { this._record('closePath', []); }
  moveTo(...a)        { this._record('moveTo', a); }
  lineTo(...a)        { this._record('lineTo', a); }
  arc(...a)           { this._record('arc', a); }
  rect(...a)          { this._record('rect', a); }
  fill()              { this._record('fill', []); }
  stroke()            { this._record('stroke', []); }
  clip()              { this._record('clip', []); }
  setLineDash(...a)   { this._record('setLineDash', a); }
  drawImage(...a)     { this._record('drawImage', a); }
  save()              { this._savedStates.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha }); }
  restore()           { if (this._savedStates.length) Object.assign(this, this._savedStates.pop()); }
  translate(...a)     { this._record('translate', a); }
  scale(...a)         { this._record('scale', a); }
  rotate(...a)        { this._record('rotate', a); }
  setTransform(...a)  { this._transform = a; this._record('setTransform', a); }
  resetTransform()    { this._transform = [1,0,0,1,0,0]; }
  measureText(text)   { return { width: text.length * 7 }; }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  /** Find all recorded calls with this name. */
  callsOf(name) { return this.calls.filter(c => c.name === name); }
  /** Reset recorded calls. */
  resetCalls() { this.calls = []; }
}

// ── Document ─────────────────────────────────────────────────────────────────

function createMockDocumentObj() {
  const body = new MockElement('body');
  const head = new MockElement('head');

  const doc = {
    nodeType:      9,
    body,
    head,
    documentElement: new MockElement('html'),
    activeElement: body,
    _elements:     {},
    _listeners:    {},
    readyState:    'complete',
    URL:           'http://localhost/',
    title:         'Test',
    hidden:        false,
    visibilityState: 'visible',

    createElement(tag) {
      if (tag === 'canvas') return new MockCanvasElement();
      return new MockElement(tag);
    },

    getElementById(id) {
      return doc._elements[id] ?? null;
    },

    querySelector(sel) {
      if (sel.startsWith('#')) return doc._elements[sel.slice(1)] ?? null;
      return body._queryOne(sel);
    },

    querySelectorAll(sel) {
      return body._queryAll(sel);
    },

    elementFromPoint(x, y) {
      // Return a registered hit-test element or a default div
      return doc._hitElement ?? new MockElement('div');
    },

    createEvent(type) { return new MockEvent(type); },

    addEventListener(type, fn) {
      if (!doc._listeners[type]) doc._listeners[type] = [];
      doc._listeners[type].push(fn);
    },

    removeEventListener(type, fn) {
      if (doc._listeners[type]) {
        doc._listeners[type] = doc._listeners[type].filter(f => f !== fn);
      }
    },

    dispatchEvent(event) {
      const fns = doc._listeners[event.type] ?? [];
      for (const fn of fns) fn(event);
    },

    /** Test helper: register an element by id. */
    _register(el) { doc._elements[el.id] = el; },
    /** Test helper: set what elementFromPoint returns. */
    _setHit(el)   { doc._hitElement = el; },
  };

  return doc;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createMockWindowObj(doc) {
  const win = {
    document: doc,
    innerWidth:   1280,
    innerHeight:  800,
    scrollX:      0,
    scrollY:      0,
    pageXOffset:  0,
    pageYOffset:  0,
    devicePixelRatio: 1,
    location: {
      href:     'http://localhost/',
      pathname: '/',
      search:   '',
      hash:     '',
      reload:   () => {},
    },
    history: {
      back()    {},
      forward() {},
      pushState() {},
      replaceState() {},
    },
    navigator: { userAgent: 'Node.js/test' },
    _rafQueue:  [],
    _rafId:     0,
    _listeners: {},

    requestAnimationFrame(cb) {
      const id = ++win._rafId;
      win._rafQueue.push({ id, cb });
      return id;
    },
    cancelAnimationFrame(id) {
      win._rafQueue = win._rafQueue.filter(f => f.id !== id);
    },
    /** Test helper: flush all pending rAF callbacks once. */
    flushRAF() {
      const q = win._rafQueue.splice(0);
      const t = performance.now();
      for (const { cb } of q) cb(t);
    },
    /** Test helper: flush rAF up to N times (for animation loops). */
    flushRAFTimes(n) { for (let i = 0; i < n; i++) win.flushRAF(); },

    addEventListener(type, fn, opts) {
      if (!win._listeners[type]) win._listeners[type] = [];
      win._listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (win._listeners[type]) {
        win._listeners[type] = win._listeners[type].filter(f => f !== fn);
      }
    },
    dispatchEvent(event) {
      event.currentTarget = win;
      const fns = win._listeners[event.type] ?? [];
      for (const fn of fns) fn(event);
    },

    scrollBy(x, y) { win.scrollX += x; win.scrollY += y; },
    scrollTo(x, y) { win.scrollX = x; win.scrollY = y; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    getSelection:     () => null,
    matchMedia:       () => ({ matches: false, addListener() {}, removeListener() {} }),

    // Event constructors
    Event:         MockEvent,
    UIEvent:       MockUIEvent,
    MouseEvent:    MockMouseEvent,
    KeyboardEvent: MockKeyboardEvent,
    WheelEvent:    MockWheelEvent,
    InputEvent:    MockInputEvent,

    performance: globalThis.performance ?? { now: () => Date.now() },
    console,
    fetch: globalThis.fetch,
    clearTimeout,
    setTimeout,
    clearInterval,
    setInterval,
  };

  return win;
}

// ── Install onto globalThis ───────────────────────────────────────────────────

let mockDocument = createMockDocumentObj();
let mockWindow   = createMockWindowObj(mockDocument);

function installGlobals() {
  globalThis.window    = mockWindow;
  globalThis.document  = mockDocument;
  globalThis.navigator = mockWindow.navigator;
  globalThis.location  = mockWindow.location;
  globalThis.history   = mockWindow.history;
  globalThis.Event         = MockEvent;
  globalThis.UIEvent       = MockUIEvent;
  globalThis.MouseEvent    = MockMouseEvent;
  globalThis.KeyboardEvent = MockKeyboardEvent;
  globalThis.WheelEvent    = MockWheelEvent;
  globalThis.InputEvent    = MockInputEvent;
  globalThis.requestAnimationFrame  = cb => mockWindow.requestAnimationFrame(cb);
  globalThis.cancelAnimationFrame   = id => mockWindow.cancelAnimationFrame(id);
  globalThis.getComputedStyle       = mockWindow.getComputedStyle;
  globalThis.devicePixelRatio       = 1;
}

installGlobals();

/**
 * createMockDocument — creates a fresh, isolated document+window pair for
 * per-test isolation without re-requiring the module.
 */
export function createMockDocument() {
  const doc = createMockDocumentObj();
  const win = createMockWindowObj(doc);
  return { document: doc, window: win };
}

/**
 * resetDOM — resets the global document/window to a fresh state.
 * Call in beforeEach for tests that mutate document.
 */
export function resetDOM() {
  mockDocument = createMockDocumentObj();
  mockWindow   = createMockWindowObj(mockDocument);
  installGlobals();
  return { document: mockDocument, window: mockWindow };
}

export { mockDocument as document, mockWindow as window };
