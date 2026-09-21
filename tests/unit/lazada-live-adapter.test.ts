/**
 * Deterministic tests for src/adapters/lazadaLive.ts. `classifyLazadaPage` and `parseSgdMinor` are
 * exercised as pure functions; `observeTarget` is exercised against a fake `LazadaLivePage` (same
 * pattern as tests/unit/gemini-computer-use.test.ts's fake ComputerUsePage). No Playwright browser
 * is launched and no network call is made anywhere in this file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyLazadaPage,
  LazadaLiveObservationAdapter,
  parseSgdMinor,
  type LazadaLiveLocator,
  type LazadaLivePage,
  type LazadaLiveResponse,
} from '../../src/adapters/lazadaLive.ts';
import { EvidenceSchema, ObservationSchema, type Evidence, type Observation } from '../../src/domain/types.ts';
import { makeIntent } from './builders.ts';

const LAZADA_URL = 'https://www.lazada.sg/products/pokemon-etb-i123456-s789.html';
const APPROVED_BY = 'test-harness 2026-09-19';

// ---------------------------------------------------------------------------------------------
// classifyLazadaPage
// ---------------------------------------------------------------------------------------------
describe('classifyLazadaPage', () => {
  it('classifies a challenge page as captcha regardless of status', () => {
    const r = classifyLazadaPage({ status: 200, bodyText: 'Please verify you are human before continuing', title: 'Lazada', retryAfter: null });
    expect(r.accessControl).toBe('captcha');
    expect(r.error).not.toBeNull();
  });

  it('classifies HTTP 429 with a numeric Retry-After as rate_limited', () => {
    const r = classifyLazadaPage({ status: 429, bodyText: 'Too many requests', title: null, retryAfter: '30' });
    expect(r.accessControl).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(30);
  });

  it('classifies HTTP 429 with no/non-numeric Retry-After as rate_limited with null retryAfterSeconds', () => {
    const r1 = classifyLazadaPage({ status: 429, bodyText: 'Too many requests', title: null, retryAfter: null });
    expect(r1.accessControl).toBe('rate_limited');
    expect(r1.retryAfterSeconds).toBeNull();
    const r2 = classifyLazadaPage({ status: 429, bodyText: 'Too many requests', title: null, retryAfter: 'soon' });
    expect(r2.retryAfterSeconds).toBeNull();
  });

  it('classifies a login wall as login_expired', () => {
    const r = classifyLazadaPage({ status: 200, bodyText: 'Please log in with your password to continue', title: null, retryAfter: null });
    expect(r.accessControl).toBe('login_expired');
  });

  it('classifies a generic HTTP 404 as accessControl none with an http_<status> error', () => {
    const r = classifyLazadaPage({ status: 404, bodyText: 'Page not found', title: null, retryAfter: null });
    expect(r.accessControl).toBe('none');
    expect(r.error).toBe('http_404');
  });

  it('classifies a missing product title as unsupported_layout', () => {
    const r = classifyLazadaPage({ status: 200, bodyText: 'Some unrelated page content', title: null, retryAfter: null });
    expect(r.accessControl).toBe('unsupported_layout');
  });

  it('classifies a clean page with a title and no access control text as ok (none / no error)', () => {
    const r = classifyLazadaPage({ status: 200, bodyText: 'Elite Trainer Box for sale', title: 'Pokemon Elite Trainer Box', retryAfter: null });
    expect(r.accessControl).toBe('none');
    expect(r.error).toBeNull();
  });

  it('does not treat a product page with a header "Login" link and a description mentioning a password as a login wall', () => {
    const body = 'Login | Sign Up | Help\nWiFi Router AX3000\nDefault admin password printed on the label. Change your password after setup.\nAdd to Cart';
    const withField = classifyLazadaPage({ status: 200, bodyText: body, title: 'WiFi Router AX3000', retryAfter: null, passwordFieldPresent: false });
    expect(withField.accessControl).toBe('none');
    expect(withField.error).toBeNull();
    const pureText = classifyLazadaPage({ status: 200, bodyText: body, title: 'WiFi Router AX3000', retryAfter: null });
    expect(pureText.accessControl).toBe('none');
  });

  it('classifies a login wall from a password input, and from wall-only wording when the field is unknown', () => {
    const viaField = classifyLazadaPage({ status: 200, bodyText: 'Login\nPhone Number or Email\nLOGIN', title: null, retryAfter: null, passwordFieldPresent: true });
    expect(viaField.accessControl).toBe('login_expired');
    const viaText = classifyLazadaPage({ status: 200, bodyText: 'Login\nPhone Number or Email\nForgot password?\nLOGIN', title: null, retryAfter: null });
    expect(viaText.accessControl).toBe('login_expired');
  });

  it('does not classify a product whose text contains "Punishment" as a challenge, but does classify a /punish URL', () => {
    const book = classifyLazadaPage({ status: 200, bodyText: 'Crime and Punishment (Penguin Classics) Add to Cart', title: 'Crime and Punishment', retryAfter: null });
    expect(book.accessControl).toBe('none');
    const punished = classifyLazadaPage({ status: 200, bodyText: '', title: null, retryAfter: null, finalUrl: 'https://www.lazada.sg/_____tmd_____/punish?x5secdata=abc' });
    expect(punished.accessControl).toBe('captcha');
  });

  it('challenge text beats a 429 (priority order), and an unsafe/negative/HTTP-date Retry-After becomes null', () => {
    expect(classifyLazadaPage({ status: 429, bodyText: 'Please slide to verify', title: null, retryAfter: '30' }).accessControl).toBe('captcha');
    expect(classifyLazadaPage({ status: 429, bodyText: '', title: null, retryAfter: '99999999999999999999' }).retryAfterSeconds).toBeNull();
    expect(classifyLazadaPage({ status: 429, bodyText: '', title: null, retryAfter: '-5' }).retryAfterSeconds).toBeNull();
    expect(classifyLazadaPage({ status: 429, bodyText: '', title: null, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }).retryAfterSeconds).toBeNull();
    expect(classifyLazadaPage({ status: 429, bodyText: '', title: null, retryAfter: '0' }).retryAfterSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// parseSgdMinor
// ---------------------------------------------------------------------------------------------
describe('parseSgdMinor', () => {
  it('parses "S$89.90" as 8990 minor units', () => {
    expect(parseSgdMinor('S$89.90')).toBe(8990);
  });
  it('parses "$1,299.00" (thousands separator) as 129900 minor units', () => {
    expect(parseSgdMinor('$1,299.00')).toBe(129900);
  });
  it('parses "From S$10" as 1000 (the first amount found is used; a range qualifier is not treated as ambiguous)', () => {
    expect(parseSgdMinor('From S$10')).toBe(1000);
  });
  it('returns null for an empty string', () => {
    expect(parseSgdMinor('')).toBeNull();
  });
  it('returns null for null input', () => {
    expect(parseSgdMinor(null)).toBeNull();
  });
  it('returns null when no amount is present at all', () => {
    expect(parseSgdMinor('Price on request')).toBeNull();
  });
  it('parses "S$1,299.00" as 129900 and "S$ 89.9" (space, one decimal) as 8990', () => {
    expect(parseSgdMinor('S$1,299.00')).toBe(129900);
    expect(parseSgdMinor('S$ 89.9')).toBe(8990);
  });
  it('uses the lower bound of a range "S$89.90 - S$120.00"', () => {
    expect(parseSgdMinor('S$89.90 - S$120.00')).toBe(8990);
  });
  it('returns null for a discount label with no amount ("10% off")', () => {
    expect(parseSgdMinor('10% off')).toBeNull();
  });
  it('never reports another dollar currency (US$, A$, HK$) or a non-dollar currency as SGD', () => {
    expect(parseSgdMinor('US$89.90')).toBeNull();
    expect(parseSgdMinor('A$50')).toBeNull();
    expect(parseSgdMinor('HK$120.00')).toBeNull();
    expect(parseSgdMinor('RM89.90')).toBeNull();
    expect(parseSgdMinor('USD 89.90')).toBeNull();
  });
  it('returns null rather than an unsafe integer for an absurd amount', () => {
    expect(parseSgdMinor('$99999999999999999999')).toBeNull();
  });
  it('returns null for "$.50" (no leading digit)', () => {
    expect(parseSgdMinor('$.50')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Fake LazadaLivePage
// ---------------------------------------------------------------------------------------------
function makeLocator(entries: { text?: string; href?: string }[]): LazadaLiveLocator {
  return {
    first(): LazadaLiveLocator {
      return makeLocator(entries.slice(0, 1));
    },
    async count(): Promise<number> {
      return entries.length;
    },
    async innerText(): Promise<string> {
      return entries[0]?.text ?? '';
    },
    async getAttribute(name: string): Promise<string | null> {
      if (name === 'href') return entries[0]?.href ?? null;
      return null;
    },
  };
}

interface FakePageConfig {
  status?: number | null;
  headers?: Record<string, string>;
  bodyText?: string;
  productTitle?: string | null;
  sellerText?: string | null;
  sellerHref?: string | null;
  priceText?: string | null;
  addToCart?: boolean;
  buyNow?: boolean;
  passwordField?: boolean;
  gotoError?: Error;
  /** Thrown from every `locator().count()` call, to exercise the post-navigation failure path. */
  locatorError?: Error;
  finalUrl?: string;
}

/** Every method the adapter may call on a loaded page; none of them navigates or interacts. */
const READ_ONLY_PAGE_METHODS = new Set(['url', 'title', 'innerText', 'locator', 'getByRole', 'screenshot', 'waitForTimeout']);

class FakeLazadaPage implements LazadaLivePage {
  gotoCount = 0;
  waits: number[] = [];
  screenshots: string[] = [];
  calls: string[] = [];
  currentUrl: string;

  constructor(private readonly cfg: FakePageConfig = {}) {
    this.currentUrl = cfg.finalUrl ?? LAZADA_URL;
  }

  async goto(): Promise<LazadaLiveResponse | null> {
    this.calls.push('goto');
    this.gotoCount += 1;
    if (this.cfg.gotoError) throw this.cfg.gotoError;
    const status = this.cfg.status ?? 200;
    const headers = this.cfg.headers ?? {};
    return { status: () => status, headers: () => headers };
  }

  url(): string {
    this.calls.push('url');
    return this.currentUrl;
  }

  async title(): Promise<string> {
    this.calls.push('title');
    return 'Lazada.sg | Online Shopping';
  }

  async innerText(selector: string): Promise<string> {
    this.calls.push('innerText');
    return selector === 'body' ? (this.cfg.bodyText ?? '') : '';
  }

  locator(selector: string): LazadaLiveLocator {
    this.calls.push('locator');
    if (this.cfg.locatorError) {
      const err = this.cfg.locatorError;
      const throwing: LazadaLiveLocator = {
        first: () => throwing,
        count: () => Promise.reject(err),
        innerText: () => Promise.reject(err),
        getAttribute: () => Promise.reject(err),
      };
      return throwing;
    }
    if (selector === 'input[type="password"]') {
      return this.cfg.passwordField ? makeLocator([{ text: '' }]) : makeLocator([]);
    }
    if (selector === 'h1' || selector.includes('pdp-mod-product-badge-title') || selector.includes('"title"')) {
      return this.cfg.productTitle ? makeLocator([{ text: this.cfg.productTitle }]) : makeLocator([]);
    }
    if (selector.includes('seller-name')) {
      return this.cfg.sellerText ? makeLocator([{ text: this.cfg.sellerText }]) : makeLocator([]);
    }
    if (selector.includes('/shop/')) {
      return this.cfg.sellerHref ? makeLocator([{ text: this.cfg.sellerText ?? '', href: this.cfg.sellerHref }]) : makeLocator([]);
    }
    if (selector.includes('pdp-price') || selector.includes('"price"')) {
      return this.cfg.priceText ? makeLocator([{ text: this.cfg.priceText }]) : makeLocator([]);
    }
    return makeLocator([]);
  }

  getByRole(_role: 'button', options?: { name?: RegExp | string }): LazadaLiveLocator {
    this.calls.push('getByRole');
    const src = options?.name instanceof RegExp ? options.name.source.toLowerCase() : String(options?.name ?? '').toLowerCase();
    if (src.includes('add to cart')) return this.cfg.addToCart ? makeLocator([{ text: 'Add to Cart' }]) : makeLocator([]);
    if (src.includes('buy now')) return this.cfg.buyNow ? makeLocator([{ text: 'Buy Now' }]) : makeLocator([]);
    return makeLocator([]);
  }

  async screenshot(options: { path: string }): Promise<unknown> {
    this.calls.push('screenshot');
    this.screenshots.push(options.path);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return undefined;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.calls.push('waitForTimeout');
    this.waits.push(ms);
  }
}

/** Exactly one navigation and nothing but read-only calls after it. */
function expectSingleReadOnlyNavigation(page: FakeLazadaPage): void {
  expect(page.calls.filter((c) => c === 'goto')).toHaveLength(1);
  expect(page.calls[0]).toBe('goto');
  for (const c of page.calls.slice(1)) expect(READ_ONLY_PAGE_METHODS.has(c), `unexpected page call ${c}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// observeTarget
// ---------------------------------------------------------------------------------------------
describe('LazadaLiveObservationAdapter', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function newDataDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'bts-lazada-live-'));
    tempDirs.push(d);
    return d;
  }

  const intent = makeIntent(
    { mode: 'lazada_assist', authority: 'observe' },
    {
      productUrl: LAZADA_URL,
      retailerProductId: '123456',
      variantId: '789',
      sellerRef: 'pokemon-store-online-singapore',
      productFormat: 'Elite Trainer Box',
      language: 'English',
    },
  );

  it('refuses construction with an empty approvedBy', () => {
    expect(() => new LazadaLiveObservationAdapter({ page: new FakeLazadaPage(), productUrl: LAZADA_URL, approvedBy: '   ' })).toThrow(/approvedBy/i);
  });

  it('refuses construction for a non-lazada.sg host', () => {
    expect(() => new LazadaLiveObservationAdapter({ page: new FakeLazadaPage(), productUrl: 'https://example.com/product', approvedBy: APPROVED_BY })).toThrow(/lazada\.sg/i);
  });

  it('reports AVAILABLE when an Add to Cart button is present and no sold-out text, and parses the offer', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Pokemon TCG Scarlet & Violet Elite Trainer Box (English)',
      sellerText: 'Pokemon Store Online Singapore',
      sellerHref: '/shop/pokemon-store-online-singapore',
      priceText: 'S$89.90',
      bodyText: 'Elite Trainer Box. Limit 2 per customer. Add to Cart is available.',
      addToCart: true,
    });
    let evidence: Evidence | null = null;
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => (evidence = e) });

    const obs: Observation = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });

    expect(page.gotoCount).toBe(1);
    expect(obs.accessControl).toBe('none');
    expect(obs.error).toBeNull();
    expect(obs.availability).toBe('AVAILABLE');
    expect(obs.offer?.title).toBe('Pokemon TCG Scarlet & Violet Elite Trainer Box (English)');
    expect(obs.offer?.sellerLabel).toBe('Pokemon Store Online Singapore');
    expect(obs.offer?.sellerRef).toBe('pokemon-store-online-singapore');
    expect(obs.offer?.itemPriceMinor).toBe(8990);
    expect(obs.offer?.retailerProductId).toBe('123456');
    expect(obs.offer?.variantId).toBe('789');
    expect(obs.offer?.productFormat).toBe('Elite Trainer Box');
    expect(obs.offer?.language).toBe('English');
    expect(obs.offer?.purchaseLimit).toBe(2);
    expect(obs.offer?.packagingCondition).toBe('unreadable'); // no removal/intact text stated
    expect(obs.provenance).toBe('live_verified');

    expect(evidence).not.toBeNull();
    expect(evidence!.snapshotRef).not.toBeNull();
    expect(existsSync(evidence!.snapshotRef!)).toBe(true);
    expect(readFileSync(evidence!.snapshotRef!).length).toBeGreaterThan(0);
    expect(typeof evidence!.observedFields.loadMs).toBe('number');
    expect(typeof evidence!.observedFields.parseMs).toBe('number');
  });

  it('reports UNAVAILABLE when sold-out text is present even if a button exists', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'This item is currently sold out.',
      addToCart: true,
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
  });

  it('reports UNKNOWN availability when neither a button nor sold-out text is present', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'Nothing conclusive here.' });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
  });

  it('reports packagingCondition stated_removed when the body text says the wrapping was removed', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Note: outer plastic wrap removed for quality inspection before shipping.',
      addToCart: true,
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.offer?.packagingCondition).toBe('stated_removed');
  });

  it('classifies a challenge page as captcha and never navigates a second time', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ bodyText: 'Please verify you are human to continue browsing.' });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.accessControl).toBe('captcha');
    expect(obs.offer).toBeNull();
    expect(obs.availability).toBe('UNKNOWN');
    expect(page.gotoCount).toBe(1);
  });

  it('never throws when navigation fails, and reports UNKNOWN with the error message', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ gotoError: new Error('net::ERR_CONNECTION_RESET') });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
    expect(obs.accessControl).toBe('none');
    expect(obs.error).toMatch(/ERR_CONNECTION_RESET/);
    expect(page.gotoCount).toBe(1);
  });

  it('never throws when a locator fails after navigation; reports UNKNOWN "Parse failed" without a second goto', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'ok', locatorError: new Error('Target page, context or browser has been closed') });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
    expect(obs.accessControl).toBe('none');
    expect(obs.error).toMatch(/^Parse failed: .*closed/);
    expect(obs.pageRevision).toBe('parse-error');
    expectSingleReadOnlyNavigation(page);
  });

  it('never throws when the onEvidence sink throws', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'ok', addToCart: true });
    const adapter = new LazadaLiveObservationAdapter({
      page,
      productUrl: LAZADA_URL,
      approvedBy: APPROVED_BY,
      dataDir,
      settleMs: 1,
      onEvidence: () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
    expect(obs.error).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // Misclassification pins
  // -------------------------------------------------------------------------------------------
  it('pins: a "Sold out" badge anywhere in the body (e.g. a recommended item) reads as UNAVAILABLE even with an Add to Cart button', async () => {
    // Documented cost in classify order (src/adapters/lazadaLive.ts): a stray badge is a missed
    // restock, never a false candidate. Change this test deliberately if the buy-box gets scoped.
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nAdd to Cart\nYou may also like\nBooster Bundle  Sold out\nPrism Tin  S$29.90',
      addToCart: true,
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
  });

  it('does not report login_expired for a product page whose header says Login and whose text mentions a password (no password field)', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'WiFi Router AX3000',
      bodyText: 'Login | Sign Up\nWiFi Router AX3000\nDefault admin password on the label.\nAdd to Cart',
      addToCart: true,
      passwordField: false,
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.accessControl).toBe('none');
    expect(obs.availability).toBe('AVAILABLE');
  });

  it('reports login_expired when a password input is on the page', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ productTitle: 'Login', bodyText: 'Login\nPhone Number or Email\nLOGIN', passwordField: true });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.accessControl).toBe('login_expired');
    expect(obs.offer).toBeNull();
    expectSingleReadOnlyNavigation(page);
  });

  it('never claims stated_intact from body text ("sealed" in a review or carousel is not a statement about this listing)', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'Review: arrived sealed and intact.\nYou may also like: Booster Box Factory Sealed', addToCart: true });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.offer?.packagingCondition).toBe('unreadable');
  });

  it('reads a purchase limit only from purchase wording, not from "Limited 1 year warranty"', async () => {
    const dataDir = newDataDir();
    const warranty = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'Limited 1 year warranty. Limited time offer.', addToCart: true });
    const a = new LazadaLiveObservationAdapter({ page: warranty, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    expect((await a.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' })).offer?.purchaseLimit).toBeNull();
    const limited = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'Limited to 3 pcs per order.', addToCart: true });
    const b = new LazadaLiveObservationAdapter({ page: limited, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    expect((await b.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' })).offer?.purchaseLimit).toBe(3);
  });

  // -------------------------------------------------------------------------------------------
  // Schema coverage: every classification branch yields Observation/Evidence that re-parse, after
  // exactly one navigation and only read-only page calls.
  // -------------------------------------------------------------------------------------------
  const BRANCHES: { name: string; cfg: FakePageConfig; accessControl: Observation['accessControl']; availability: Observation['availability']; errorRe: RegExp | null }[] = [
    { name: 'navigation failure', cfg: { gotoError: new Error('net::ERR_TIMED_OUT') }, accessControl: 'none', availability: 'UNKNOWN', errorRe: /^Navigation failed/ },
    { name: 'parse failure', cfg: { productTitle: 'x', locatorError: new Error('closed') }, accessControl: 'none', availability: 'UNKNOWN', errorRe: /^Parse failed/ },
    { name: 'captcha', cfg: { bodyText: 'Please slide to verify' }, accessControl: 'captcha', availability: 'UNKNOWN', errorRe: /CAPTCHA/ },
    { name: 'captcha by URL', cfg: { finalUrl: 'https://www.lazada.sg/_____tmd_____/punish?x5secdata=1' }, accessControl: 'captcha', availability: 'UNKNOWN', errorRe: /CAPTCHA/ },
    { name: 'rate_limited with unsafe Retry-After', cfg: { status: 429, headers: { 'retry-after': '99999999999999999999' } }, accessControl: 'rate_limited', availability: 'UNKNOWN', errorRe: /429/ },
    { name: 'rate_limited with Retry-After 45', cfg: { status: 429, headers: { 'retry-after': '45' } }, accessControl: 'rate_limited', availability: 'UNKNOWN', errorRe: /429/ },
    { name: 'login_expired', cfg: { bodyText: 'Login\nForgot password?', passwordField: true }, accessControl: 'login_expired', availability: 'UNKNOWN', errorRe: /Login wall/ },
    { name: 'http_503', cfg: { status: 503, productTitle: 'Service Unavailable' }, accessControl: 'none', availability: 'UNKNOWN', errorRe: /^http_503$/ },
    { name: 'unsupported_layout', cfg: { bodyText: 'Some page' }, accessControl: 'unsupported_layout', availability: 'UNKNOWN', errorRe: /unsupported layout/ },
    { name: 'clean AVAILABLE', cfg: { productTitle: 'Elite Trainer Box', bodyText: 'ok', priceText: 'S$89.90', buyNow: true }, accessControl: 'none', availability: 'AVAILABLE', errorRe: null },
    { name: 'clean UNAVAILABLE', cfg: { productTitle: 'Elite Trainer Box', bodyText: 'Out of stock', priceText: 'US$89.90' }, accessControl: 'none', availability: 'UNAVAILABLE', errorRe: null },
    { name: 'clean UNKNOWN', cfg: { productTitle: 'Elite Trainer Box', bodyText: 'ok', priceText: '$99999999999999999999' }, accessControl: 'none', availability: 'UNKNOWN', errorRe: null },
  ];

  for (const branch of BRANCHES) {
    it(`schema: ${branch.name} passes ObservationSchema/EvidenceSchema after one read-only navigation`, async () => {
      const dataDir = newDataDir();
      const page = new FakeLazadaPage(branch.cfg);
      const evidences: Evidence[] = [];
      const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
      const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });

      expect(() => ObservationSchema.parse(obs)).not.toThrow();
      expect(evidences).toHaveLength(1);
      expect(() => EvidenceSchema.parse(evidences[0])).not.toThrow();
      expect(evidences[0]!.evidenceId).toBe(obs.evidenceId);
      expect(obs.accessControl).toBe(branch.accessControl);
      expect(obs.availability).toBe(branch.availability);
      if (branch.errorRe) expect(obs.error).toMatch(branch.errorRe);
      else expect(obs.error).toBeNull();
      if (branch.name === 'rate_limited with Retry-After 45') expect(obs.retryAfterSeconds).toBe(45);
      if (branch.name === 'rate_limited with unsafe Retry-After') expect(obs.retryAfterSeconds).toBeNull();
      if (branch.name === 'clean UNAVAILABLE') expect(obs.offer?.itemPriceMinor).toBeNull(); // US$ is not SGD
      if (branch.name === 'clean UNKNOWN') expect(obs.offer?.itemPriceMinor).toBeNull(); // unsafe int
      expectSingleReadOnlyNavigation(page);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Evidence hygiene
  // -------------------------------------------------------------------------------------------
  it('evidence observedFields never carry the full body text, and redact email addresses from the excerpt', async () => {
    const dataDir = newDataDir();
    const filler = 'Elite Trainer Box description line. '.repeat(400); // >6000 chars
    const bodyText = `Hello, shopper.name.2021@example.com | Login\n${filler}`;
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText, addToCart: true });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
    await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });

    const fields = evidences[0]!.observedFields;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'string') continue;
      expect(v.length, `observedFields.${k} too long`).toBeLessThanOrEqual(1200);
      expect(v, `observedFields.${k} contains an email address`).not.toMatch(/@example\.com/);
      expect(v).not.toBe(bodyText);
    }
    expect(String(fields.bodyTextExcerpt)).toContain('[email]');
    expect(fields).not.toHaveProperty('approvedBy');
    expect(JSON.stringify(fields)).not.toContain(APPROVED_BY);
  });
});
