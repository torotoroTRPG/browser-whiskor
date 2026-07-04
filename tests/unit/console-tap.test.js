/**
 * tests/unit/console-tap.test.js
 * All-worlds console tap (CDP) — config default + wiring pins.
 *
 * The tap lives in extension/background/sw.js (service-worker code; cannot be
 * require()d in node), so beyond the real config.json/guard imports this pins
 * the load-bearing wiring statically: MAIN-world dedup, the shared CONSOLE_LOG
 * envelope, config plumbing, and the attachment-ownership guard that keeps an
 * input burst's idle-detach from tearing the tap down.
 */
// @allow-no-prod-import: config.json and the defaults guard are read/checked
// directly; the tap itself is service-worker source that node cannot import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('all-worlds console tap — public default', () => {
  const config = JSON.parse(read('config.json'));

  it('ships disabled (holds a debugger attachment + reads other extensions\' logs)', () => {
    assert.strictEqual(config.agentControl.console.captureAllWorlds, false);
  });

  it('is pinned by the config-defaults guard', () => {
    assert.match(read('scripts/_check-config-defaults.js'),
      /agentControl\.console\.captureAllWorlds/);
  });
});

describe('all-worlds console tap — sw.js wiring', () => {
  const sw = read('extension/background/sw.js');

  it('listens to the Runtime console/exception/context events', () => {
    for (const ev of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
                      'Runtime.executionContextCreated', 'Runtime.executionContextsCleared']) {
      assert.ok(sw.includes(ev), `handles ${ev}`);
    }
  });

  it('skips MAIN-world events (the console-logger analyzer owns them — no double reporting)', () => {
    assert.match(sw, /aux\.isDefault/);
    assert.match(sw, /let label = null;/);
  });

  it('skips whiskor\'s OWN isolated world (bridge relay chatter would drown the buffer)', () => {
    assert.match(sw, /chrome\.runtime\.getManifest\(\)\.name/);
    assert.match(sw, /chrome-extension:\/\/' \+ chrome\.runtime\.id/);
  });

  it('reuses the CONSOLE_LOG envelope (no new message type / server consumer)', () => {
    assert.match(sw, /type: 'CONSOLE_LOG', tabId,\s*\n?\s*payload: \{ capturedAt: Date\.now\(\), totalEntries: buf\.length, entries: buf \}/);
    // ...and the server side does consume that envelope.
    assert.match(read('server/cache-writer.js'), /case 'CONSOLE_LOG'/);
  });

  it('entries are tagged with world and via:cdp', () => {
    assert.match(sw, /world,\s*\n\s*via: 'cdp',/);
  });

  it('is configured from both SET_CONFIG paths (server push + panel)', () => {
    const n = (sw.match(/cdpConsoleTap\.configure\(msg\.config\)/g) || []).length;
    assert.strictEqual(n, 2, 'server SET_CONFIG handler and panel SET_CONFIG both configure the tap');
  });

  it('the server actually SHIPS agentControl.console in SET_CONFIG (shape parity)', () => {
    // The SW reads cfg.agentControl.console.captureAllWorlds, but SET_CONFIG sends
    // core.globalConfig — which historically carried only {mode, plugins, options}
    // and NO agentControl at all, so the tap (and the autoSwitchTab check) read a
    // key that never arrived. Live-found on ccfolia.com. This pins the producer
    // side of that contract.
    const idx = read('server/index.js');
    const at = idx.indexOf('initialConfig:');
    assert.ok(at >= 0, 'found the initialConfig block');
    const block = idx.slice(at, at + 1600); // the whole literal fits well within this window
    assert.match(block, /agentControl:/, 'initialConfig carries agentControl');
    assert.match(block, /captureAllWorlds/, 'initialConfig carries console.captureAllWorlds');
    assert.match(block, /autoSwitchTab/, 'initialConfig carries autoSwitchTab (same silent-drop fix)');
  });

  it('attaches lazily from the collector message hook and cleans up on tab close', () => {
    assert.match(sw, /cdpConsoleTap\.maybeStart\(senderTabId\)/);
    assert.match(sw, /cdpConsoleTap\.onDetached\(tabId\)/);
  });

  it('owns its attachment: the input path\'s idle-detach defers to the tap', () => {
    assert.match(sw, /if \(cdpConsoleTap\.holds\(tabId\)\) return;/);
  });
});

describe('all-worlds console tap — reader surface', () => {
  it('get_console_logs exposes the world filter', () => {
    const src = read('server/mcp/tools/read-data.js');
    assert.match(src, /world:\s*\{ type: 'string'/);
    assert.match(src, /entries\.filter\(e => !e\.world\)/, '"main" selects untagged page-world entries');
  });
});
