import { defineConfig } from 'vitest/config';

/**
 * Deterministic domain/storage unit tests plus the local integration suites.
 *
 * - tests/unit: no network, no browser, no model key.
 * - tests/integration: the owned demo storefront on ephemeral loopback ports, and a headless
 *   Chromium driven through the demo adapter. Still no model key and no third-party network.
 *   Browser tests set their own longer per-test timeouts; hookTimeout covers Chromium launch.
 *
 * The Fable suite runs separately (scripts/eval-fable.ts).
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
