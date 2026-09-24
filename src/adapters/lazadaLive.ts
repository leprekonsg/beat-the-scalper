/**
 * Live Lazada observation adapter (Phase 0 step 4+; docs/lazada-feasibility.md). Registered only
 * when the feasibility gate has passed (see src/adapters/lazada.ts's `deps.live`); production
 * wiring never supplies it, so this file changes no default behaviour on its own.
 *
 * Rules mirrored from scripts/lazada-probe.ts (the single-read probe this build's evidence is
 * based on): exactly one `page.goto` per observation, a readiness wait for a decisive element
 * inside the buy box (bounded by `settleMs`, never a fixed sleep -- `waitForTimeout` is never
 * called), then read-only parsing. Never reload, click, type, scroll, log in, or interact with any
 * challenge/captcha -- an access control signal is reported and left for the worker/operator to
 * handle, never bypassed.
 *
 * Buy box structure verified live against Lazada SG (2026-09-21, diagnostic probe
 * data/feasibility/lazada-probe-2026-09-21T02-44-52-099Z.json): the product panel ("buy box") is
 * `div.pdp-block.pdp-v2-block__product-detail` (its `id` is a random `block-xxxx` -- never match on
 * an id of that shape). In DOM order it contains `#module_product_title_1`
 * (h1.pdp-mod-product-badge-title-v2), `#module_product_price_v2` (e.g. "$109.90"),
 * `#module_seller_warranty`, `#module_sku-select`, `#module_quantity-input` (text
 * "Quantity: Out of stock" when out of stock), and `#module_add_to_cart`
 * (`.pdp-cart-concern-v2 > .pdp-cart-concern-btn > button.add-to-cart-buy-now-btn`). When out of
 * stock the ONLY button under `#module_add_to_cart` is "Add to Wishlist", which also carries the
 * `add-to-cart-buy-now-btn` class -- class alone never identifies a purchase control; buttons are
 * matched by accessible name (`/add to cart/i`, `/buy now/i`) only. `_mini` duplicates
 * (`#module_quantity-input_mini`, `#module_add_to_cart_mini`, `#module_product_price_v2_mini`) exist
 * for a sticky bar, are empty/hidden, and are never matched (exact ids only). `#module_add_to_cart`
 * alone is too narrow to use as the buy box (it excludes the stock line -- a live 5-read run with it
 * as the buy box misread every UNAVAILABLE case as UNKNOWN). `#module_product_detail` is the
 * description block lower on the page, NOT the buy box; `[class*="pdp-mod-product-info"]` matches a
 * sub-section, not the buy box; neither is used any more. See `BUY_BOX_SELECTORS` and
 * `DECISIVE_STATE_SELECTOR`.
 *
 * There is no page-wide fallback: when no `BUY_BOX_SELECTORS` candidate matches on an otherwise
 * clean page, the layout is unsupported and the observation is UNKNOWN with
 * `accessControl: 'unsupported_layout'` (see `parseLoadedPage`). A live run on 2026-09-21 also found
 * that a broad selector's first DOM match can be a hidden element (e.g. `[class*="pdp-price"]`) and
 * that a container can become visible before the state inside it is observable (landmark timings on
 * that load, from domcontentloaded: h1 2150ms, stock text 2410ms, buttons 2409ms) -- readiness
 * therefore waits on `DECISIVE_STATE_SELECTOR`, not on buy-box container visibility.
 *
 * `classifyLazadaPage` and `parseSgdMinor` are pure and exported so they are unit-testable without
 * Playwright; `observeTarget` is exercised with a fake `LazadaLivePage` in
 * tests/unit/lazada-live-adapter.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Availability, Evidence, Observation, OfferedItem, PackagingCondition, Provenance } from '../domain/types.ts';
import { EvidenceSchema, ObservationSchema } from '../domain/types.ts';
import type { ObservationAdapter, ObserveRequest } from './types.ts';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Narrow Playwright Page/Locator surface. A real Playwright `Page` satisfies this structurally;
// tests inject a fake implementing exactly this shape (same pattern as agent/geminiComputerUse.ts's
// ComputerUsePage).
// ---------------------------------------------------------------------------

export interface LazadaLiveLocator {
  first(): LazadaLiveLocator;
  count(): Promise<number>;
  innerText(options?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  locator(selector: string): LazadaLiveLocator;
  getByRole(role: 'button', options?: { name?: RegExp | string }): LazadaLiveLocator;
}

export interface LazadaLiveResponse {
  status(): number;
  headers(): Record<string, string>;
}

export interface LazadaLivePage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<LazadaLiveResponse | null>;
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  locator(selector: string): LazadaLiveLocator;
  getByRole(role: 'button', options?: { name?: RegExp | string }): LazadaLiveLocator;
  screenshot(options: { path: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'visible' }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Pure classification / parsing helpers
// ---------------------------------------------------------------------------

// `\bpunish\b` (not bare `punish`): Lazada's challenge page is served under a /punish path, but a
// product page for "Crime and Punishment" or "Punishing Gray Raven" must not pause the mission.
const CHALLENGE_RE = /captcha|slide to verify|verify you are human|\bpunish\b|unusual traffic/i;
const CHALLENGE_URL_RE = /\/punish|captcha/i;
const LOGIN_PROMPT_RE = /log in|login|sign in/i;
// A login *wall*, not a header "Login" link next to a product description that happens to mention a
// password (routers, safes, ...): needs a password input on the page, or wall-only wording.
const LOGIN_WALL_TEXT_RE = /forgot (?:your )?password|log ?in with (?:your )?password|enter (?:your )?password/i;

export interface LazadaPageClassification {
  accessControl: Observation['accessControl'];
  retryAfterSeconds: number | null;
  error: string | null;
}

export interface LazadaPageClassificationInput {
  status: number | null;
  bodyText: string;
  title: string | null;
  retryAfter: string | null;
  /** Final URL after redirects; a /punish or captcha path is a challenge even if the body is empty. */
  finalUrl?: string | null;
  /** `input[type=password]` present. Pure callers may omit it; the text heuristic then stands alone. */
  passwordFieldPresent?: boolean | null;
}

/** Retry-After as a non-negative safe integer of seconds, else null (HTTP-date form is not parsed). */
function parseRetryAfterSeconds(header: string | null): number | null {
  if (header === null) return null;
  const n = Number.parseInt(header, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Priority order matches the brief exactly: challenge text beats everything (a captcha can be
 * served alongside a 429 or a stale title), then rate limiting, then the login wall, then any
 * other >=400 status, then a missing product title (unsupported layout), then a clean page.
 */
export function classifyLazadaPage(input: LazadaPageClassificationInput): LazadaPageClassification {
  if (CHALLENGE_RE.test(input.bodyText) || (input.finalUrl ? CHALLENGE_URL_RE.test(input.finalUrl) : false)) {
    return { accessControl: 'captcha', retryAfterSeconds: null, error: 'CAPTCHA/challenge presented; no bypass attempted' };
  }
  if (input.status === 429) {
    return { accessControl: 'rate_limited', retryAfterSeconds: parseRetryAfterSeconds(input.retryAfter), error: 'Rate limited by Lazada (HTTP 429)' };
  }
  if (LOGIN_PROMPT_RE.test(input.bodyText) && (input.passwordFieldPresent === true || LOGIN_WALL_TEXT_RE.test(input.bodyText))) {
    return { accessControl: 'login_expired', retryAfterSeconds: null, error: 'Login wall presented' };
  }
  if (input.status !== null && input.status >= 400) {
    return { accessControl: 'none', retryAfterSeconds: null, error: `http_${input.status}` };
  }
  if (!input.title) {
    return { accessControl: 'unsupported_layout', retryAfterSeconds: null, error: 'Expected product title not found (unsupported layout)' };
  }
  return { accessControl: 'none', retryAfterSeconds: null, error: null };
}

/**
 * Extracts a single exact "S$"/"$" amount in `text` into integer SGD minor units (cents). A range
 * ("S$89.90 - S$120.00", two amounts) or a "From S$10" qualifier is the minimum of an unresolved
 * variant selection, not the selected item's price, so it returns null: the raw price text is kept
 * in evidence and policy treats a null price as an unknown delivered total (never a rejection and
 * never a false pass). A genuinely absent amount (no `$` at all) also returns null.
 *
 * A `$` preceded by a letter other than the SGD "S" (US$, A$, HK$, NT$, ...) is another currency and
 * is never reported as SGD. Amounts outside the safe-integer range return null rather than an
 * observation that fails `OfferedItemSchema`.
 */
const SGD_AMOUNT_RE = /(?<![A-Za-z])(?:S\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
const PRICE_RANGE_QUALIFIER_RE = /\bfrom\b/i;

export function parseSgdMinor(text: string | null): number | null {
  if (!text) return null;
  const matches = Array.from(text.matchAll(SGD_AMOUNT_RE));
  if (matches.length !== 1) return null;
  if (PRICE_RANGE_QUALIFIER_RE.test(text)) return null;
  const match = matches[0]!;
  const numeric = Number.parseFloat(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const minor = Math.round(numeric * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Buy-box container candidates, tried in order, first match wins. Verified live against Lazada SG
 * on 2026-09-21 (data/feasibility/lazada-probe-2026-09-21T02-44-52-099Z.json): the product panel is
 * `div.pdp-block.pdp-v2-block__product-detail`. The first entry is that verified class; the second
 * is a tolerant fallback for a class rename between a `pdp-v2-`/`pdp-v3-` prefix swap (the
 * `block__product-detail` suffix presumed stable). No xpath entry and no other guessed candidate --
 * `findBuyBox`/`parseLoadedPage` records which one matched so a live run tells us if the fallback
 * ever fires.
 */
export const BUY_BOX_SELECTORS = ['.pdp-v2-block__product-detail', '[class*="block__product-detail"]'];

/**
 * Decisive, visible-when-rendered elements inside the buy box. Readiness waits on this (not on buy
 * box container visibility) because a container can become visible before the state inside it is
 * observable -- on the 2026-09-21 probe load, the container was visible before the stock text had
 * landed in body text. Each branch matches only once the buy box has actually reached a determinate
 * state: a rendered out-of-stock/sold-out quantity line, or an actionable purchase button.
 */
/** The sold-out branches of `DECISIVE_STATE_SELECTOR`: a rendered out-of-stock/sold-out quantity line. */
export const SOLD_OUT_STATE_SELECTOR = ['#module_quantity-input:has-text("out of stock")', '#module_quantity-input:has-text("sold out")'].join(', ');

export const DECISIVE_STATE_SELECTOR = [
  SOLD_OUT_STATE_SELECTOR,
  '#module_add_to_cart button:has-text("Add to Cart")',
  '#module_add_to_cart button:has-text("Buy Now")',
].join(', ');

const REMOVED_RE_A = /\b(wrapping|plastic|seal(?:ed)?)\b[\s\S]{0,40}\bremoved\b/i;
const REMOVED_RE_B = /\bremoved\b[\s\S]{0,40}\b(wrapping|plastic|seal)\b/i;
const SOLD_OUT_RE = /sold out|out of stock/i;
// A count followed by a purchase-unit word: "Limit 2 per customer", "limited to 3 pcs". A bare
// "Limited 1 year warranty" is not a purchase limit. At most 3 digits keeps the value a safe int.
const PURCHASE_LIMIT_RE = /\blimit(?:ed)?\s+(?:to\s+)?(\d{1,3})\s*(?:per\b|pcs?\b|pieces?\b|units?\b|items?\b|boxe?s?\b|sets?\b)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Listing artwork reference for the packaging cache: the og:image URL without query or fragment
 * (CDN resize parameters vary per load; the path identifies the image). Null when absent or unparseable.
 */
export function normaliseArtworkRef(content: string | null): string | null {
  if (!content) return null;
  try {
    const u = new URL(content.trim().startsWith('//') ? `https:${content.trim()}` : content.trim());
    return `${u.hostname}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Body text stored as evidence is capped and never carries an address from a signed-in header. */
function redactExcerpt(text: string): string {
  return text.replace(EMAIL_RE, '[email]');
}

/**
 * Only a stated *removal* is claimed from body text. The word "sealed"/"intact" anywhere in 6000
 * chars of page text (a review, a "Factory Sealed" recommendation in a carousel) is not a statement
 * about this listing, and `stated_intact` passes `must_be_intact` eligibility with no interpreter
 * check, so text alone never promotes to it: the screenshot interpreter has to confirm.
 */
function classifyPackaging(bodyText: string): PackagingCondition {
  if (REMOVED_RE_A.test(bodyText) || REMOVED_RE_B.test(bodyText)) return 'stated_removed';
  // The known notice on this listing is artwork-only text baked into a product image, so it is
  // never present in `bodyText`; the interpreter must read the screenshot. 'not_stated' would claim
  // a fact ("nothing is stated") the page never actually let us check, so 'unreadable' is the only
  // honest default here.
  return 'unreadable';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LazadaLiveObservationAdapterOptions {
  page: LazadaLivePage;
  productUrl: string;
  now?: () => Date;
  onEvidence?: (e: Evidence) => void;
  /** Base data directory; screenshots are written to `${dataDir}/evidence/<evidenceId>.png`. */
  dataDir?: string;
  /** Who approved this run and when; required non-empty, recorded for audit but never sent anywhere. */
  approvedBy: string;
  /**
   * Maximum time to wait after `goto` for `DECISIVE_STATE_SELECTOR` to become visible before giving
   * up and parsing the page as-is (option name kept as `settleMs` for existing callers/scripts).
   * Default 4000ms (probe default).
   */
  settleMs?: number;
  /**
   * When readiness was reached by a purchase button rather than a sold-out line, how long to keep
   * waiting for a sold-out line before parsing (see `SOLD_OUT_STATE_SELECTOR`). Guards against a
   * false AVAILABLE when the buttons render before the stock line; costs at most this much on a true
   * restock. Default 1000ms; 0 disables.
   */
  purchaseConfirmMs?: number;
}

export class LazadaLiveObservationAdapter implements ObservationAdapter {
  readonly name = 'lazada_live_observation';
  readonly provenance: Provenance = 'live_verified';
  readonly origin: string;
  private readonly page: LazadaLivePage;
  private readonly productUrl: string;
  private readonly now: () => Date;
  private readonly onEvidence: ((e: Evidence) => void) | undefined;
  private readonly evidenceDir: string;
  private readonly settleMs: number;
  private readonly purchaseConfirmMs: number;

  constructor(opts: LazadaLiveObservationAdapterOptions) {
    if (!opts.approvedBy || opts.approvedBy.trim().length === 0) {
      throw new Error('LazadaLiveObservationAdapter requires a non-empty approvedBy note; live retailer access is never unattended');
    }
    let host: string;
    try {
      host = new URL(opts.productUrl).hostname;
    } catch {
      throw new Error(`LazadaLiveObservationAdapter requires a valid productUrl, got "${opts.productUrl}"`);
    }
    if (!/(^|\.)lazada\.sg$/.test(host)) {
      throw new Error(`Refusing non-lazada.sg productUrl host "${host}"`);
    }
    this.page = opts.page;
    this.productUrl = opts.productUrl;
    this.origin = new URL(opts.productUrl).origin;
    this.now = opts.now ?? (() => new Date());
    this.onEvidence = opts.onEvidence;
    this.settleMs = opts.settleMs ?? 4000;
    this.purchaseConfirmMs = opts.purchaseConfirmMs ?? 1000;
    this.evidenceDir = join(opts.dataDir ? resolve(opts.dataDir) : resolve(process.cwd(), 'data'), 'evidence');
  }

  private async captureScreenshot(evidenceId: string): Promise<string | null> {
    try {
      mkdirSync(this.evidenceDir, { recursive: true });
      const path = join(this.evidenceDir, `${evidenceId}.png`);
      await this.page.screenshot({ path });
      return path;
    } catch {
      return null;
    }
  }

  private buildEvidence(args: {
    evidenceId: string;
    capturedAt: string;
    pageRevision: string | null;
    targetRef: string | null;
    variantRef: string | null;
    observedFields: Record<string, unknown>;
    snapshotRef: string | null;
  }): Evidence {
    return EvidenceSchema.parse({
      evidenceId: args.evidenceId,
      sourceKind: 'retailer_page',
      provenance: 'live_verified',
      sourceUrl: this.productUrl,
      sourceMessageId: null,
      capturedAt: args.capturedAt,
      sourcePublishedAt: null,
      receivedAt: args.capturedAt,
      targetRef: args.targetRef,
      variantRef: args.variantRef,
      pageRevision: args.pageRevision,
      observedFields: args.observedFields,
      snapshotRef: args.snapshotRef,
      contentHash: null,
    });
  }

  /** A throwing evidence sink must not turn a completed observation into a thrown tick. */
  private emitEvidence(evidence: Evidence): void {
    try {
      this.onEvidence?.(evidence);
    } catch {
      /* best-effort provenance capture only */
    }
  }

  private unknownObservation(
    missionId: string,
    capturedAt: string,
    error: string,
    accessControl: Observation['accessControl'],
    retryAfterSeconds: number | null,
    evidenceId: string,
    evidence: Evidence,
    pageRevisionLabel?: string,
  ): Observation {
    this.emitEvidence(evidence);
    return ObservationSchema.parse({
      observationId: `obs_${randomUUID()}`,
      missionId,
      evidenceId,
      provenance: 'live_verified',
      capturedAt,
      pageRevision: pageRevisionLabel ?? (accessControl === 'none' ? 'nav-error' : accessControl),
      availability: 'UNKNOWN',
      offer: null,
      accessControl,
      retryAfterSeconds,
      error,
    });
  }

  private async probe(selectors: string[]): Promise<string | null> {
    for (const s of selectors) {
      const loc = this.page.locator(s).first();
      if ((await loc.count()) > 0) {
        const t = (await loc.innerText().catch(() => '')).trim();
        if (t) return t.slice(0, 200);
      }
    }
    return null;
  }

  /** Same probe, scoped to a locator (e.g. the buy box) instead of the whole page. */
  private async probeWithin(root: LazadaLiveLocator, selectors: string[]): Promise<string | null> {
    for (const s of selectors) {
      const loc = root.locator(s).first();
      if ((await loc.count()) > 0) {
        const t = (await loc.innerText().catch(() => '')).trim();
        if (t) return t.slice(0, 200);
      }
    }
    return null;
  }

  /** First `BUY_BOX_SELECTORS` candidate present on the page, in order, or null if none match. */
  private async findBuyBox(): Promise<{ selector: string; locator: LazadaLiveLocator } | null> {
    for (const selector of BUY_BOX_SELECTORS) {
      const loc = this.page.locator(selector).first();
      if ((await loc.count()) > 0) return { selector, locator: loc };
    }
    return null;
  }

  /**
   * A button counts as enabled unless it carries a `disabled` attribute, `aria-disabled="true"`, or
   * a class attribute containing the substring "disabled". Absence of the element itself is a
   * separate concern (callers check `count()` first).
   */
  private async isButtonEnabled(loc: LazadaLiveLocator): Promise<boolean> {
    const disabled = await loc.getAttribute('disabled').catch(() => null);
    if (disabled !== null) return false;
    const ariaDisabled = await loc.getAttribute('aria-disabled').catch(() => null);
    if (ariaDisabled === 'true') return false;
    const className = await loc.getAttribute('class').catch(() => null);
    if (className && className.includes('disabled')) return false;
    return true;
  }

  async observeTarget(req: ObserveRequest): Promise<Observation> {
    const capturedAt = this.now().toISOString();
    const evidenceId = `evd_${randomUUID()}`;

    // Exactly one navigation. No reload, click, type, scroll, or login ever happens on this path.
    const loadStart = performance.now();
    let response: LazadaLiveResponse | null = null;
    let navError: string | null = null;
    try {
      response = await this.page.goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (err) {
      navError = describeError(err);
    }

    // Readiness wait: block (up to `settleMs`) for a decisive state inside the buy box to become
    // visible, instead of a fixed sleep (`waitForTimeout` is never called). A timeout is not a
    // navigation failure -- the page is still parsed as loaded either way; a sold-out line that
    // renders between the deadline and the parse is still valid evidence, and the scoped rules below
    // correctly yield UNKNOWN when nothing decisive is actually present. `readiness` records which
    // happened so a live run tells us how often the wait is actually needed.
    //
    // A purchase button alone is not trusted at once: the stock line can land after the buttons
    // (Run 6), and a sold-out page read in that gap would parse as AVAILABLE and fire a false restock
    // alert. So when no sold-out line is present yet, wait up to `purchaseConfirmMs` more for one.
    // `purchaseConfirm` records the outcome: 'sold_out_appeared' is the race this guards against.
    let readiness: 'decisive' | 'timeout' = 'timeout';
    let readinessMs = 0;
    let purchaseConfirm: 'not_needed' | 'held' | 'sold_out_appeared' | 'disabled' = 'not_needed';
    let purchaseConfirmMs = 0;
    if (navError === null) {
      const readinessStart = performance.now();
      try {
        await this.page.waitForSelector(DECISIVE_STATE_SELECTOR, { timeout: this.settleMs, state: 'visible' });
        readiness = 'decisive';
      } catch {
        readiness = 'timeout';
      }
      if (readiness === 'decisive') {
        const soldOutNow = await this.page.locator(SOLD_OUT_STATE_SELECTOR).count().catch(() => 0);
        if (soldOutNow === 0) {
          if (this.purchaseConfirmMs <= 0) {
            purchaseConfirm = 'disabled';
          } else {
            const confirmStart = performance.now();
            try {
              await this.page.waitForSelector(SOLD_OUT_STATE_SELECTOR, { timeout: this.purchaseConfirmMs, state: 'visible' });
              purchaseConfirm = 'sold_out_appeared';
            } catch {
              purchaseConfirm = 'held';
            }
            purchaseConfirmMs = performance.now() - confirmStart;
          }
        }
      }
      readinessMs = performance.now() - readinessStart;
    }
    const loadMs = performance.now() - loadStart;

    if (navError !== null) {
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: { loadMs, parseMs: 0, httpStatus: null, finalUrl: this.safeUrl(), error: navError },
        snapshotRef,
      });
      return this.unknownObservation(req.missionId, capturedAt, `Navigation failed: ${navError}`, 'none', null, evidenceId, evidence);
    }

    // Read-only parsing of the page that is already loaded. Nothing below navigates; a locator
    // failure (page closed mid-parse) or a value the domain schema rejects is reported as an
    // UNKNOWN observation, never thrown into the worker tick.
    try {
      return await this.parseLoadedPage(req, { capturedAt, evidenceId, loadMs, response, readiness, readinessMs, purchaseConfirm, purchaseConfirmMs });
    } catch (err) {
      const parseError = describeError(err);
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: {
          loadMs,
          parseMs: null,
          httpStatus: response ? response.status() : null,
          finalUrl: this.safeUrl(),
          error: parseError,
          readiness,
          readinessMs,
          purchaseConfirm,
          purchaseConfirmMs,
        },
        snapshotRef,
      });
      return this.unknownObservation(req.missionId, capturedAt, `Parse failed: ${parseError}`, 'none', null, evidenceId, evidence, 'parse-error');
    }
  }

  private async parseLoadedPage(
    req: ObserveRequest,
    ctx: {
      capturedAt: string;
      evidenceId: string;
      loadMs: number;
      response: LazadaLiveResponse | null;
      readiness: 'decisive' | 'timeout';
      readinessMs: number;
      purchaseConfirm: 'not_needed' | 'held' | 'sold_out_appeared' | 'disabled';
      purchaseConfirmMs: number;
    },
  ): Promise<Observation> {
    const { capturedAt, evidenceId, loadMs, response, readiness, readinessMs, purchaseConfirm, purchaseConfirmMs } = ctx;
    const parseStart = performance.now();
    const finalUrl = this.safeUrl();
    const httpStatus = response ? response.status() : null;
    const retryAfterHeader = response ? (response.headers()['retry-after'] ?? null) : null;
    const title = await this.page.title().catch(() => '');
    const bodyText = (await this.page.innerText('body').catch(() => '')).slice(0, 6000);
    const bodyTextExcerpt = redactExcerpt(bodyText.slice(0, 1200));

    const productTitle = await this.probe(['h1', '[class*="pdp-mod-product-badge-title"]', '[class*="title"]']);
    const passwordFieldPresent = (await this.page.locator('input[type="password"]').count()) > 0;
    const classification = classifyLazadaPage({ status: httpStatus, bodyText, title: productTitle, retryAfter: retryAfterHeader, finalUrl, passwordFieldPresent });

    if (classification.error !== null) {
      const parseMs = performance.now() - parseStart;
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: { loadMs, parseMs, httpStatus, finalUrl, pageTitle: title, accessControl: classification.accessControl, bodyTextExcerpt, readiness, readinessMs, purchaseConfirm, purchaseConfirmMs },
        snapshotRef,
      });
      return this.unknownObservation(req.missionId, capturedAt, classification.error, classification.accessControl, classification.retryAfterSeconds, evidenceId, evidence);
    }

    // Clean page: the buy box is now required to parse an offer at all (no page-wide fallback --
    // see the file header). Its absence is a distinct, honest signal: the layout has moved and the
    // candidate list needs updating, not a stock read from unrelated page furniture.
    const buyBox = await this.findBuyBox();
    if (!buyBox) {
      const parseMs = performance.now() - parseStart;
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: { loadMs, parseMs, httpStatus, finalUrl, pageTitle: title, productTitle, readiness, readinessMs, purchaseConfirm, purchaseConfirmMs, bodyTextExcerpt },
        snapshotRef,
      });
      return this.unknownObservation(
        req.missionId,
        capturedAt,
        `Buy box (${BUY_BOX_SELECTORS[0]}) not found (unsupported layout)`,
        'unsupported_layout',
        null,
        evidenceId,
        evidence,
      );
    }

    const sellerLabel = await this.probe(['[class*="seller-name"]', 'a[href*="/shop/"]']);
    let sellerRef: string | null = null;
    const shopLink = this.page.locator('a[href*="/shop/"]').first();
    if ((await shopLink.count()) > 0) {
      const href = await shopLink.getAttribute('href').catch(() => null);
      const m = href ? /\/shop\/([^/?#]+)/.exec(href) : null;
      sellerRef = m ? m[1]! : null;
    }

    // Price: the verified `#module_product_price_v2` module first, then a tolerant class-based
    // fallback scoped to the buy box, then null. No page-wide price probe any more.
    const priceModule = buyBox.locator.locator('#module_product_price_v2').first();
    let priceText: string | null = null;
    if ((await priceModule.count()) > 0) {
      const t = (await priceModule.innerText().catch(() => '')).trim();
      if (t) priceText = t.slice(0, 200);
    }
    if (priceText === null) {
      priceText = await this.probeWithin(buyBox.locator, ['[class*="pdp-price"]']);
    }
    const itemPriceMinor = parseSgdMinor(priceText);

    const retailerProductId = /-i(\d+)/.exec(finalUrl)?.[1] ?? null;
    const variantId = /-s(\d+)/.exec(finalUrl)?.[1] ?? null;

    const titleLower = (productTitle ?? '').toLowerCase();
    const productFormat = req.intent.target.productFormat && titleLower.includes(req.intent.target.productFormat.toLowerCase()) ? req.intent.target.productFormat : null;
    const language = req.intent.target.language && titleLower.includes(req.intent.target.language.toLowerCase()) ? req.intent.target.language : null;

    const purchaseLimitMatch = PURCHASE_LIMIT_RE.exec(bodyText);
    const purchaseLimit = purchaseLimitMatch ? Number.parseInt(purchaseLimitMatch[1]!, 10) : null;

    const packagingCondition = classifyPackaging(bodyText);

    // Keys the worker's packaging cache (the wrap notice is artwork-only). count() first: getAttribute on a
    // missing element would wait for Playwright's default timeout.
    const ogImage = this.page.locator('meta[property="og:image"]').first();
    const artworkRef = (await ogImage.count()) > 0 ? normaliseArtworkRef(await ogImage.getAttribute('content', { timeout: 1000 }).catch(() => null)) : null;

    // On a verified out-of-stock page, "Add to Cart"/"Buy Now" are absent (the only button under
    // `#module_add_to_cart` is "Add to Wishlist") and a "Quantity: ... Out of stock" line sits in
    // `#module_quantity-input`. Availability is read from *inside* the buy box only: a "Sold out"
    // badge on a recommended item elsewhere on the page is ignored for availability and only
    // recorded as a diagnostic (`soldOutTextOutsideBuyBox`).
    const buyBoxSelector = buyBox.selector;

    const quantityModule = buyBox.locator.locator('#module_quantity-input').first();
    const quantityCount = await quantityModule.count();
    const stockText =
      quantityCount > 0
        ? (await quantityModule.innerText().catch(() => '')).slice(0, 2000)
        : (await buyBox.locator.innerText().catch(() => '')).slice(0, 2000);
    const soldOutInBuyBox = SOLD_OUT_RE.test(stockText);
    const soldOutTextOutsideBuyBox = SOLD_OUT_RE.test(bodyText) && !soldOutInBuyBox;

    // Buttons are matched by accessible name only (never by class -- see file header), scoped to
    // `#module_add_to_cart` when that module exists inside the buy box, else to the buy box itself.
    const addToCartModule = buyBox.locator.locator('#module_add_to_cart').first();
    const addToCartModuleCount = await addToCartModule.count();
    const buttonRoot = addToCartModuleCount > 0 ? addToCartModule : buyBox.locator;
    const addToCartLoc = buttonRoot.getByRole('button', { name: /add to cart/i });
    const buyNowLoc = buttonRoot.getByRole('button', { name: /buy now/i });
    const addToCartCount = await addToCartLoc.count();
    const buyNowCount = await buyNowLoc.count();
    const addToCartEnabled = addToCartCount > 0 && (await this.isButtonEnabled(addToCartLoc));
    const buyNowEnabled = buyNowCount > 0 && (await this.isButtonEnabled(buyNowLoc));

    // A present-but-disabled control proves only that it cannot be used right now, not why (stock,
    // variant unselected, hydration still pending), so it stays UNKNOWN rather than UNAVAILABLE. The
    // worker raises a candidate on either UNKNOWN->AVAILABLE or UNAVAILABLE->AVAILABLE, so the
    // transition behaviour is identical; only the claim is honest.
    let availability: Availability;
    if (soldOutInBuyBox) availability = 'UNAVAILABLE';
    else if (addToCartEnabled || buyNowEnabled) availability = 'AVAILABLE';
    else availability = 'UNKNOWN';

    const offer: OfferedItem = {
      retailerProductId,
      variantId,
      variantLabel: null,
      sellerRef,
      sellerLabel,
      productFormat,
      language,
      title: productTitle,
      itemPriceMinor,
      deliveryFeeMinor: null,
      deliveredTotalMinor: null,
      packagingCondition,
      packagingEvidenceRegion: null,
      purchaseLimit,
      artworkRef,
    };

    const pageRevision = createHash('sha256')
      .update(`${productTitle ?? ''}|${priceText ?? ''}|${availability}|${sellerLabel ?? ''}`)
      .digest('hex')
      .slice(0, 16);

    const parseMs = performance.now() - parseStart;
    const snapshotRef = await this.captureScreenshot(evidenceId);
    const evidence = this.buildEvidence({
      evidenceId,
      capturedAt,
      pageRevision,
      targetRef: retailerProductId,
      variantRef: variantId,
      observedFields: {
        loadMs,
        parseMs,
        httpStatus,
        finalUrl,
        accessControl: 'none',
        productTitle,
        priceText,
        sellerLabel,
        sellerRef,
        purchaseLimit,
        availability,
        packagingCondition,
        artworkRef,
        bodyTextExcerpt,
        buyBoxSelector,
        soldOutTextOutsideBuyBox,
        readiness,
        readinessMs,
        purchaseConfirm,
        purchaseConfirmMs,
      },
      snapshotRef,
    });
    this.emitEvidence(evidence);

    return ObservationSchema.parse({
      observationId: `obs_${randomUUID()}`,
      missionId: req.missionId,
      evidenceId,
      provenance: 'live_verified',
      capturedAt,
      pageRevision,
      availability,
      offer,
      accessControl: 'none',
      retryAfterSeconds: null,
      error: null,
    });
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return this.productUrl;
    }
  }
}
