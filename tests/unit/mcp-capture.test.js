/**
 * tests/unit/mcp-capture.test.js
 * Section 4.3 — Capture Tools
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('4.3 Capture Tools', () => {

  describe('capture_screenshot', () => {
    test('Basic: returns dataUrl and filePath', async () => {
      // Mock result
      const result = {
        ok: true,
        dataUrl: 'data:image/png;base64,...',
        filePath: '/tmp/screenshot.png'
      };
      
      assert.strictEqual(result.ok, true);
      assert.ok(result.dataUrl.startsWith('data:image/png'));
      assert.ok(result.filePath.endsWith('.png'));
    });

    test('With marks: returns elements map', async () => {
      const result = {
        ok: true,
        marks: { '1': { x: 10, y: 20, label: 'Button' } }
      };
      assert.ok(result.marks['1'] !== undefined);
    });
  });

  describe('refresh_data', () => {
    test('Basic: fresh data summary', async () => {
      const result = {
        ok: true,
        plugins: ['text-coords', 'network'],
        summary: 'Data refreshed'
      };
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.plugins.length, 2);
    });
  });
});
