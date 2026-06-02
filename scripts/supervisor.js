#!/usr/bin/env node
/**
 * scripts/supervisor.js — keep the browser-whiskor worker alive.
 *
 * The worker (server/index.js) owns WS:7891 + HTTP:7892 + the cache + the
 * embedding pipeline — it is the heavy process that occasionally crashes. This
 * supervisor runs it as a child and restarts it on an *unclean* exit, so "the
 * server rarely falls over" turns into "it comes back in a second or two".
 *
 * What makes the handoff clean (no separate moving parts needed):
 *   - cache-writer writes atomically (tmp → rename): a crash never leaves a
 *     half-written JSON on disk.
 *   - the worker's crash handler flushes in-memory buffers synchronously and
 *     exits NON-zero; the startup integrity check repairs any dangling refs.
 *   - the MCP/stdio process the agent talks to is a SEPARATE proxy process; its
 *     HTTP forwards retry across the restart window (server/index.js requestServer),
 *     so instructions that arrive while the worker is down are not lost — they
 *     just wait for it to come back.
 *
 * Exit semantics of the child decide what we do:
 *   - code 0            → a clean signal-driven shutdown. We stop too.
 *   - non-zero / signal → a crash. Restart with backoff, guarded against a
 *                         tight crash-loop.
 *
 * Usage:
 *   node scripts/supervisor.js [--verbose] [--mock] ...   (args pass through)
 *   npm run start:supervised
 *
 * Zero dependencies, CommonJS — matches the project's server-side style.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const WORKER = path.join(__dirname, '..', 'server', 'index.js');
const passthroughArgs = process.argv.slice(2);

// ── Tunables ────────────────────────────────────────────────────────────────
const BACKOFF_BASE_MS = 500;     // first restart delay
const BACKOFF_MAX_MS  = 10_000;  // cap between restarts
const STABLE_MS       = 30_000;  // ran at least this long ⇒ reset backoff
const LOOP_WINDOW_MS  = 60_000;  // crash-loop detection window
const LOOP_MAX        = 5;       // ≥ this many crashes in the window ⇒ give up

let backoffMs = BACKOFF_BASE_MS;
let child = null;
let stopping = false;
const recentCrashes = []; // timestamps within LOOP_WINDOW_MS

function log(...a) { console.error('[supervisor]', ...a); }

function start() {
  const startedAt = Date.now();
  log(`Starting worker: node server/index.js ${passthroughArgs.join(' ')}`.trim());

  // stdin ignored ⇒ the worker runs as a pure server (it never acts as an MCP
  // stdio endpoint); stdout/stderr inherited so its logs surface as usual.
  child = spawn(process.execPath, [WORKER, ...passthroughArgs], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  child.on('exit', (code, signal) => {
    child = null;
    const ranMs = Date.now() - startedAt;

    if (stopping) { process.exit(code === null ? 0 : code); return; }

    // Clean exit (signal-driven shutdown returns 0) → we are done.
    if (code === 0) {
      log('Worker exited cleanly (code 0). Supervisor stopping.');
      process.exit(0);
    }

    log(`Worker crashed (code=${code}, signal=${signal}, ran ${(ranMs / 1000).toFixed(1)}s).`);

    // Crash-loop guard: too many crashes in a short window ⇒ stop spinning.
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length && now - recentCrashes[0] > LOOP_WINDOW_MS) recentCrashes.shift();
    if (recentCrashes.length >= LOOP_MAX) {
      log(`Crash loop: ${recentCrashes.length} crashes in ${LOOP_WINDOW_MS / 1000}s. Giving up — fix the worker, then restart the supervisor.`);
      process.exit(1);
    }

    // Reset backoff if the worker had been running stably before crashing.
    if (ranMs >= STABLE_MS) backoffMs = BACKOFF_BASE_MS;
    const delay = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);

    log(`Restarting in ${delay} ms...`);
    setTimeout(() => { if (!stopping) start(); }, delay);
  });

  child.on('error', (err) => {
    log(`Failed to spawn worker: ${err.message}`);
    // Treat as a crash so the backoff/loop-guard logic applies.
    if (child) { child = null; }
  });
}

// Forward termination to the child, then exit once it's gone.
function stop(signal) {
  if (stopping) return;
  stopping = true;
  log(`Received ${signal} — stopping worker...`);
  if (child) {
    try { child.kill(signal); } catch { /* already gone */ }
    // Safety net: force-exit if the child doesn't leave promptly.
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT',  () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

start();
