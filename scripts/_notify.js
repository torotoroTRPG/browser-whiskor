#!/usr/bin/env node
'use strict';
/**
 * scripts/_notify.js — portable, zero-dependency desktop notification.
 *
 * Invoked programmatically (hence the `_` prefix, like the other tooling
 * scripts). Used by the server's update-checker to surface "a new release is
 * out", and usable standalone:
 *
 *   node scripts/_notify.js "Title" "Message body"
 *
 * Best-effort per platform, and ALWAYS exits 0 — a notifier that can't pop a
 * toast (headless box, missing module, no D-Bus session) must never fail its
 * caller. Whenever a native mechanism is missing OR fails at runtime, the
 * message is printed to stderr instead, with the reason, so it's never lost.
 *
 *   Windows : PowerShell + BurntToast module if installed, else stderr
 *   macOS   : osascript `display notification`
 *   Linux   : notify-send if on PATH, else stderr
 */

const { spawnSync } = require('child_process');

const title = process.argv[2] || 'whiskor';
const message = process.argv[3] || '';

// Bound every native call — a hung osascript/PowerShell/notify-send must not
// stall a "best-effort" notifier (it runs on the server's startup path).
const TIMEOUT_MS = 5000;
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'ignore', timeout: TIMEOUT_MS, ...opts });

// stderr fallback — always reachable, carries the reason so a silently-dropped
// toast is at least traceable in the server log.
function fallback(reason) {
  process.stderr.write(`[notify] ${title}: ${message}${reason ? ` (${reason})` : ''}\n`);
}

// POSIX-only PATH probe (the sole caller is the Linux branch).
function have(cmd) {
  const probe = run('command', ['-v', cmd], { shell: true });
  return probe.status === 0;
}

try {
  if (process.platform === 'darwin') {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    const r = run('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
    if (r.error) fallback(r.error.code === 'ETIMEDOUT' ? 'osascript timed out' : r.error.message);
    else if (r.status !== 0) fallback('osascript failed');
  } else if (process.platform === 'linux') {
    if (!have('notify-send')) { fallback('notify-send not on PATH'); }
    else {
      const r = run('notify-send', [title, message]);
      // A present-but-failing notify-send (e.g. no D-Bus session on a headless
      // box) must still surface the message — this was the silent-drop gap.
      if (r.error) fallback(r.error.code === 'ETIMEDOUT' ? 'notify-send timed out' : r.error.message);
      else if (r.status !== 0) fallback('notify-send failed');
    }
  } else if (process.platform === 'win32') {
    // Single-quoted PS strings; escape embedded single quotes by doubling.
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = `if (Get-Module -ListAvailable -Name BurntToast) { ` +
      `Import-Module BurntToast; New-BurntToastNotification -Text '${q(title)}', '${q(message)}' } ` +
      `else { exit 3 }`;
    // Prefer PowerShell 7 (pwsh) — modules installed CurrentUser scope live under
    // Documents\PowerShell (pwsh) which Windows PowerShell 5.1 (powershell) can't
    // see, so BurntToast is typically only visible to pwsh. Fall back to 5.1.
    let done = false, lastReason = 'no PowerShell found';
    for (const exe of ['pwsh', 'powershell']) {
      const r = run(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      if (r.error && r.error.code === 'ENOENT') continue; // this shell not installed
      if (r.error) { lastReason = r.error.code === 'ETIMEDOUT' ? `${exe} timed out` : r.error.message; break; }
      if (r.status === 0) { done = true; break; }
      if (r.status === 3) { lastReason = 'BurntToast module not installed'; break; }
      lastReason = `${exe} exited ${r.status}`;
    }
    if (!done) fallback(lastReason);
  } else {
    fallback(`unsupported platform ${process.platform}`);
  }
} catch (e) {
  fallback(e && e.message);
}

process.exit(0);
