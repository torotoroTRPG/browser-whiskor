/**
 * analyzers/console-logger.js  –  MAIN world
 * Intercepts console.log/warn/error/info/debug output.
 * Buffers entries and emits them in batches.
 *
 * Emits: CONSOLE_LOG
 */
'use strict';

(function () {
  if (window.__SI_CONSOLE_INIT__) return;
  window.__SI_CONSOLE_INIT__ = true;

  const MAX_BUFFER   = 2000;
  const BATCH_MS     = 500;   // flush interval
  const MAX_ARG_LEN  = 500;   // truncate long strings

  const buffer = [];
  let flushTimer = null;
  let _config = {};
  let _emit = null;

  // ── Intercept console methods ──────────────────────────────────────────────

  const LEVELS = ['log', 'warn', 'error', 'info', 'debug', 'trace', 'group', 'groupEnd', 'table'];

  const _originals = {};
  LEVELS.forEach(level => { _originals[level] = console[level]?.bind(console); });

  function serialize(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    const t = typeof arg;
    if (t === 'string')  return arg.slice(0, MAX_ARG_LEN);
    if (t === 'number' || t === 'boolean') return String(arg);
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (arg instanceof Element) return `<${arg.tagName.toLowerCase()}${arg.id ? '#' + arg.id : ''}>`;
    try {
      const s = JSON.stringify(arg, null, 0);
      return (s || '').slice(0, MAX_ARG_LEN);
    } catch {
      return String(arg).slice(0, MAX_ARG_LEN);
    }
  }

  function formatArgs(args) {
    return Array.from(args).map(serialize).join(' ');
  }

  function getStack() {
    try {
      throw new Error();
    } catch (e) {
      const lines = (e.stack || '').split('\n');
      // Skip the first 3 frames (Error + getStack + intercept wrapper)
      const relevant = lines.slice(3).find(l => l.includes('.js') && !l.includes('console-logger'));
      return relevant ? relevant.trim().replace(/^at /, '') : null;
    }
  }

  function intercept(level, original) {
    console[level] = function (...args) {
      // Always call original
      if (original) original(...args);

      if (buffer.length >= MAX_BUFFER) buffer.shift();

      buffer.push({
        level,
        message:     formatArgs(args),
        timestamp:   Date.now(),
        stack:       (level === 'error' || level === 'warn') ? getStack() : null,
      });

      scheduleFlush();
    };
  }

  const enabledLevels = _config?.console?.levels || ['log', 'warn', 'error', 'info', 'debug'];
  LEVELS.forEach(level => {
    if (enabledLevels.includes(level) || level === 'error' || level === 'warn') {
      intercept(level, _originals[level]);
    }
  });

  // ── Error event capture ────────────────────────────────────────────────────

  window.addEventListener('error', (event) => {
    buffer.push({
      level:     'error',
      message:   `Uncaught ${event.error?.name || 'Error'}: ${event.message}`,
      timestamp: Date.now(),
      source:    event.filename,
      line:      event.lineno,
      col:       event.colno,
      stack:     event.error?.stack?.slice(0, 500),
    });
    scheduleFlush();
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}`
      : serialize(event.reason);
    buffer.push({
      level:     'error',
      message:   `Unhandled Promise Rejection: ${reason}`,
      timestamp: Date.now(),
      stack:     event.reason?.stack?.slice(0, 500),
    });
    scheduleFlush();
  });

  // ── Flush ──────────────────────────────────────────────────────────────────

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, BATCH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    if (!_emit) return;

    const entries = buffer.splice(0, buffer.length);
    _emit('CONSOLE_LOG', {
      capturedAt:   Date.now(),
      totalEntries: entries.length,
      entries,
    });
  }

  // ── Registration hook (called by collector.js) ─────────────────────────────

  window.__SI_CONSOLE_LOGGER__ = {
    setEmit(fn)   { _emit = fn; },
    setConfig(cfg) { _config = cfg; },
    flush,
    getLogs() { return [...buffer]; },
    clear() { buffer.length = 0; },
  };

})();
