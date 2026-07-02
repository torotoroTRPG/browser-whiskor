/**
 * server/update-checker.js
 *
 * Best-effort "is a newer release out?" check, run once at server startup.
 *
 * Source of truth is docs/version.json served by GitHub Pages (main:/docs) —
 * https://torotorotrpg.github.io/browser-whiskor/version.json. That file tracks
 * package.json via the `npm version` lifecycle (scripts/_check-version.js), so it
 * only ever names a stable release that landed on main; dev/preview builds cut
 * from a branch never touch it, which is exactly the "exclude previews" rule.
 *
 * This module NEVER throws and NEVER blocks startup: any network/parse failure
 * degrades to a null-ish result. It also does not, by itself, download or run
 * anything — notifyCommand / autoSetup are opt-in side effects the caller enables
 * via config. Actually downloading new code (selfUpdate) is a separate, larger
 * slice and intentionally not implemented here (see docs/ideas/SELF_UPDATE.md).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

// The bundled cross-platform notifier (scripts/_notify.js). Resolved by absolute
// path so it works regardless of the server's cwd.
const NOTIFY_SCRIPT = path.join(__dirname, '..', 'scripts', '_notify.js');

// Parse "1.2.3" / "v1.2.3" / "1.2.3-rc.1" → [1,2,3] (prerelease suffix dropped
// for the numeric comparison). Non-numeric parts become 0.
function parseVersion(v) {
  const core = String(v == null ? '' : v).trim().replace(/^v/i, '').split('-')[0].split('+')[0];
  const p = core.split('.');
  return [0, 1, 2].map(i => {
    const n = parseInt(p[i], 10);
    return Number.isFinite(n) ? n : 0;
  });
}

// -1 if a<b, 0 if equal, 1 if a>b (by MAJOR.MINOR.PATCH).
function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Fetch the published version and compare with the running one.
 * @returns {Promise<object>} always resolves:
 *   { ok:true, current, latest, updateAvailable, tag, url, checkedAt }
 *   { ok:false, reason, current, checkedAt }
 * fetchImpl is injectable for tests (defaults to the global fetch).
 */
async function checkForUpdate({ url, currentVersion, timeoutMs = 4000, fetchImpl } = {}) {
  const checkedAt = Date.now();
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!url)     return { ok: false, reason: 'no url configured', current: currentVersion, checkedAt };
  if (!doFetch) return { ok: false, reason: 'fetch unavailable (Node < 18?)', current: currentVersion, checkedAt };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, current: currentVersion, checkedAt };
    const data = await res.json();
    const latest = String((data && data.version) || '').trim();
    if (!latest) return { ok: false, reason: 'no version field in payload', current: currentVersion, checkedAt };
    return {
      ok: true,
      current: currentVersion,
      latest,
      updateAvailable: compareSemver(latest, currentVersion) > 0,
      tag: (data && data.tag) || `v${latest}`,
      url: (data && data.releaseUrl) || null,
      checkedAt,
    };
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? `timeout after ${timeoutMs}ms` : (e && e.message) || 'fetch failed';
    return { ok: false, reason, current: currentVersion, checkedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The placeholder values ({latest}/{tag}/{url}) come from a REMOTE JSON payload
// (docs/version.json on GitHub Pages: data.version / data.tag / data.releaseUrl).
// notifyCommand runs through `shell: true`, so any shell metacharacter smuggled
// into one of those fields — if that host were compromised or MITM'd — would be
// interpreted as part of the command (classic injection). Legitimate versions,
// tags, and release URLs never contain shell metacharacters, so we refuse to
// substitute a value that does. This keeps the freeform-command feature (the
// user still writes an arbitrary shell command) while denying the remote data
// any way to break out of the placeholder it was meant to fill.
const SHELL_UNSAFE = /[;&|`$(){}<>\\'"\n\r\t\0*?[\]!~\s]/;
function isShellSafeValue(v) {
  return typeof v === 'string' && v.length > 0 && !SHELL_UNSAFE.test(v);
}

// Run a user-configured notify command (config.updateCheck.notifyCommand — empty
// by default, meant to live in config.local.json). Placeholders {current}/{latest}
// /{tag}/{url} are substituted. Fire-and-forget via the shell; failures are
// swallowed (a broken personal toast must never disrupt the server).
function runNotifyCommand(command, ctx = {}, log = () => {}) {
  if (!command || typeof command !== 'string') return false;
  // A placeholder is only substituted if the command actually references it AND
  // the (remote-derived) value is shell-safe. If the command uses a placeholder
  // whose value is unsafe, we refuse to run the whole command rather than run a
  // partially-substituted (and possibly injected) one.
  const subs = { current: ctx.current, latest: ctx.latest, tag: ctx.tag, url: ctx.url };
  let filled = command;
  for (const [name, value] of Object.entries(subs)) {
    const token = `{${name}}`;
    if (!filled.includes(token)) continue;
    if (!isShellSafeValue(value)) {
      log('warn', `[update] notifyCommand skipped: {${name}} value is missing or contains shell metacharacters (${JSON.stringify(value)})`);
      return false;
    }
    filled = filled.split(token).join(value);
  }
  try {
    const child = spawn(filled, { shell: true, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// Fire the bundled cross-platform desktop notifier (scripts/_notify.js) with the
// current Node binary and an absolute script path — robust to cwd. Best-effort.
function runOsToast(ctx = {}) {
  try {
    const msg = `v${ctx.latest} available (you have v${ctx.current})`;
    const child = spawn(process.execPath, [NOTIFY_SCRIPT, 'browser-whiskor', msg],
      { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// autoSetup (opt-in): re-run `whk setup` so the LOCAL bundled extension files are
// re-synced into the managed dir and the running extension is asked to reload.
// NOTE: this does NOT download the new release — it propagates whatever code is
// already on disk. It is only useful after you have updated the code yourself
// (git pull / new bundle). Fire-and-forget; errors are logged by the caller path.
function runAutoSetup(command = 'whk setup --no-start') {
  try {
    const child = spawn(command, { shell: true, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Orchestrator used at startup. Reads config.updateCheck, runs the check, and
 * fires the (opt-in) side effects. Returns the check result so the caller can
 * store it for /health. `log` is (level, ...args).
 */
async function runUpdateCheck(updateCfg, currentVersion, log = () => {}) {
  const cfg = updateCfg || {};
  if (cfg.enabled === false) return { ok: false, reason: 'disabled', current: currentVersion };

  const result = await checkForUpdate({
    url: cfg.url,
    currentVersion,
    timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : 4000,
  });

  if (!result.ok) {
    log('info', `[update] check skipped: ${result.reason}`);
    return result;
  }
  if (!result.updateAvailable) {
    log('info', `[update] up to date (v${result.current})`);
    return result;
  }

  log('info', `[update] A newer release is available: v${result.latest} (you have v${result.current}). ${result.url || ''}`.trim());

  // Desktop notification: a custom notifyCommand overrides the bundled toast.
  if (cfg.notifyCommand) {
    if (runNotifyCommand(cfg.notifyCommand, result, log)) log('info', '[update] notifyCommand dispatched');
  } else if (cfg.osToast !== false) {
    runOsToast(result);
  }
  if (cfg.autoSetup === true) {
    log('info', '[update] autoSetup enabled — running setup to re-sync local files (does NOT download new code)');
    runAutoSetup(typeof cfg.autoSetup === 'string' ? cfg.autoSetup : undefined);
  }

  return result;
}

module.exports = {
  parseVersion, compareSemver, checkForUpdate,
  runNotifyCommand, runOsToast, runAutoSetup, runUpdateCheck,
};
