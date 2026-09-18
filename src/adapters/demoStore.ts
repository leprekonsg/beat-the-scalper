/**
 * Demo store adapter/executor (BTS_FABLE_BUILD_PLAN.md sections 9 and 12). Talks only to the owned
 * demo storefront origin over a Playwright persistent context. `createDemoBrowser` enforces a hard
 * origin allowlist at the network layer (page/context routing); the adapter and executor additionally
 * reject any intent whose `target.productUrl` origin differs from the configured store origin with an
 * explicit thrown error (A26) rather than a soft "ineligible" result.
 *
 * Never uses `page.evaluate` with arbitrary strings; DOM reads go through locators and stable
 * `data-bts-*` attributes rendered by demo/store/server.ts. Cookies are never logged.
 */
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Availability, Evidence, Observation, OfferedItem, PackagingCondition, Provenance, PurchaseIntent } from '../domain/types.ts';
import { EvidenceSchema, ObservationSchema } from '../domain/types.ts';
import { planCart, type CartLine } from '../domain/policy.ts';
import type { CartState, DemoSubmissionExecutor, ExecutorStepResult, ObservationAdapter, ObserveRequest } from './types.ts';

const DEFAULT_NAV_TIMEOUT_MS = 10_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 8_000;
const DEFAULT_ATTR_TIMEOUT_MS = 5_000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A26: the demo adapter/executor may only ever touch the configured demo store origin. */
function assertSameOrigin(url: string, expectedOrigin: string): void {
  let actual: string;
  try {
    actual = new URL(url).origin;
  } catch {
    throw new Error(`Refusing to act on an invalid product URL "${url}"; the demo executor is restricted to origin ${expectedOrigin} (A26)`);
  }
  if (actual !== expectedOrigin) {
    throw new Error(`Refusing cross-origin target "${actual}"; the demo adapter/executor is restricted to origin ${expectedOrigin} (A26)`);
  }
}

// ---------------------------------------------------------------------------
// Browser factory
// ---------------------------------------------------------------------------

export interface DemoIncident {
  type: string;
  detail: string;
  at: string;
}

export interface CreateDemoBrowserOptions {
  storeOrigin: string;
  headless?: boolean;
  profileDir?: string;
  /** Base data directory; the default profile dir is `${dataDir}/.browser-profiles/demo`. */
  dataDir?: string;
  onIncident?: (incident: DemoIncident) => void;
}

export interface DemoBrowserHandle {
  page: Page;
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Launches a persistent Chromium context in a dedicated profile dir and installs a hard origin
 * allowlist: any request whose origin is not `storeOrigin` is aborted and reported as an
 * `origin_blocked` incident. This is the primary network-layer enforcement backing A26.
 */
export async function createDemoBrowser(opts: CreateDemoBrowserOptions): Promise<DemoBrowserHandle> {
  const dataDir = opts.dataDir ? resolve(opts.dataDir) : resolve(process.cwd(), 'data');
  const profileDir = opts.profileDir ? resolve(opts.profileDir) : resolve(dataDir, '.browser-profiles', 'demo');
  mkdirSync(profileDir, { recursive: true });
  const allowedOrigin = new URL(opts.storeOrigin).origin;

  const context = await chromium.launchPersistentContext(profileDir, { headless: opts.headless ?? true });

  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    let originOk = false;
    try {
      originOk = new URL(requestUrl).origin === allowedOrigin;
    } catch {
      originOk = false;
    }
    if (!originOk) {
      opts.onIncident?.({ type: 'origin_blocked', detail: requestUrl, at: new Date().toISOString() });
      await route.abort();
      return;
    }
    await route.continue();
  });

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    page,
    context,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared constructor options (both DemoStoreAdapter and DemoStoreExecutor accept this shape)
// ---------------------------------------------------------------------------

export interface DemoStoreSharedOptions {
  page: Page;
  storeOrigin: string;
  now?: () => Date;
  /** Only consumed by DemoStoreAdapter; ignored by DemoStoreExecutor. */
  onEvidence?: (evidence: Evidence) => void;
  /** Base data directory; screenshots are written to `${dataDir}/evidence/<evidenceId>.png`. */
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Observation adapter
// ---------------------------------------------------------------------------

export class DemoStoreAdapter implements ObservationAdapter {
  readonly name = 'demo-store';
  readonly provenance: Provenance = 'demo';
  readonly origin: string;
  private readonly page: Page;
  private readonly now: () => Date;
  private readonly onEvidence: ((e: Evidence) => void) | undefined;
  private readonly evidenceDir: string;

  constructor(opts: DemoStoreSharedOptions) {
    this.page = opts.page;
    this.origin = new URL(opts.storeOrigin).origin;
    this.now = opts.now ?? (() => new Date());
    this.onEvidence = opts.onEvidence;
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
    sourceUrl: string | null;
  }): Evidence {
    return EvidenceSchema.parse({
      evidenceId: args.evidenceId,
      sourceKind: 'demo',
      provenance: 'demo',
      sourceUrl: args.sourceUrl,
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

  private unknownObservation(
    missionId: string,
    capturedAt: string,
    error: string,
    accessControl: Observation['accessControl'] = 'none',
    retryAfterSeconds: number | null = null,
    evidenceId?: string,
    evidence?: Evidence | null,
  ): Observation {
    if (evidence) this.onEvidence?.(evidence);
    return ObservationSchema.parse({
      observationId: `obs_${randomUUID()}`,
      missionId,
      evidenceId: evidenceId ?? `evd_${randomUUID()}`,
      provenance: 'demo',
      capturedAt,
      pageRevision: accessControl === 'none' ? 'nav-error' : accessControl,
      availability: 'UNKNOWN',
      offer: null,
      accessControl,
      retryAfterSeconds,
      error,
    });
  }

  async observeTarget(req: ObserveRequest): Promise<Observation> {
    const capturedAt = this.now().toISOString();
    const productUrl = req.intent.target.productUrl;
    if (!productUrl) {
      return this.unknownObservation(req.missionId, capturedAt, 'Intent has no productUrl to observe');
    }
    // A26: reject cross-origin targets outright rather than returning a soft UNKNOWN result.
    assertSameOrigin(productUrl, this.origin);

    let response: Response | null = null;
    try {
      response = await this.page.goto(productUrl, { waitUntil: 'load', timeout: DEFAULT_NAV_TIMEOUT_MS });
    } catch (err) {
      const evidenceId = `evd_${randomUUID()}`;
      const snapshotRef = await this.captureScreenshot(evidenceId);
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: null,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: {},
        snapshotRef,
        sourceUrl: productUrl,
      });
      return this.unknownObservation(req.missionId, capturedAt, `Navigation failed: ${describeError(err)}`, 'none', null, evidenceId, evidence);
    }

    const evidenceId = `evd_${randomUUID()}`;
    const snapshotRef = await this.captureScreenshot(evidenceId);
    const statusCode = response?.status() ?? 0;

    if (statusCode === 429) {
      const retryAfterHeader = response?.headers()['retry-after'] ?? null;
      const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: 'http-429',
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: { httpStatus: 429 },
        snapshotRef,
        sourceUrl: productUrl,
      });
      return this.unknownObservation(req.missionId, capturedAt, 'Rate limited by demo store (HTTP 429)', 'rate_limited', retryAfterSeconds, evidenceId, evidence);
    }

    const accessControlLocator = this.page.locator('[data-bts-access-control]');
    if ((await accessControlLocator.count()) > 0) {
      const value = await accessControlLocator.first().getAttribute('data-bts-access-control', { timeout: DEFAULT_ATTR_TIMEOUT_MS });
      if (value === 'captcha') {
        const evidence = this.buildEvidence({
          evidenceId,
          capturedAt,
          pageRevision: 'captcha',
          targetRef: req.intent.target.retailerProductId,
          variantRef: req.intent.target.variantId,
          observedFields: { accessControl: 'captcha' },
          snapshotRef,
          sourceUrl: productUrl,
        });
        return this.unknownObservation(req.missionId, capturedAt, 'CAPTCHA challenge presented; no bypass attempted', 'captcha', null, evidenceId, evidence);
      }
    }

    const container = this.page.locator('[data-bts-product-id]').first();
    if ((await this.page.locator('[data-bts-product-id]').count()) === 0) {
      const evidence = this.buildEvidence({
        evidenceId,
        capturedAt,
        pageRevision: 'unsupported-layout',
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        observedFields: {},
        snapshotRef,
        sourceUrl: productUrl,
      });
      return this.unknownObservation(req.missionId, capturedAt, 'Expected data-bts-* product attributes were absent (unsupported layout)', 'unsupported_layout', null, evidenceId, evidence);
    }

    const attr = (name: string): Promise<string | null> => container.getAttribute(name, { timeout: DEFAULT_ATTR_TIMEOUT_MS });
    const [productId, variantId, variantLabel, sellerRef, sellerLabel, format, language, priceMinorStr, availabilityStr, pageRevision, purchaseLimitStr, productTitle] = await Promise.all([
      attr('data-bts-product-id'),
      attr('data-bts-variant-id'),
      attr('data-bts-variant-label'),
      attr('data-bts-seller-ref'),
      attr('data-bts-seller-label'),
      attr('data-bts-format'),
      attr('data-bts-language'),
      attr('data-bts-price-minor'),
      attr('data-bts-availability'),
      attr('data-bts-page-revision'),
      attr('data-bts-purchase-limit'),
      attr('data-bts-product-title'),
    ]);

    const hasNotice = (await this.page.locator('[data-bts-packaging-notice]').count()) > 0;
    const packagingCondition: PackagingCondition = hasNotice ? 'stated_removed' : 'not_stated';
    const availability: Availability = availabilityStr === 'AVAILABLE' ? 'AVAILABLE' : availabilityStr === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN';

    const offer: OfferedItem = {
      retailerProductId: productId,
      variantId,
      variantLabel,
      sellerRef,
      sellerLabel,
      productFormat: format,
      language,
      title: productTitle || variantLabel,
      itemPriceMinor: priceMinorStr ? Number.parseInt(priceMinorStr, 10) : null,
      deliveryFeeMinor: null,
      deliveredTotalMinor: null,
      packagingCondition,
      packagingEvidenceRegion: hasNotice ? 'packaging-notice-banner' : null,
      purchaseLimit: purchaseLimitStr ? Number.parseInt(purchaseLimitStr, 10) : null,
    };

    const finalPageRevision = pageRevision ?? 'unknown';
    const evidence = this.buildEvidence({
      evidenceId,
      capturedAt,
      pageRevision: finalPageRevision,
      targetRef: productId,
      variantRef: variantId,
      observedFields: offer as unknown as Record<string, unknown>,
      snapshotRef,
      sourceUrl: productUrl,
    });
    this.onEvidence?.(evidence);

    return ObservationSchema.parse({
      observationId: `obs_${randomUUID()}`,
      missionId: req.missionId,
      evidenceId,
      provenance: 'demo',
      capturedAt,
      pageRevision: finalPageRevision,
      availability,
      offer,
      accessControl: 'none',
      retryAfterSeconds: null,
      error: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Preparation / submission executor
// ---------------------------------------------------------------------------

export class DemoStoreExecutor implements DemoSubmissionExecutor {
  readonly mode = 'demo' as const;
  readonly origin: string;
  private readonly page: Page;

  constructor(opts: DemoStoreSharedOptions) {
    this.page = opts.page;
    this.origin = new URL(opts.storeOrigin).origin;
  }

  private assertIntentOrigin(intent: PurchaseIntent): void {
    if (intent.target.productUrl) assertSameOrigin(intent.target.productUrl, this.origin);
  }

  async readCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.assertIntentOrigin(intent);
    try {
      await this.page.goto(`${this.origin}/cart`, { waitUntil: 'load', timeout: DEFAULT_NAV_TIMEOUT_MS });
      return { ok: true, value: await this.parseCartFromPage() };
    } catch (err) {
      return { ok: false, error: `readCart failed: ${describeError(err)}`, outcomeUnclear: false };
    }
  }

  /** Detects existing target quantity via planCart (A14) before ever submitting the add form. */
  async addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.assertIntentOrigin(intent);
    const current = await this.readCart(intent);
    if (!current.ok) return current;

    const plan = planCart(intent, current.value.lines);
    if (plan.action !== 'add_one') return { ok: true, value: current.value };

    const productId = intent.target.retailerProductId ?? '';
    const variantId = intent.target.variantId ?? '';
    try {
      const response = await this.page.request.post(`${this.origin}/cart/add`, {
        form: { product_id: productId, variant_id: variantId, qty: '1' },
        timeout: DEFAULT_NAV_TIMEOUT_MS,
      });
      if (response.status() >= 500) {
        // Outcome unclear from the HTTP layer alone: the fault contract adds the line before
        // failing, so only a re-read (not the failed status) can resolve what actually happened.
        const reread = await this.readCart(intent);
        if (!reread.ok) return { ok: false, error: `add-to-cart returned HTTP ${response.status()} and the re-read also failed: ${reread.error}`, outcomeUnclear: true };
        return { ok: true, value: reread.value };
      }
      const reread = await this.readCart(intent);
      if (!reread.ok) return { ok: false, error: `add-to-cart succeeded but the re-read failed: ${reread.error}`, outcomeUnclear: true };
      return { ok: true, value: reread.value };
    } catch (err) {
      const reread = await this.readCart(intent);
      if (!reread.ok) return { ok: false, error: `add-to-cart threw (${describeError(err)}) and the re-read also failed: ${reread.error}`, outcomeUnclear: true };
      return { ok: true, value: reread.value };
    }
  }

  async reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    this.assertIntentOrigin(intent);
    try {
      let sessionId = checkoutSessionId;
      if (!sessionId) {
        const response = await this.page.request.post(`${this.origin}/checkout/start`, { timeout: DEFAULT_NAV_TIMEOUT_MS });
        const finalUrl = response.url();
        const match = /\/checkout\/([^/?#]+)/.exec(finalUrl);
        if (!match) return { ok: false, error: `checkout/start did not resolve to a session (landed on ${finalUrl})`, outcomeUnclear: false };
        sessionId = match[1]!;
      }
      await this.page.goto(`${this.origin}/checkout/${sessionId}`, { waitUntil: 'load', timeout: DEFAULT_NAV_TIMEOUT_MS });
      return { ok: true, value: await this.parseCheckoutPage(sessionId) };
    } catch (err) {
      return { ok: false, error: `reviewCheckout failed: ${describeError(err)}`, outcomeUnclear: false };
    }
  }

  async findOrderForSession(checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number } | null>> {
    try {
      const response = await this.page.request.get(`${this.origin}/api/orders?session=${encodeURIComponent(checkoutSessionId)}`, { timeout: DEFAULT_NAV_TIMEOUT_MS });
      const body = (await response.json()) as { order: { orderRef: string; status: string; quantity: number; totalMinor: number } | null };
      return { ok: true, value: body.order ?? null };
    } catch (err) {
      return { ok: false, error: `findOrderForSession failed: ${describeError(err)}`, outcomeUnclear: false };
    }
  }

  /** Clicks the real submit control with a bounded timeout; a timeout leaves the outcome UNKNOWN (A20). */
  async submitDemoOrder(intent: PurchaseIntent, _checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number }>> {
    this.assertIntentOrigin(intent);
    const button = this.page.locator('[data-bts-control="place-order"]');
    try {
      await button.click({ timeout: DEFAULT_SUBMIT_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, error: `Submission did not complete within ${DEFAULT_SUBMIT_TIMEOUT_MS}ms: ${describeError(err)}`, outcomeUnclear: true };
    }
    const orderContainer = this.page.locator('[data-bts-order-ref]');
    if ((await orderContainer.count()) === 0) {
      return { ok: false, error: 'Order confirmation page did not render the expected attributes after submission', outcomeUnclear: true };
    }
    const attr = (name: string): Promise<string | null> => orderContainer.getAttribute(name, { timeout: DEFAULT_ATTR_TIMEOUT_MS });
    const [orderRef, status, qtyStr, totalStr] = await Promise.all([
      attr('data-bts-order-ref'),
      attr('data-bts-order-status'),
      attr('data-bts-order-qty'),
      attr('data-bts-order-total-minor'),
    ]);
    if (!orderRef || !status || qtyStr === null || totalStr === null) {
      return { ok: false, error: 'Order confirmation page is missing required order fields', outcomeUnclear: true };
    }
    return { ok: true, value: { orderRef, status, quantity: Number.parseInt(qtyStr, 10), totalMinor: Number.parseInt(totalStr, 10) } };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    // The page/context lifecycle is owned by createDemoBrowser(); nothing to release here.
  }

  private async parseCartLines(): Promise<CartLine[]> {
    const lineEls = this.page.locator('[data-bts-cart-line]');
    const count = await lineEls.count();
    const lines: CartLine[] = [];
    for (let i = 0; i < count; i++) {
      const el = lineEls.nth(i);
      const [productId, variantId, qtyStr] = await Promise.all([
        el.getAttribute('data-bts-cart-product-id', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
        el.getAttribute('data-bts-cart-variant-id', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
        el.getAttribute('data-bts-cart-qty', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
      ]);
      if (productId && variantId && qtyStr) {
        lines.push({ retailerProductId: productId, variantId, quantity: Number.parseInt(qtyStr, 10) });
      }
    }
    return lines;
  }

  private async parseCartFromPage(): Promise<CartState> {
    const container = this.page.locator('[data-bts-cart-container]');
    const [sessionAttr, revisionAttr] = await Promise.all([
      container.getAttribute('data-bts-checkout-session', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
      container.getAttribute('data-bts-page-revision', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
    ]);
    const lines = await this.parseCartLines();
    return {
      lines,
      deliveryFeeMinor: null,
      itemTotalMinor: null,
      deliveredTotalMinor: null,
      checkoutSessionId: sessionAttr && sessionAttr.length > 0 ? sessionAttr : null,
      pageRevision: revisionAttr ?? 'cart-unknown',
    };
  }

  private async parseCheckoutPage(sessionId: string): Promise<CartState> {
    const container = this.page.locator('[data-bts-checkout-session]');
    const [itemTotalStr, deliveryFeeStr, deliveredTotalStr, revisionAttr] = await Promise.all([
      container.getAttribute('data-bts-item-total-minor', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
      container.getAttribute('data-bts-delivery-fee-minor', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
      container.getAttribute('data-bts-delivered-total-minor', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
      container.getAttribute('data-bts-page-revision', { timeout: DEFAULT_ATTR_TIMEOUT_MS }),
    ]);
    const lines = await this.parseCartLines();
    return {
      lines,
      itemTotalMinor: itemTotalStr !== null ? Number.parseInt(itemTotalStr, 10) : null,
      deliveryFeeMinor: deliveryFeeStr !== null ? Number.parseInt(deliveryFeeStr, 10) : null,
      deliveredTotalMinor: deliveredTotalStr !== null ? Number.parseInt(deliveredTotalStr, 10) : null,
      checkoutSessionId: sessionId,
      pageRevision: revisionAttr ?? 'checkout-unknown',
    };
  }
}
