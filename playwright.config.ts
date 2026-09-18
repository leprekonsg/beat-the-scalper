/**
 * Browser end-to-end suite for the BTS dashboard.
 *
 *   npm run test:e2e
 *
 * globalSetup boots the same stack scripts/capture-ui.ts boots: the owned demo storefront, the local
 * API, and Vite, all against a throwaway BTS_DATA_DIR with a virtual clock pinned to 12:58 SGT.
 * Nothing here touches a real retailer and no real-money path exists in the build under test.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // One stack, one mission at a time: the API enforces a single active mission, so the suite is serial.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
