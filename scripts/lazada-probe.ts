/**
 * Phase 0 step 4: ONE supervised, unauthenticated, read-only observation of a user-supplied Lazada URL.
 *
 * Runs exactly one navigation in a dedicated Playwright profile. No refresh loop, no login, no cart access.
 * Requires explicit per-run permission: pass --approved "<who/when>" or the script exits without network access.
 * Output: data/feasibility/lazada-probe-<timestamp>.json (redacted observed fields) and a PNG screenshot.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.slice(6);
const approvedIdx = args.indexOf('--approved');
const approvedBy = approvedIdx >= 0 ? args[approvedIdx + 1] : null;

if (!urlArg || !approvedBy) {
  console.error('Usage: tsx scripts/lazada-probe.ts --url=<lazada url> --approved "<who granted permission and when>"');
  console.error('This script performs live retailer access. It refuses to run without an explicit approval note.');
  process.exit(2);
}

const target = new URL(urlArg);
if (!/(^|\.)lazada\.sg$/.test(target.hostname)) {
  console.error(`Refusing: host ${target.hostname} is not a lazada.sg host`);
  process.exit(2);
}

const outDir = resolve(process.cwd(), 'data', 'feasibility');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profileDir = resolve(process.cwd(), 'data', '.browser-profiles', 'lazada-probe');

const result: Record<string, unknown> = {
  test: 'phase0_step4_single_observation',
  approvedBy,
  startedAt: new Date().toISOString(),
  requestedUrl: target.toString(),
  accessBasis: 'One unauthenticated page load of a user-supplied URL, approved by the user for this run only',
  status: 'not_attempted',
};

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1280, height: 900 },
  locale: 'en-SG',
  timezoneId: 'Asia/Singapore',
});
const page = context.pages()[0] ?? (await context.newPage());
const redirects: string[] = [];
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) redirects.push(f.url());
});

try {
  const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000); // allow client rendering; no reloads
  const finalUrl = page.url();
  const status = response?.status() ?? null;
  const title = await page.title();
  const bodyText = (await page.innerText('body').catch(() => '')).slice(0, 6000);
  const lower = bodyText.toLowerCase();

  const accessControl =
    /captcha|slide to verify|verify you are human|punish|unusual traffic/.test(lower) ? 'captcha_or_challenge'
    : /log in|login|sign in/.test(lower) && /password/.test(lower) ? 'login_wall'
    : status && status >= 400 ? `http_${status}`
    : 'none_detected';

  const probe = async (selectors: string[]): Promise<string | null> => {
    for (const s of selectors) {
      const loc = page.locator(s).first();
      if (await loc.count()) {
        const t = (await loc.innerText().catch(() => '')).trim();
        if (t) return t.slice(0, 200);
      }
    }
    return null;
  };

  const observed = {
    productTitle: await probe(['h1', '[class*="pdp-mod-product-badge-title"]', '[class*="title"]']),
    priceText: await probe(['[class*="pdp-price"]', '[class*="price"]']),
    sellerText: await probe(['[class*="seller-name"]', 'a[href*="/shop/"]']),
    addToCartControlPresent: (await page.getByRole('button', { name: /add to cart/i }).count()) > 0,
    buyNowControlPresent: (await page.getByRole('button', { name: /buy now/i }).count()) > 0,
    soldOutTextPresent: /sold out|out of stock/.test(lower),
    variantSelectorPresent: (await page.locator('[class*="sku"]').count()) > 0,
    retailerProductIdFromUrl: /-i(\d+)/.exec(finalUrl)?.[1] ?? null,
    skuIdFromUrl: /-s(\d+)/.exec(finalUrl)?.[1] ?? null,
  };

  const screenshotPath = resolve(outDir, `lazada-probe-${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  Object.assign(result, {
    status: accessControl === 'none_detected' && observed.productTitle ? 'passed_single_read' : 'inconclusive',
    httpStatus: status,
    finalUrl,
    redirectChain: redirects,
    title,
    accessControl,
    observed,
    sessionContinuity: 'not_tested (single load; no second request made)',
    screenshot: screenshotPath,
    bodyTextExcerpt: bodyText.slice(0, 1200),
    finishedAt: new Date().toISOString(),
  });
} catch (err) {
  Object.assign(result, { status: 'failed', error: String(err), finishedAt: new Date().toISOString() });
} finally {
  await context.close();
}

const jsonPath = resolve(outDir, `lazada-probe-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, bodyTextExcerpt: undefined }, null, 2));
console.log(`Saved ${jsonPath}`);
