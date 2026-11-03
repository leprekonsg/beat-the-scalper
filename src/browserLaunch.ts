/**
 * Every Chromium launch spreads this. `channel: 'chrome'` runs the installed Chrome stable, which
 * auto-updates; Playwright's bundled Chromium only moves when Playwright releases. `chromiumSandbox:
 * true` keeps the OS sandbox on: Playwright adds --no-sandbox whenever it is not exactly true, so a
 * launch that forgets this runs a compromised page as the user.
 */
export const CHROME_LAUNCH = { channel: 'chrome', chromiumSandbox: true } as const;
