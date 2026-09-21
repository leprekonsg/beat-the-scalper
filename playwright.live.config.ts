/**
 * Separate Playwright config for the gated live-retailer suite (tests/live). Never runs
 * under `npm run test:e2e` -- that command uses playwright.config.ts, whose testDir is
 * tests/e2e only, with its own globalSetup/teardown that boots the offline demo stack.
 * This config has no globalSetup/teardown: tests/live tests drive a real Playwright browser
 * against a live retailer page directly and each spec skips itself when required env vars
 * (a target URL, an approval note, an API key) are absent, exactly like scripts/lazada-*.ts.
 *
 *   npm run test:live:lazada
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/live',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results-live',
  timeout: 360_000,
  use: {
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
