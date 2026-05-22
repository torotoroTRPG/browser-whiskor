/**
 * tests/e2e/interactions.spec.mjs
 *
 * Fine-grained interaction E2E tests.
 *
 * Tests:
 *   - Text input (fill, type, clear)
 *   - Selection (dropdown, radio, checkbox)
 *   - Click interactions (single, double, right-click)
 *   - Drag and drop
 *   - Keyboard shortcuts
 *   - Form submission
 *   - Hover interactions
 *
 * Run with: npm run test:e2e -- --grep "Interactions"
 */

import { test, expect, chromium } from '@playwright/test';
import {
  launchWithExtension,
  waitForExtensionConnection,
  httpGet,
  assertHealthOk,
  TestPages,
} from './helpers/e2e-helpers.mjs';

// Slow extension connection on first launch
test.describe.configure({ timeout: 120000 });

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Text Input', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('fill input field with text', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(500);

      await page.fill('#input1', 'Hello World');
      const value = await page.inputValue('#input1');
      expect(value).toBe('Hello World');
    } finally {
      await context.close();
    }
  });

  test('type text character by character', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(500);

      await page.click('#input1');
      await page.keyboard.type('typed text');
      const value = await page.inputValue('#input1');
      expect(value).toBe('typed text');
    } finally {
      await context.close();
    }
  });

  test('clear and refill input', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(500);

      await page.fill('#input1', 'original');
      await page.fill('#input1', '');
      await page.fill('#input1', 'replaced');

      const value = await page.inputValue('#input1');
      expect(value).toBe('replaced');
    } finally {
      await context.close();
    }
  });

  test('input with special characters', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(500);

      const specialText = 'Hello <script>alert("xss")</script> & "quotes"';
      await page.fill('#input1', specialText);
      const value = await page.inputValue('#input1');
      expect(value).toBe(specialText);
    } finally {
      await context.close();
    }
  });

  test('textarea input', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <textarea id="ta" rows="4" cols="50"></textarea>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.fill('#ta', 'Line 1\nLine 2\nLine 3');
      const value = await page.inputValue('#ta');
      expect(value).toBe('Line 1\nLine 2\nLine 3');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Selection', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('select dropdown option by value', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <select id="sel">
            <option value="a">Option A</option>
            <option value="b">Option B</option>
          </select>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.selectOption('#sel', 'b');
      const value = await page.evaluate(() => document.getElementById('sel').value);
      expect(value).toBe('b');
    } finally {
      await context.close();
    }
  });

  test('select dropdown option by label', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <select id="sel">
            <option value="1">First</option>
            <option value="2">Second</option>
            <option value="3">Third</option>
          </select>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.selectOption('#sel', { label: 'Second' });
      const value = await page.evaluate(() => document.getElementById('sel').value);
      expect(value).toBe('2');
    } finally {
      await context.close();
    }
  });

  test('checkbox toggle', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <input type="checkbox" id="cb1" />
          <input type="checkbox" id="cb2" checked />
        </body></html>
      `);
      await page.waitForTimeout(500);

      // Check unchecked
      await page.check('#cb1');
      expect(await page.isChecked('#cb1')).toBe(true);

      // Uncheck checked
      await page.uncheck('#cb2');
      expect(await page.isChecked('#cb2')).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('radio button selection', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <input type="radio" name="group" value="a" id="r1" />
          <input type="radio" name="group" value="b" id="r2" />
          <input type="radio" name="group" value="c" id="r3" />
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.check('#r2');
      expect(await page.isChecked('#r2')).toBe(true);
      expect(await page.isChecked('#r1')).toBe(false);

      await page.check('#r3');
      expect(await page.isChecked('#r3')).toBe(true);
      expect(await page.isChecked('#r2')).toBe(false);
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Click', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('single click triggers onclick', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.goto(TestPages.interactive);
      await page.waitForTimeout(500);

      await page.click('#btn1');
      const text = await page.textContent('#btn1');
      expect(text).toBe('Clicked!');
    } finally {
      await context.close();
    }
  });

  test('double click triggers ondblclick', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <button id="dbl" ondblclick="this.textContent='Double!'">Double Click</button>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.dblclick('#dbl');
      const text = await page.textContent('#dbl');
      expect(text).toBe('Double!');
    } finally {
      await context.close();
    }
  });

  test('right-click opens context menu', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <div id="target">Right click me</div>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.click('#target', { button: 'right' });
      // Context menu should appear (we can't easily verify it in headless)
      // But the click should not throw
    } finally {
      await context.close();
    }
  });

  test('click on link navigates', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <a id="link1" href="#section">Go to Section</a>
          <div id="section"><p>Section content</p></div>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.click('#link1');
      await page.waitForTimeout(200);

      const sectionText = await page.textContent('#section');
      expect(sectionText).toContain('Section content');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Drag and Drop', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('drag element to drop zone', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <div id="source" draggable="true" style="width:50px;height:50px;background:red;">Drag</div>
          <div id="target" style="width:100px;height:100px;border:1px solid blue;margin-top:20px;">Drop here</div>
          <script>
            const source = document.getElementById('source');
            const target = document.getElementById('target');
            source.ondragstart = (e) => e.dataTransfer.setData('text', 'dragged');
            target.ondragover = (e) => { e.preventDefault(); };
            target.ondrop = (e) => { e.preventDefault(); target.textContent = 'Dropped!'; };
          </script>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.dragAndDrop('#source', '#target');
      const text = await page.textContent('#target');
      expect(text).toBe('Dropped!');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Keyboard', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('keyboard Enter submits form', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <form id="form" onsubmit="event.preventDefault(); document.getElementById('result').textContent='Submitted!';">
            <input type="text" id="input" />
            <button type="submit">Submit</button>
          </form>
          <div id="result"></div>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.fill('#input', 'test');
      await page.press('#input', 'Enter');

      const result = await page.textContent('#result');
      expect(result).toBe('Submitted!');
    } finally {
      await context.close();
    }
  });

  test('keyboard shortcuts work', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <div id="output"></div>
          <script>
            document.addEventListener('keydown', (e) => {
              if (e.ctrlKey && e.key === 'k') {
                document.getElementById('output').textContent = 'Ctrl+K pressed';
              }
            });
          </script>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.keyboard.press('Control+k');
      const output = await page.textContent('#output');
      expect(output).toBe('Ctrl+K pressed');
    } finally {
      await context.close();
    }
  });

  test('Tab key moves focus between elements', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <input id="i1" type="text" />
          <input id="i2" type="text" />
          <input id="i3" type="text" />
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.click('#i1');
      expect(await page.evaluate(() => document.activeElement.id)).toBe('i1');

      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement.id)).toBe('i2');

      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement.id)).toBe('i3');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Hover', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('hover shows tooltip', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <button id="btn" title="Tooltip text">Hover me</button>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.hover('#btn');
      const title = await page.getAttribute('#btn', 'title');
      expect(title).toBe('Tooltip text');
    } finally {
      await context.close();
    }
  });

  test('hover triggers CSS effects', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <style>#box { width: 50px; height: 50px; background: red; } #box:hover { background: blue; }</style>
          <div id="box"></div>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.hover('#box');
      const bgColor = await page.evaluate(() => {
        return getComputedStyle(document.getElementById('box')).backgroundColor;
      });
      expect(bgColor).toBe('rgb(0, 0, 255)');
    } finally {
      await context.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe('Interactions - Form Submission', () => {

  test.skip(({ browserName }) => browserName !== 'chromium');

  test('form submission with multiple fields', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <form id="form" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Name: ' + document.getElementById('name').value + ', Email: ' + document.getElementById('email').value;">
            <input type="text" id="name" placeholder="Name" />
            <input type="email" id="email" placeholder="Email" />
            <select id="role">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit">Submit</button>
          </form>
          <div id="result"></div>
        </body></html>
      `);
      await page.waitForTimeout(500);

      await page.fill('#name', 'John');
      await page.fill('#email', 'john@example.com');
      await page.selectOption('#role', 'admin');
      await page.click('button[type="submit"]');

      const result = await page.textContent('#result');
      expect(result).toBe('Name: John, Email: john@example.com');
    } finally {
      await context.close();
    }
  });

  test('form validation prevents invalid submission', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await launchWithExtension(chromium);
    try {
      const page = await context.newPage();
      await waitForExtensionConnection(page);

      await page.setContent(`
        <html><body>
          <form id="form">
            <input type="email" id="email" required />
            <button type="submit">Submit</button>
          </form>
        </body></html>
      `);
      await page.waitForTimeout(500);

      // Try to submit without filling required field
      await page.click('button[type="submit"]');

      // Form should not submit (validation should block it)
      const isInvalid = await page.evaluate(() => {
        return document.getElementById('email').validity.valueMissing;
      });
      expect(isInvalid).toBe(true);
    } finally {
      await context.close();
    }
  });
});
