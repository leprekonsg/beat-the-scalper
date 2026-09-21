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
// --dom-diagnostic: same single load, plus a read-only DOM map of the product panel (container ids,
// ancestor chains of the stock line / h1 / wishlist button, and the time each landmark took to
// become visible) so src/adapters/lazadaLive.ts's BUY_BOX_SELECTORS can be corrected from evidence.
const domDiagnostic = args.includes('--dom-diagnostic');
const profileArg = args.find((a) => a.startsWith('--profile='))?.slice(10);

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
const profileDir = resolve(process.cwd(), 'data', '.browser-profiles', profileArg ?? 'lazada-probe');

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
  // Landmark readiness timeline (read-only waits, started together right after goto): how long after
  // domcontentloaded each region becomes visible. Runs alongside the fixed wait below, never in place of it.
  const landmarkTimeline: Record<string, number | null> = {};
  const landmarkWaits = domDiagnostic
    ? Object.entries({
        add_to_cart_module: '#module_add_to_cart',
        stock_text: 'text=/out of stock|sold out/i',
        price: '[class*="pdp-price"]',
        h1: 'h1',
        add_to_cart_button: 'button:has-text("Add to Cart")',
        wishlist_button: 'button:has-text("Add to Wishlist")',
      }).map(async ([key, sel]) => {
        const t0 = performance.now();
        try {
          await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
          landmarkTimeline[key] = Math.round(performance.now() - t0);
        } catch {
          landmarkTimeline[key] = null;
        }
      })
    : [];
  await page.waitForTimeout(4000); // allow client rendering; no reloads
  await Promise.all(landmarkWaits);
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

  // Read-only DOM map. `page.evaluate` only reads the live document; nothing is clicked or changed.
  const redact = (t: string) => t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  // Passed as a source string, not a function: tsx/esbuild rewrites named arrow functions with a
  // `__name` helper that does not exist inside the page, so a function literal throws
  // "ReferenceError: __name is not defined" at evaluate time (observed 2026-09-21).
  const DOM_MAP_SCRIPT = String.raw`(() => {
    const describe = (el) => {
      if (!el) return '';
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
      return el.tagName.toLowerCase() + id + cls;
    };
    const chain = (el, depth = 10) => {
      const out = [];
      for (let cur = el; cur && out.length < depth; cur = cur.parentElement) out.push(describe(cur));
      return out;
    };
    const textOf = (el, n = 160) => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const findText = (re) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (re.test(node.textContent || '')) return node.parentElement;
      }
      return null;
    };
    const stockEl = findText(/out of stock|sold out/i);
    const wishlist = Array.from(document.querySelectorAll('button')).find((b) => /add to wishlist/i.test(b.innerText)) || null;
    const modules = Array.from(document.querySelectorAll('[id^="module_"]')).map((el) => ({ id: el.id, tag: el.tagName.toLowerCase(), text: textOf(el, 120) }));
    const candidates = ['#module_add_to_cart', '[class*="pdp-cart-concern"]', '[class*="pdp-mod-product-info"]', '#module_product_detail', '[class*="pdp-block__product-detail"]'].map((sel) => {
      const el = document.querySelector(sel);
      return { sel, count: document.querySelectorAll(sel).length, describe: describe(el), text: textOf(el, 300) };
    });
    return {
      stockLine: { describe: describe(stockEl), text: textOf(stockEl, 80), ancestors: chain(stockEl) },
      h1: { ancestors: chain(document.querySelector('h1')) },
      wishlistButton: { ancestors: chain(wishlist) },
      modules,
      candidates,
      bodyTextLength: document.body.innerText.length,
      stockTextIndexInBody: document.body.innerText.search(/out of stock|sold out/i),
    };
  })()`;
  const domMap = domDiagnostic ? ((await page.evaluate(DOM_MAP_SCRIPT)) as Record<string, unknown>) : null;
  const domMapRedacted = domMap ? JSON.parse(redact(JSON.stringify(domMap))) : null;

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
    ...(domDiagnostic ? { landmarkTimeline, domMap: domMapRedacted } : {}),
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
