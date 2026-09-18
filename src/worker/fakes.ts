/**
 * Test doubles for the worker. No network, no Playwright: FakeAdapter replays a scripted queue of
 * observations (or delegates to a function); FakeExecutor is an in-memory cart/checkout/order store
 * that implements DemoSubmissionExecutor with configurable failure modes.
 */
import { randomUUID } from 'node:crypto';
import type { Observation, Provenance, PurchaseIntent } from '../domain/types.ts';
import { ObservationSchema, PurchaseIntentSchema } from '../domain/types.ts';
import type { CartLine } from '../domain/policy.ts';
import type { CartState, DemoSubmissionExecutor, ExecutorStepResult, ObserveRequest, ObservationAdapter } from '../adapters/types.ts';

// ---------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------

export function makeIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  const base: PurchaseIntent = {
    id: `mis_${randomUUID()}`,
    revision: 1,
    fulfillmentKey: `fkey_${randomUUID()}`,
    mode: 'demo',
    accountRef: 'local-test-account',
    target: {
      productUrl: 'http://127.0.0.1:4310/product/etb-1',
      retailerProductId: 'prod-1',
      variantId: 'var-1',
      sellerRef: 'seller-1',
      sellerEvidenceId: null,
      productFormat: 'Elite Trainer Box',
      language: 'EN',
      description: 'Test product for worker fakes',
    },
    quantity: 1,
    currency: 'SGD',
    maxDeliveredPriceMinor: 10_000,
    packagingPolicy: 'ask',
    allowedConditionEvidenceIds: [],
    launchAt: null,
    launchBasis: 'unknown',
    launchEvidenceId: null,
    restockWindow: { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: false },
    expiresAt: '2026-12-31T00:00:00.000Z',
    authority: 'demo_purchase',
  };
  const target = { ...base.target, ...(overrides.target ?? {}) };
  const restockWindow = { ...base.restockWindow, ...(overrides.restockWindow ?? {}) };
  return PurchaseIntentSchema.parse({ ...base, ...overrides, target, restockWindow });
}

export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const baseOffer = {
    retailerProductId: 'prod-1',
    variantId: 'var-1',
    variantLabel: 'Default',
    sellerRef: 'seller-1',
    sellerLabel: 'Test Seller',
    productFormat: 'Elite Trainer Box',
    language: 'EN',
    title: 'Test ETB',
    itemPriceMinor: 5000,
    deliveryFeeMinor: null as number | null,
    deliveredTotalMinor: null as number | null,
    packagingCondition: 'not_stated' as const,
    packagingEvidenceRegion: null as string | null,
    purchaseLimit: 1,
  };
  const base: Observation = {
    observationId: `obs_${randomUUID()}`,
    missionId: 'mission-under-test',
    evidenceId: `evd_${randomUUID()}`,
    provenance: 'demo',
    capturedAt: new Date().toISOString(),
    pageRevision: 'rev-1',
    availability: 'AVAILABLE',
    offer: baseOffer,
    accessControl: 'none',
    retryAfterSeconds: null,
    error: null,
  };
  const offer = overrides.offer === null ? null : { ...baseOffer, ...(overrides.offer ?? {}) };
  return ObservationSchema.parse({ ...base, ...overrides, offer });
}

// ---------------------------------------------------------------------
// FakeAdapter
// ---------------------------------------------------------------------

export class FakeAdapter implements ObservationAdapter {
  readonly name = 'fake-adapter';
  readonly provenance: Provenance = 'demo';
  readonly origin = 'http://127.0.0.1:4310';
  readonly calls: ObserveRequest[] = [];
  private readonly queue: Observation[];
  private readonly fn: ((req: ObserveRequest) => Observation) | null;

  constructor(script: Observation[] | ((req: ObserveRequest) => Observation)) {
    if (typeof script === 'function') {
      this.fn = script;
      this.queue = [];
    } else {
      this.fn = null;
      this.queue = [...script];
    }
  }

  async observeTarget(req: ObserveRequest): Promise<Observation> {
    this.calls.push(req);
    const next = this.fn ? this.fn(req) : this.queue.shift();
    if (!next) throw new Error('FakeAdapter script exhausted');
    return { ...next, missionId: req.missionId };
  }
}

// ---------------------------------------------------------------------
// FakeExecutor
// ---------------------------------------------------------------------

export interface FakeOrder {
  orderRef: string;
  status: string;
  quantity: number;
  totalMinor: number;
}

export interface FakeExecutorOptions {
  /** 'ok' (default), 'throw' (returns a hard error), or 'unclear' (merchant processes it but the response is lost). */
  addToCartBehavior?: 'ok' | 'throw' | 'unclear';
  /** 'ok' (default), 'unclear' (order is created but confirmation is lost), or 'sold_out' (clear non-submission failure). */
  submitBehavior?: 'ok' | 'unclear' | 'sold_out';
  /** When set (including null), findOrderForSession returns this instead of the natural in-memory lookup. */
  findOrderResult?: FakeOrder | null;
  deliveryFeeMinor?: number;
}

export class FakeExecutor implements DemoSubmissionExecutor {
  readonly mode = 'demo' as const;
  readonly origin = 'http://127.0.0.1:4310';
  readonly orders: FakeOrder[] = [];
  readonly calls: string[] = [];
  private cart: CartLine[] = [];
  private checkoutSessionId: string | null = null;
  private readonly pageRevision = 'cart-rev-1';

  constructor(public options: FakeExecutorOptions = {}) {}

  private itemPriceFor(_line: CartLine): number {
    return 5000; // matches makeObservation's default itemPriceMinor
  }

  private cartState(): CartState {
    const itemTotal = this.cart.reduce((n, l) => n + l.quantity * this.itemPriceFor(l), 0);
    const deliveryFee = this.options.deliveryFeeMinor ?? 300;
    const hasLines = this.cart.length > 0;
    return {
      lines: [...this.cart],
      deliveryFeeMinor: hasLines ? deliveryFee : null,
      itemTotalMinor: hasLines ? itemTotal : null,
      deliveredTotalMinor: hasLines ? itemTotal + deliveryFee : null,
      checkoutSessionId: this.checkoutSessionId,
      pageRevision: this.pageRevision,
    };
  }

  async readCart(_intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.calls.push('readCart');
    return { ok: true, value: this.cartState() };
  }

  async addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.calls.push('addOneToCart');
    if (this.options.addToCartBehavior === 'throw') return { ok: false, error: 'add to cart failed', outcomeUnclear: false };
    const existing = this.cart.find((l) => l.retailerProductId === intent.target.retailerProductId && l.variantId === intent.target.variantId);
    if (!existing) this.cart.push({ retailerProductId: intent.target.retailerProductId!, variantId: intent.target.variantId!, quantity: 1 });
    if (!this.checkoutSessionId) this.checkoutSessionId = `chk_${randomUUID()}`;
    if (this.options.addToCartBehavior === 'unclear') return { ok: false, error: 'add to cart response unclear', outcomeUnclear: true };
    return { ok: true, value: this.cartState() };
  }

  async reviewCheckout(_intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    this.calls.push('reviewCheckout');
    if (checkoutSessionId !== this.checkoutSessionId) return { ok: false, error: 'unknown checkout session', outcomeUnclear: false };
    return { ok: true, value: this.cartState() };
  }

  async submitDemoOrder(_intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<FakeOrder>> {
    this.calls.push('submitDemoOrder');
    if (checkoutSessionId !== this.checkoutSessionId) return { ok: false, error: 'unknown checkout session', outcomeUnclear: false };
    const behavior = this.options.submitBehavior ?? 'ok';
    if (behavior === 'sold_out') return { ok: false, error: '409 sold out', outcomeUnclear: false };
    const order: FakeOrder = { orderRef: `ord_${randomUUID()}`, status: 'CONFIRMED', quantity: 1, totalMinor: this.cartState().deliveredTotalMinor ?? 0 };
    if (behavior === 'unclear') {
      // The merchant actually processed the order; only the confirmation response was lost.
      this.orders.push(order);
      return { ok: false, error: 'submission response timed out', outcomeUnclear: true };
    }
    this.orders.push(order);
    return { ok: true, value: order };
  }

  async findOrderForSession(checkoutSessionId: string): Promise<ExecutorStepResult<FakeOrder | null>> {
    this.calls.push('findOrderForSession');
    if (this.options.findOrderResult !== undefined) return { ok: true, value: this.options.findOrderResult };
    if (checkoutSessionId === this.checkoutSessionId && this.orders.length > 0) return { ok: true, value: this.orders[this.orders.length - 1]! };
    return { ok: true, value: null };
  }

  async close(): Promise<void> {}

  /** Test helper: force findOrderForSession's next results (simulates delayed merchant confirmation). */
  setFindOrderResult(order: FakeOrder | null): void {
    this.options.findOrderResult = order;
  }
}
