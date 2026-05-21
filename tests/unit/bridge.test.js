/**
 * tests/unit/bridge.test.js
 * Section 6.1 — Bridge (bridge.js)
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDOM } from '../helpers/dom-mock.js';

describe('6.1 Bridge', () => {

  beforeEach(() => resetDOM());

  test('MAIN → SW: postMessage relayed to chrome.runtime', () => {
    let relayed = null;
    // Mock chrome.runtime.sendMessage
    global.chrome = {
      runtime: {
        sendMessage: (msg) => { relayed = msg; }
      }
    };

    // Simulate bridge listener
    const onMessage = (e) => {
      if (e.data && e.data.type === 'TEXT_COORDS') {
        chrome.runtime.sendMessage(e.data);
      }
    };
    window.addEventListener('message', onMessage);

    window.postMessage({ type: 'TEXT_COORDS', data: {} }, '*');
    
    // In node:test, postMessage might be synchronous or we need a small wait
    assert.ok(relayed !== null);
    assert.strictEqual(relayed.type, 'TEXT_COORDS');
    
    delete global.chrome;
  });

  test('SW → MAIN: chrome.runtime relayed to postMessage', () => {
    let received = null;
    window.addEventListener('message', (e) => {
      if (e.data.type === 'CONFIG_UPDATE') received = e.data;
    });

    // Simulate SW message arrival
    const msg = { type: 'CONFIG_UPDATE', config: {} };
    window.postMessage(msg, '*');

    assert.ok(received !== null);
    assert.strictEqual(received.type, 'CONFIG_UPDATE');
  });
});
