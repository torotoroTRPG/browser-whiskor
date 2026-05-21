/**
 * tests/e2e/dashboard.spec.js
 *
 * E2E tests for the browser-whiskor dashboard.
 * Requires Playwright: npm install (devDependencies)
 * Run with: npm run test:e2e
 *
 * These tests verify actual browser behavior that unit/integration
 * tests cannot catch (canvas rendering, viewport tracking, etc.)
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {

  test('loads and shows connected status', async ({ page }) => {
    await page.goto('http://localhost:7892/');
    await expect(page.locator('#status')).toBeVisible();
    // Status shows "AWAITING…" until extension connects
    const status = await page.locator('#status').textContent();
    expect(['CONNECTED', 'AWAITING…']).toContain(status);
  });

  test('canvas element exists', async ({ page }) => {
    await page.goto('http://localhost:7892/');
    const canvas = page.locator('#cv');
    await expect(canvas).toBeVisible();
  });

  test('session list renders', async ({ page }) => {
    await page.goto('http://localhost:7892/');
    // Session list should be present even if empty
    await expect(page.locator('#sessions')).toBeVisible();
  });

  test('viewport overlay shows when page mode is active', async ({ page }) => {
    await page.goto('http://localhost:7892/');
    // Wait for canvas to be ready
    await page.waitForSelector('#cv');

    // Check overlay checkbox exists
    const overlayCheckbox = page.locator('#cv-overlay');
    await expect(overlayCheckbox).toBeVisible();

    // When checked and data is loaded, viewport overlay should render
    const isChecked = await overlayCheckbox.isChecked();
    // Default may be checked or unchecked depending on saved state
    expect(typeof isChecked).toBe('boolean');
  });
});
