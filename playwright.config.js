// playwright.config.js
// E2E test configuration for browser-whiskor
// Run with: npm run test:e2e

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    baseURL: 'http://localhost:7892',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // secret-guard enabled (via the nested env override) so the masking e2e can
    // verify screenshot redaction; the email pattern catches the test secret. Other
    // suites use no email-like text, so redaction does not affect them.
    command: process.platform === 'win32'
      ? 'powershell -Command "$env:WHISKOR_CACHE_DIR=\'tests/tmp/test-cache\'; $env:WHISKOR_PRIVACY_SECRETGUARD_ENABLED=\'true\'; node server/index.js"'
      : 'WHISKOR_CACHE_DIR=tests/tmp/test-cache WHISKOR_PRIVACY_SECRETGUARD_ENABLED=true node server/index.js',
    url: 'http://localhost:7892/health',
    reuseExistingServer: !process.env.CI,
  },
});
