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
  BUY_BOX_SELECTORS,
  classifyLazadaPage,
  DECISIVE_STATE_SELECTOR,
  LazadaLiveObservationAdapter,
  parseSgdMinor,
  SOLD_OUT_STATE_SELECTOR,
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
  it('returns null for "From S$10" (a range minimum is not the selected variant\'s exact price)', () => {
    expect(parseSgdMinor('From S$10')).toBeNull();
    expect(parseSgdMinor('from $10.00')).toBeNull();
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
  it('returns null for a range "S$89.90 - S$120.00" (two amounts means the selection is unresolved)', () => {
    expect(parseSgdMinor('S$89.90 - S$120.00')).toBeNull();
    expect(parseSgdMinor('$89.90-$120.00')).toBeNull();
  });
  it('still parses a single exact amount that is followed by a struck-through or unrelated non-SGD amount', () => {
    expect(parseSgdMinor('$109.90 US$80.00')).toBe(10990);
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
/** Entries additionally carry `attrs` (by `getAttribute` name) so button-enabled checks can be exercised. */
function makeLocator(entries: { text?: string; href?: string; attrs?: Record<string, string | null> }[]): LazadaLiveLocator {
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
      const e = entries[0];
      if (!e) return null;
      if (e.attrs && name in e.attrs) return e.attrs[name] ?? null;
      if (name === 'href') return e.href ?? null;
      return null;
    },
    // Leaf locators in these tests (title/seller/price/button) never need children of their own;
    // the buy-box locator below overrides these two with real behaviour.
    locator(): LazadaLiveLocator {
      return makeLocator([]);
    },
    getByRole(): LazadaLiveLocator {
      return makeLocator([]);
    },
  };
}

interface ButtonSpec {
  /** `disabled` attribute present. */
  disabled?: boolean;
  /** `aria-disabled="true"`. */
  ariaDisabled?: boolean;
  /** class attribute contains the substring "disabled". */
  disabledClass?: boolean;
}

function makeButtonLocator(spec: ButtonSpec | false | undefined, label: string): LazadaLiveLocator {
  if (!spec) return makeLocator([]);
  return makeLocator([
    {
      text: label,
      attrs: {
        disabled: spec.disabled ? '' : null,
        'aria-disabled': spec.ariaDisabled ? 'true' : null,
        class: spec.disabledClass ? 'btn btn-disabled' : 'btn',
      },
    },
  ]);
}

interface BuyBoxSpec {
  /** Buy box's own overall innerText; used for stock only when `#module_quantity-input` is absent. */
  text: string;
  /** `#module_quantity-input`'s own innerText. When set, that module "exists" (count > 0) and its
   *  text is used for stock instead of `text`; when unset, the module is absent and `text` is used. */
  quantityText?: string;
  /** Whether `#module_add_to_cart` exists as a distinct module scoping button lookups (mirrors the
   *  verified DOM: buttons always live under this module in practice, but the adapter falls back to
   *  the buy box itself when it is absent). */
  addToCartModule?: boolean;
  addToCart?: ButtonSpec | false;
  buyNow?: ButtonSpec | false;
  /** `#module_product_price_v2`'s own innerText. */
  priceText?: string;
  /** A `[class*="pdp-price"]` fallback element's innerText, used only when `priceText` is absent. */
  priceFallbackText?: string;
}

/** The buy-box selector these fakes use to stand in for whichever `BUY_BOX_SELECTORS` candidate matched. */
const FAKE_BUY_BOX_SELECTOR = BUY_BOX_SELECTORS[0]!;

/** Same regex as `SOLD_OUT_RE` in the adapter (not exported); used only to drive the fake's readiness wait. */
const FAKE_SOLD_OUT_RE = /sold out|out of stock/i;

function resolveBuyBoxButton(spec: BuyBoxSpec, options?: { name?: RegExp | string }): LazadaLiveLocator {
  const src = options?.name instanceof RegExp ? options.name.source.toLowerCase() : String(options?.name ?? '').toLowerCase();
  if (src.includes('add to cart')) return makeButtonLocator(spec.addToCart, 'Add to Cart');
  if (src.includes('buy now')) return makeButtonLocator(spec.buyNow, 'Buy Now');
  return makeLocator([]);
}

/** Stands in for `#module_add_to_cart` when `spec.addToCartModule` is true: same buttons, scoped. */
function makeAddToCartModuleLocator(spec: BuyBoxSpec): LazadaLiveLocator {
  const moduleLocator: LazadaLiveLocator = {
    first: () => moduleLocator,
    count: async () => 1,
    innerText: async () => '',
    getAttribute: async () => null,
    locator: () => makeLocator([]),
    getByRole: (_role, options) => resolveBuyBoxButton(spec, options),
  };
  return moduleLocator;
}

function makeBuyBoxLocator(spec: BuyBoxSpec): LazadaLiveLocator {
  const buyBoxLocator: LazadaLiveLocator = {
    // `.first()` must keep the buy-box behaviour (locator/button/price lookup), not fall back to a
    // plain leaf locator -- `findBuyBox` calls `.locator(selector).first()` before using the result.
    first(): LazadaLiveLocator {
      return buyBoxLocator;
    },
    async count(): Promise<number> {
      return 1;
    },
    async innerText(): Promise<string> {
      return spec.text;
    },
    async getAttribute(): Promise<string | null> {
      return null;
    },
    locator(selector: string): LazadaLiveLocator {
      if (selector === '#module_quantity-input') {
        return spec.quantityText !== undefined ? makeLocator([{ text: spec.quantityText }]) : makeLocator([]);
      }
      if (selector === '#module_product_price_v2') {
        return spec.priceText !== undefined ? makeLocator([{ text: spec.priceText }]) : makeLocator([]);
      }
      if (selector.includes('pdp-price')) {
        return spec.priceFallbackText !== undefined ? makeLocator([{ text: spec.priceFallbackText }]) : makeLocator([]);
      }
      if (selector === '#module_add_to_cart') {
        return spec.addToCartModule ? makeAddToCartModuleLocator(spec) : makeLocator([]);
      }
      return makeLocator([]);
    },
    getByRole(_role: 'button', options?: { name?: RegExp | string }): LazadaLiveLocator {
      return resolveBuyBoxButton(spec, options);
    },
  };
  return buyBoxLocator;
}

interface FakePageConfig {
  status?: number | null;
  headers?: Record<string, string>;
  bodyText?: string;
  productTitle?: string | null;
  sellerText?: string | null;
  sellerHref?: string | null;
  addToCart?: boolean;
  buyNow?: boolean;
  passwordField?: boolean;
  gotoError?: Error;
  /** Thrown from every `locator().count()` call, to exercise the post-navigation failure path. */
  locatorError?: Error;
  finalUrl?: string;
  /** When set, `FAKE_BUY_BOX_SELECTOR` (one of `BUY_BOX_SELECTORS`) resolves to this scoped buy box. */
  buyBox?: BuyBoxSpec;
  /**
   * Forces `waitForSelector` to reject even though `buyBox` already has decisive content (sold-out
   * text or a purchase button) -- simulates a page that only reaches the decisive state after the
   * deadline, to test that a readiness timeout still parses the (already loaded) page correctly.
   */
  decisiveAfterTimeout?: boolean;
  /**
   * The buy box the page settles into once the adapter starts waiting for a sold-out line: models a
   * page whose purchase buttons render before its stock line (the race `purchaseConfirmMs` guards).
   */
  lateBuyBox?: BuyBoxSpec;
  /** `meta[property="og:image"]` content; absent when unset. */
  ogImage?: string;
}

/** Every method the adapter may call on a loaded page; none of them navigates or interacts. */
const READ_ONLY_PAGE_METHODS = new Set(['url', 'title', 'innerText', 'locator', 'getByRole', 'screenshot', 'waitForTimeout', 'waitForSelector']);

class FakeLazadaPage implements LazadaLivePage {
  gotoCount = 0;
  waits: number[] = [];
  screenshots: string[] = [];
  calls: string[] = [];
  waitForSelectorArgs: string[] = [];
  currentUrl: string;
  private buyBoxState: BuyBoxSpec | undefined;

  constructor(private readonly cfg: FakePageConfig = {}) {
    this.currentUrl = cfg.finalUrl ?? LAZADA_URL;
    this.buyBoxState = cfg.buyBox;
  }

  private soldOutShown(): boolean {
    const bb = this.buyBoxState;
    return !!bb && FAKE_SOLD_OUT_RE.test(bb.quantityText ?? bb.text);
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
        locator: () => throwing,
        getByRole: () => throwing,
      };
      return throwing;
    }
    if (this.buyBoxState && selector === FAKE_BUY_BOX_SELECTOR) {
      return makeBuyBoxLocator(this.buyBoxState);
    }
    if (selector === SOLD_OUT_STATE_SELECTOR) {
      return this.soldOutShown() ? makeLocator([{ text: 'Out of stock' }]) : makeLocator([]);
    }
    if (selector === 'meta[property="og:image"]') {
      return this.cfg.ogImage !== undefined ? makeLocator([{ attrs: { content: this.cfg.ogImage } }]) : makeLocator([]);
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
    // No page-wide price probe any more (price is read only from inside the buy box), so a
    // '[class*="pdp-price"]' query straight against the page never matches in these fakes.
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

  async waitForSelector(selector: string, _options?: { timeout?: number; state?: 'attached' | 'visible' }): Promise<unknown> {
    this.calls.push('waitForSelector');
    this.waitForSelectorArgs.push(selector);
    // Resolves only when `selector` is `DECISIVE_STATE_SELECTOR` and the configured buy box has
    // actually reached a decisive state (sold-out text, or any purchase button, even a disabled one
    // -- a disabled button still carries the "Add to Cart"/"Buy Now" text `DECISIVE_STATE_SELECTOR`
    // matches on in real Playwright).
    // The purchase-confirm wait on `SOLD_OUT_STATE_SELECTOR` is where a `lateBuyBox` lands.
    if (selector === SOLD_OUT_STATE_SELECTOR) {
      if (this.cfg.lateBuyBox) this.buyBoxState = this.cfg.lateBuyBox;
      if (!this.soldOutShown()) throw new Error('Timeout waiting for sold-out line');
      return undefined;
    }
    if (selector !== DECISIVE_STATE_SELECTOR) throw new Error(`Timeout waiting for ${selector}`);
    if (this.cfg.decisiveAfterTimeout) throw new Error('Timeout waiting for decisive state');
    const bb = this.buyBoxState;
    const decisive = !!bb && (this.soldOutShown() || !!bb.addToCart || !!bb.buyNow);
    if (!decisive) throw new Error('Timeout waiting for decisive state');
    return undefined;
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
      bodyText: 'Elite Trainer Box. Limit 2 per customer. Add to Cart is available.',
      buyBox: { text: 'Quantity: [1]', quantityText: 'Quantity: [1]', priceText: 'S$89.90', addToCartModule: true, addToCart: {} },
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
      buyBox: { text: 'This item is currently sold out.', quantityText: 'This item is currently sold out.', addToCartModule: true, addToCart: {} },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
  });

  it('reports UNKNOWN availability when neither a button nor sold-out text is present', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Nothing conclusive here.',
      buyBox: { text: 'Nothing conclusive here.' },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
  });

  it('reports packagingCondition stated_removed when the body text says the wrapping was removed', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Note: outer plastic wrap removed for quality inspection before shipping.',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
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
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'ok', buyBox: { text: 'ok', addToCart: {} } });
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
  // Buy-box requirement and misclassification pins
  // -------------------------------------------------------------------------------------------
  it('reports unsupported_layout with UNKNOWN availability, one goto, and a screenshot when no buy box selector matches a clean page', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box description, no known buy box wrapper on this page.',
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.accessControl).toBe('unsupported_layout');
    expect(obs.availability).toBe('UNKNOWN');
    expect(obs.offer).toBeNull();
    expect(obs.error).toContain(BUY_BOX_SELECTORS[0]);
    expect(evidences[0]!.snapshotRef).not.toBeNull();
    expect(existsSync(evidences[0]!.snapshotRef!)).toBe(true);
    expect(page.gotoCount).toBe(1);
  });

  it('with a buy box found: a "Sold out" badge from a recommendation outside the buy box does not affect availability', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]\nAdd to Cart\nYou may also like\nBooster Bundle  Sold out\nPrism Tin  S$29.90',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
    expect(evidences[0]!.observedFields.buyBoxSelector).toBe(FAKE_BUY_BOX_SELECTOR);
    expect(evidences[0]!.observedFields.soldOutTextOutsideBuyBox).toBe(true);
  });

  it('does not report login_expired for a product page whose header says Login and whose text mentions a password (no password field)', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'WiFi Router AX3000',
      bodyText: 'Login | Sign Up\nWiFi Router AX3000\nDefault admin password on the label.\nAdd to Cart',
      passwordField: false,
      buyBox: { text: 'Add to Cart', addToCart: {} },
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
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Review: arrived sealed and intact.\nYou may also like: Booster Box Factory Sealed',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.offer?.packagingCondition).toBe('unreadable');
  });

  it('reads a purchase limit only from purchase wording, not from "Limited 1 year warranty"', async () => {
    const dataDir = newDataDir();
    const warranty = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Limited 1 year warranty. Limited time offer.',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
    });
    const a = new LazadaLiveObservationAdapter({ page: warranty, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    expect((await a.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' })).offer?.purchaseLimit).toBeNull();
    const limited = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Limited to 3 pcs per order.',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
    });
    const b = new LazadaLiveObservationAdapter({ page: limited, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    expect((await b.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' })).offer?.purchaseLimit).toBe(3);
  });

  // -------------------------------------------------------------------------------------------
  // Buy-box scoping and readiness wait
  // -------------------------------------------------------------------------------------------
  it('buy box with "Out of stock" text (via #module_quantity-input) and no buttons reads UNAVAILABLE', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [0] Out of stock',
      buyBox: { text: 'Quantity: [0] Out of stock', quantityText: 'Quantity: [0] Out of stock' },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
  });

  it('wishlist-only button ("Add to Wishlist", not matching /add to cart/i or /buy now/i) with "Out of stock" reads UNAVAILABLE', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [0] Out of stock',
      // #module_add_to_cart exists, but the only button in it is "Add to Wishlist" -- neither the
      // add-to-cart nor buy-now regex matches it, mirroring the verified DOM's class-alone trap.
      buyBox: { text: 'Quantity: [0] Out of stock', quantityText: 'Quantity: [0] Out of stock', addToCartModule: true },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
  });

  it('wishlist-only button with no stock text reads UNKNOWN', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [0]',
      buyBox: { text: 'Quantity: [0]', quantityText: 'Quantity: [0]', addToCartModule: true },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
  });

  it('buy box with a disabled Add to Cart (disabled attribute, aria-disabled, or a "disabled" class) reads UNKNOWN, not UNAVAILABLE (disabled proves nothing about stock)', async () => {
    const dataDir = newDataDir();
    for (const spec of [{ disabled: true }, { ariaDisabled: true }, { disabledClass: true }]) {
      const page = new FakeLazadaPage({
        productTitle: 'Elite Trainer Box',
        bodyText: 'Elite Trainer Box\nQuantity: [1]',
        buyBox: { text: 'Quantity: [1]', addToCart: spec },
      });
      const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
      const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
      expect(obs.availability, `spec ${JSON.stringify(spec)}`).toBe('UNKNOWN');
    }
  });

  it('buy box with an enabled Buy Now only (no Add to Cart) reads AVAILABLE', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', addToCart: false, buyNow: {} },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
  });

  it('records the og:image artwork (query dropped) as the packaging-cache key, and null when absent', async () => {
    const withImage = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Quantity: Out of stock',
      buyBox: { text: '', quantityText: 'Quantity: Out of stock' },
      ogImage: 'https://img.lazcdn.com/g/p/etb.jpg_720x720q80.jpg?v=3',
    });
    const a = await new LazadaLiveObservationAdapter({ page: withImage, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1 }).observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(a.offer?.artworkRef).toBe('img.lazcdn.com/g/p/etb.jpg_720x720q80.jpg');
    expect(a.offer?.packagingCondition).toBe('unreadable');

    const without = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText: 'Quantity: Out of stock', buyBox: { text: '', quantityText: 'Quantity: Out of stock' } });
    const b = await new LazadaLiveObservationAdapter({ page: without, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1 }).observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(b.offer?.artworkRef).toBeNull();
  });

  it('buy box present with no buttons and no sold-out text reads UNKNOWN', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nSomething unrelated',
      buyBox: { text: 'Something unrelated' },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNKNOWN');
  });

  it('price from #module_product_price_v2 is preferred over another pdp-price element in the buy box', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', addToCart: {}, priceText: 'S$89.90', priceFallbackText: 'S$999.00' },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.offer?.itemPriceMinor).toBe(8990);
  });

  it('falls back to a pdp-price element when #module_product_price_v2 is absent', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', addToCart: {}, priceFallbackText: 'S$89.90' },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.offer?.itemPriceMinor).toBe(8990);
  });

  it('a readiness timeout still parses the page and records readiness "timeout"', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nOut of stock',
      // The buy box already has decisive (sold-out) content, but the deadline is simulated as
      // passing before the wait observes it -- readiness should still be 'timeout', and the parse
      // that follows must still read the already-loaded sold-out state correctly.
      buyBox: { text: 'Out of stock', quantityText: 'Out of stock' },
      decisiveAfterTimeout: true,
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE'); // timeout still parses the loaded page correctly
    expect(evidences[0]!.observedFields.readiness).toBe('timeout');
  });

  it('readiness success records readiness "decisive" and a buyBoxSelector from BUY_BOX_SELECTORS', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', addToCart: {} },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
    expect(evidences[0]!.observedFields.readiness).toBe('decisive');
    expect(BUY_BOX_SELECTORS).toContain(evidences[0]!.observedFields.buyBoxSelector);
  });

  it('never calls waitForTimeout (readiness replaces the fixed settle wait) and waits on DECISIVE_STATE_SELECTOR', async () => {
    const dataDir = newDataDir();
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'ok',
      buyBox: { text: 'ok', addToCart: {} },
    });
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir, settleMs: 1 });
    await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(page.calls).not.toContain('waitForTimeout');
    expect(page.calls).toContain('waitForSelector');
    expect(page.waitForSelectorArgs).toEqual([DECISIVE_STATE_SELECTOR, SOLD_OUT_STATE_SELECTOR]);
  });

  // Purchase-confirm wait: a purchase button alone does not make a read AVAILABLE until no sold-out
  // line has appeared within purchaseConfirmMs.
  it('buttons that render before the stock line: the late "Out of stock" wins and the read is UNAVAILABLE, not a false restock', async () => {
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', quantityText: 'Quantity: [1]', addToCartModule: true, addToCart: {}, buyNow: {} },
      lateBuyBox: { text: 'Quantity: Out of stock', quantityText: 'Quantity: Out of stock', addToCartModule: true },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
    expect(evidences[0]!.observedFields.purchaseConfirm).toBe('sold_out_appeared');
    expectSingleReadOnlyNavigation(page);
  });

  it('the same race with the confirm wait disabled reads AVAILABLE (documents what the wait prevents)', async () => {
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', quantityText: 'Quantity: [1]', addToCartModule: true, addToCart: {}, buyNow: {} },
      lateBuyBox: { text: 'Quantity: Out of stock', quantityText: 'Quantity: Out of stock', addToCartModule: true },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1, purchaseConfirmMs: 0, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
    expect(evidences[0]!.observedFields.purchaseConfirm).toBe('disabled');
  });

  it('a true restock (buttons, no sold-out line within the confirm wait) reads AVAILABLE with purchaseConfirm "held"', async () => {
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: [1]',
      buyBox: { text: 'Quantity: [1]', quantityText: 'Quantity: [1]', addToCartModule: true, addToCart: {}, buyNow: {} },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('AVAILABLE');
    expect(evidences[0]!.observedFields.purchaseConfirm).toBe('held');
  });

  it('a sold-out line at readiness skips the confirm wait entirely', async () => {
    const page = new FakeLazadaPage({
      productTitle: 'Elite Trainer Box',
      bodyText: 'Elite Trainer Box\nQuantity: Out of stock',
      buyBox: { text: 'Quantity: Out of stock', quantityText: 'Quantity: Out of stock', addToCartModule: true },
    });
    const evidences: Evidence[] = [];
    const adapter = new LazadaLiveObservationAdapter({ page, productUrl: LAZADA_URL, approvedBy: APPROVED_BY, dataDir: newDataDir(), settleMs: 1, onEvidence: (e) => evidences.push(e) });
    const obs = await adapter.observeTarget({ missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' });
    expect(obs.availability).toBe('UNAVAILABLE');
    expect(evidences[0]!.observedFields.purchaseConfirm).toBe('not_needed');
    expect(page.waitForSelectorArgs).toEqual([DECISIVE_STATE_SELECTOR]);
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
    { name: 'unsupported_layout (missing title)', cfg: { bodyText: 'Some page' }, accessControl: 'unsupported_layout', availability: 'UNKNOWN', errorRe: /unsupported layout/ },
    {
      name: 'unsupported_layout (no buy box)',
      cfg: { productTitle: 'Elite Trainer Box', bodyText: 'Elite Trainer Box, no buy box wrapper here.' },
      accessControl: 'unsupported_layout',
      availability: 'UNKNOWN',
      errorRe: /not found \(unsupported layout\)/,
    },
    {
      name: 'clean AVAILABLE',
      cfg: { productTitle: 'Elite Trainer Box', bodyText: 'ok', buyBox: { text: 'ok', priceText: 'S$89.90', addToCart: false, buyNow: {} } },
      accessControl: 'none',
      availability: 'AVAILABLE',
      errorRe: null,
    },
    {
      name: 'clean UNAVAILABLE',
      cfg: { productTitle: 'Elite Trainer Box', bodyText: 'Out of stock', buyBox: { text: 'Out of stock', quantityText: 'Out of stock', priceFallbackText: 'US$89.90' } },
      accessControl: 'none',
      availability: 'UNAVAILABLE',
      errorRe: null,
    },
    {
      name: 'clean UNKNOWN',
      cfg: { productTitle: 'Elite Trainer Box', bodyText: 'ok', buyBox: { text: 'ok', priceFallbackText: '$99999999999999999999' } },
      accessControl: 'none',
      availability: 'UNKNOWN',
      errorRe: null,
    },
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
    const page = new FakeLazadaPage({ productTitle: 'Elite Trainer Box', bodyText, buyBox: { text: 'ok', addToCart: {} } });
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
