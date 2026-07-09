/**
 * tests/unit/proxy-stability.test.js
 * MCP proxy stability hardening — pins for the four fixes from the 2026-07-08
 * field crash report ("parallel tool calls → Connection closed → Not connected").
 *
 * Root causes fixed:
 *  (1) embed worker stdout inherited by the parent → stray transformers/ORT
 *      output lands on the JSON-RPC channel and corrupts the stream,
 *  (2) EPIPE after the client closes the pipe → unhandledRejection → the whole
 *      proxy exits with code 1,
 *  (3) _requestOnce could hang forever (no timeout, no res error handler),
 *  (4) a crashed embed worker left its in-flight requests dangling.
 *
 * These are process-lifecycle behaviours (worker threads, pipes, exits), so
 * they are pinned at the source level rather than reproduced live.
 */
// @allow-no-prod-import: lifecycle/wiring pins — the behaviours under test are
// process-global (stdout error handlers, worker stdio inheritance, process.exit)
// and cannot run inside the test process without killing it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('proxy stability — embed worker stdio isolation', () => {
  const src = read('server/services/embed-worker-pool.js');

  it('spawns the worker with piped stdout/stderr (never the parent JSON-RPC channel)', () => {
    assert.match(src, /new Worker\(.*\{ stdout: true, stderr: true \}\)/);
  });

  it('forwards worker output to stderr, tagged', () => {
    assert.match(src, /_worker\.stdout\.on\('data'/);
    assert.match(src, /process\.stderr\.write\(`\[embed-worker\]/);
  });

  it('a crashed worker rejects its in-flight requests instead of dangling them', () => {
    const handleError = src.match(/function _handleError[\s\S]*?\n\}/)[0];
    assert.match(handleError, /_rejectAll\(/, '_handleError clears pending requests');
  });
});

describe('proxy stability — transport survives a closed client pipe', () => {
  const src = read('server/mcp/transport.js');

  it('installs a stdout error handler (EPIPE → clean exit, not unhandledRejection)', () => {
    assert.match(src, /process\.stdout\.on\('error'/);
    assert.match(src, /process\.exit\(0\)/);
  });

  it('guards every protocol write', () => {
    assert.match(src, /const writeMessage = /);
    assert.ok(!/for \(const m of messages\) process\.stdout\.write/.test(src),
      'raw stdout.write in the line loop was replaced by the guarded writer');
  });

  it('the line handler cannot leak a rejection', () => {
    const handler = src.match(/rl\.on\('line'[\s\S]*?\n  \}\);/)[0];
    assert.match(handler, /try \{/);
    assert.match(handler, /catch \(e\)/);
  });
});

describe('proxy stability — HTTP forward cannot hang forever', () => {
  const src = read('server/index.js');

  it('_requestOnce has a timeout that destroys the request with a retryable code', () => {
    assert.match(src, /REQUEST_ONCE_TIMEOUT_MS/);
    assert.match(src, /req\.setTimeout\(REQUEST_ONCE_TIMEOUT_MS/);
    assert.match(src, /err\.code = 'ETIMEDOUT'/);
  });

  it('response-stream errors are handled (no uncaught error event)', () => {
    const fn = src.match(/function _requestOnce[\s\S]*?\n\}/)[0];
    assert.match(fn, /res\.on\('error', reject\)/);
  });
});

describe('whk CLI — quoting-proof body input', () => {
  const src = read('server/cli.js');

  it('supports --file and stdin (-) body sources', () => {
    assert.match(src, /'--file'/);
    assert.match(src, /for await \(const chunk of process\.stdin\)/);
  });

  it('validates JSON before sending and points at --file on failure', () => {
    assert.match(src, /Body is not valid JSON/);
    assert.match(src, /--file body\.json/);
  });
});
