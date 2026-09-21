/**
 * Live Lazada observation adapter (Phase 0 step 4+; docs/lazada-feasibility.md). Registered only
 * when the feasibility gate has passed (see src/adapters/lazada.ts's `deps.live`); production
 * wiring never supplies it, so this file changes no default behaviour on its own.
 *
 * Rules mirrored from scripts/lazada-probe.ts (the single-read probe this build's evidence is
 * based on): exactly one `page.goto` per observation, a fixed settle wait, then read-only parsing.
 * Never reload, click, type, scroll, log in, or interact with any challenge/captcha -- an access
 * control signal is reported and left for the worker/operator to handle, never bypassed.
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
 * Extracts the first "S$"/"$" amount in `text` into integer SGD minor units (cents). Judgement
 * call: a leading qualifier like "From S$10" is not treated as ambiguous -- the first amount found
 * is used as the item price (the lower bound of a range is still a real, checkable price). Only a
 * genuinely absent amount (no `$` at all) returns null; this is documented here rather than guessed
 * silently because the brief left the range case open ("pick one and document").
 *
 * A `$` preceded by a letter other than the SGD "S" (US$, A$, HK$, NT$, ...) is another currency and
 * is never reported as SGD. Amounts outside the safe-integer range return null rather than an
 * observation that fails `OfferedItemSchema`.
 */
export function parseSgdMinor(text: string | null): number | null {
  if (!text) return null;
  const match = /(?<![A-Za-z])(?:S\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text);
  if (!match) return null;
  const numeric = Number.parseFloat(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const minor = Math.round(numeric * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

const REMOVED_RE_A = /\b(wrapping|plastic|seal(?:ed)?)\b[\s\S]{0,40}\bremoved\b/i;
const REMOVED_RE_B = /\bremoved\b[\s\S]{0,40}\b(wrapping|plastic|seal)\b/i;
const SOLD_OUT_RE = /sold out|out of stock/i;
// A count followed by a purchase-unit word: "Limit 2 per customer", "limited to 3 pcs". A bare
// "Limited 1 year warranty" is not a purchase limit. At most 3 digits keeps the value a safe int.
const PURCHASE_LIMIT_RE = /\blimit(?:ed)?\s+(?:to\s+)?(\d{1,3})\s*(?:per\b|pcs?\b|pieces?\b|units?\b|items?\b|boxe?s?\b|sets?\b)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

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
  /** Wait after `goto` before parsing, to let client-side rendering settle. Default 4000ms (probe default). */
  settleMs?: number;
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

  async observeTarget(req: ObserveRequest): Promise<Observation> {
    const capturedAt = this.now().toISOString();
    const evidenceId = `evd_${randomUUID()}`;

    // Exactly one navigation, then a fixed settle wait. No reload, click, type, scroll, or login
    // ever happens on this path.
    const loadStart = performance.now();
    let response: LazadaLiveResponse | null = null;
    let navError: string | null = null;
    try {
      response = await this.page.goto(this.productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.page.waitForTimeout(this.settleMs);
    } catch (err) {
      navError = describeError(err);
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
      return await this.parseLoadedPage(req, { capturedAt, evidenceId, loadMs, response });
    } catch (err) {
      const parseError = describeError(err);
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: { loadMs, parseMs: null, httpStatus: response ? response.status() : null, finalUrl: this.safeUrl(), error: parseError },
        snapshotRef,
      });
      return this.unknownObservation(req.missionId, capturedAt, `Parse failed: ${parseError}`, 'none', null, evidenceId, evidence, 'parse-error');
    }
  }

  private async parseLoadedPage(
    req: ObserveRequest,
    ctx: { capturedAt: string; evidenceId: string; loadMs: number; response: LazadaLiveResponse | null },
  ): Promise<Observation> {
    const { capturedAt, evidenceId, loadMs, response } = ctx;
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
        observedFields: { loadMs, parseMs, httpStatus, finalUrl, pageTitle: title, accessControl: classification.accessControl, bodyTextExcerpt },
        snapshotRef,
      });
      return this.unknownObservation(req.missionId, capturedAt, classification.error, classification.accessControl, classification.retryAfterSeconds, evidenceId, evidence);
    }

    // Clean page: parse the offer.
    const sellerLabel = await this.probe(['[class*="seller-name"]', 'a[href*="/shop/"]']);
    let sellerRef: string | null = null;
    const shopLink = this.page.locator('a[href*="/shop/"]').first();
    if ((await shopLink.count()) > 0) {
      const href = await shopLink.getAttribute('href').catch(() => null);
      const m = href ? /\/shop\/([^/?#]+)/.exec(href) : null;
      sellerRef = m ? m[1]! : null;
    }

    const priceText = await this.probe(['[class*="pdp-price"]', '[class*="price"]']);
    const itemPriceMinor = parseSgdMinor(priceText);

    const retailerProductId = /-i(\d+)/.exec(finalUrl)?.[1] ?? null;
    const variantId = /-s(\d+)/.exec(finalUrl)?.[1] ?? null;

    const titleLower = (productTitle ?? '').toLowerCase();
    const productFormat = req.intent.target.productFormat && titleLower.includes(req.intent.target.productFormat.toLowerCase()) ? req.intent.target.productFormat : null;
    const language = req.intent.target.language && titleLower.includes(req.intent.target.language.toLowerCase()) ? req.intent.target.language : null;

    const purchaseLimitMatch = PURCHASE_LIMIT_RE.exec(bodyText);
    const purchaseLimit = purchaseLimitMatch ? Number.parseInt(purchaseLimitMatch[1]!, 10) : null;

    // Sold-out text anywhere in the body wins over a present button: Lazada keeps the (disabled)
    // Add to Cart/Buy Now buttons in the DOM for an out-of-stock listing, so a button count alone
    // is not proof of stock. Known cost: a "Sold out" badge on a recommended item elsewhere on the
    // page reads as UNAVAILABLE for this listing (a missed restock, never a false candidate).

    const packagingCondition = classifyPackaging(bodyText);

    const soldOutTextPresent = SOLD_OUT_RE.test(bodyText);
    const addToCartPresent = (await this.page.getByRole('button', { name: /add to cart/i }).count()) > 0;
    const buyNowPresent = (await this.page.getByRole('button', { name: /buy now/i }).count()) > 0;
    let availability: Availability = 'UNKNOWN';
    if (soldOutTextPresent) availability = 'UNAVAILABLE';
    else if (addToCartPresent || buyNowPresent) availability = 'AVAILABLE';

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
        bodyTextExcerpt,
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
