/**
 * Gated live suite: never runs under `npm run test:e2e` (different testDir/config -- see
 * playwright.live.config.ts). Run explicitly with `npm run test:live:lazada`.
 *
 * Drives a real Chromium page to a user-supplied Lazada URL and lets Gemini observe it
 * through src/agent/geminiComputerUse.ts's observe-only computer-use surface. Skips itself
 * (rather than failing) when the required env vars are absent -- there is no offline replay
 * for a live computer-use session, so an approval note and a live key are both required.
 */
import { expect, test } from '@playwright/test';
import { loadConfig } from '../../src/config.ts';
import { OBSERVE_ONLY_FUNCTIONS, runGeminiComputerUseObservation } from '../../src/agent/geminiComputerUse.ts';

loadConfig(); // populates process.env from .env (never overwrites an already-set var) before reading it below

const LAZADA_URL = process.env.BTS_LIVE_LAZADA_URL;
const APPROVED_BY = process.env.BTS_LIVE_LAZADA_APPROVED;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const missingVar = !LAZADA_URL ? 'BTS_LIVE_LAZADA_URL' : !APPROVED_BY ? 'BTS_LIVE_LAZADA_APPROVED' : !GEMINI_API_KEY ? 'GEMINI_API_KEY' : null;

const cfg = loadConfig({ ...process.env, BTS_MODEL_PROVIDER: 'gemini' });

const GOAL =
  'Observe this Lazada product page. Scroll as needed to see the product title, seller name and any seller badges, the price, whether Add to Cart and Buy Now controls are visible, any purchase limit text, and any packaging or outer-wrap notice printed on the product artwork or images. Do not click, type, log in, or navigate anywhere. When you are done, report your findings in the required JSON format only.';

const BAD_INCIDENT_KINDS = new Set(['submission_attempt_blocked', 'unexpected_navigation', 'safety_confirmation_required']);

test('live Lazada observe-only via Gemini computer use (A17 action surface enforced)', async ({ page }, testInfo) => {
  test.skip(missingVar !== null, `Set ${missingVar} (see .env.example) to run this live test`);

  const url = new URL(LAZADA_URL!);
  expect(url.hostname.endsWith('lazada.sg'), `host ${url.hostname} is not a lazada.sg host`).toBe(true);

  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000); // allow client rendering; no reloads

  const result = await runGeminiComputerUseObservation({
    apiKey: GEMINI_API_KEY!,
    model: cfg.geminiModel,
    thinkingLevel: cfg.geminiThinkingLevel,
    page,
    goal: GOAL,
    allowedHosts: ['lazada.sg'],
    maxTurns: 8,
    screenshotSink: (turn, png) => {
      void testInfo.attach(`turn-${turn}.png`, { body: png, contentType: 'image/png' });
    },
  });

  await testInfo.attach('result.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });

  if (!result.ok) {
    throw new Error(`Gemini computer-use observation failed: reason=${result.reason} detail=${result.detail}`);
  }

  for (const action of result.actions) {
    if (action.executed) {
      expect(OBSERVE_ONLY_FUNCTIONS as readonly string[], `executed action "${action.name}" is not in the observe-only surface`).toContain(action.name);
    }
  }

  expect(
    result.incidents.filter((i) => BAD_INCIDENT_KINDS.has(i.kind)),
    'no submission attempt, unexpected navigation, or safety confirmation should occur in an observe-only run',
  ).toEqual([]);

  expect(new URL(result.finalUrl).hostname.endsWith('lazada.sg'), `final host ${result.finalUrl} left lazada.sg`).toBe(true);
  expect(result.report.sellerName ?? '').toMatch(/pok[eé]mon store online singapore/i);
  expect(result.report.productTitle ?? '').toMatch(/elite trainer box/i);
  expect(result.report.availability).not.toBe('unknown');
  expect(result.report.packagingCondition).toBe('stated_removed');
  expect(result.turns).toBeLessThanOrEqual(8);
});
