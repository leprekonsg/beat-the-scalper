/**
 * Demo storefront HTTP contract (no browser). Covers the server-side protections the agent must not
 * be able to talk its way around: purchase limit one (A12/A14/A17), the delivery-fee rule that feeds
 * the delivered-total budget check (A11), submit idempotency per checkout session (A12/A19/A20),
 * sold-out-before-submission (A15), the injectable faults (A16), admin/storefront origin separation
 * (section 9: the agent may never read test/admin controls or future restock data), and scheduled
 * restocks driven by the injected clock (A03).
 *
 * Each test gets its own store instance, its own SQLite file and its own controllable clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDemoStore, type DemoStoreHandle } from '../../demo/store/server.ts';

const START_AT = new Date('2026-09-25T05:00:00.000Z'); // 13:00 Asia/Singapore

let workDir: string;
let store: DemoStoreHandle;
let clockMs: number;

function advanceClock(ms: number): void {
  clockMs += ms;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bts-demo-http-'));
  clockMs = START_AT.getTime();
  store = await startDemoStore({
    storePort: 0,
    adminPort: 0,
    dbPath: join(workDir, 'demo-store.sqlite'),
    clock: () => new Date(clockMs),
  });
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

// --- tiny HTML helpers (the storefront is server-rendered, attribute-addressable HTML) ----------

function attr(html: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m?.[1] ?? null;
}
function intAttr(html: string, name: string): number | null {
  const raw = attr(html, name);
  return raw === null ? null : Number.parseInt(raw, 10);
}
function cartLineCount(html: string): number {
  // The bare marker attribute only; `data-bts-cart-line-price-minor` must not count as a line.
  return (html.match(/data-bts-cart-line(?![\w-])/g) ?? []).length;
}

function newCartCookie(): string {
  return `bts_demo_cart=cart_${randomUUID()}`;
}

function storeGet(path: string, cookie?: string): Promise<Response> {
  return fetch(`${store.storeOrigin}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}
function storePostForm(path: string, form: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${store.storeOrigin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  });
}
async function adminPost(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${store.adminOrigin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok, `admin ${path} failed with ${res.status}`).toBe(true);
  return res;
}
async function adminOrders(): Promise<{ orderRef: string; quantity: number; totalMinor: number; sessionId: string }[]> {
  const res = await fetch(`${store.adminOrigin}/admin/orders`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { orderRef: string; quantity: number; totalMinor: number; sessionId: string }[];
}
async function adminIncidentTypes(): Promise<string[]> {
  const res = await fetch(`${store.adminOrigin}/admin/state`);
  expect(res.ok).toBe(true);
  const state = (await res.json()) as { incidents: { type: string }[] };
  return state.incidents.map((i) => i.type);
}
async function variantStock(productId: string, variantId: string): Promise<number | undefined> {
  const res = await fetch(`${store.adminOrigin}/admin/state`);
  const state = (await res.json()) as { products: { productId: string; variants: { variantId: string; stock: number }[] }[] };
  return state.products.find((p) => p.productId === productId)?.variants.find((v) => v.variantId === variantId)?.stock;
}

/** Cart -> checkout session id, as the storefront hands it out (303 to /checkout/:id). */
async function startCheckout(cookie: string): Promise<string> {
  const res = await storePostForm('/checkout/start', {}, cookie);
  expect(res.status).toBe(303);
  const location = res.headers.get('location') ?? '';
  const match = /\/checkout\/([^/?#]+)/.exec(location);
  expect(match, `checkout/start did not redirect to a session (location=${location})`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('demo storefront: cart and purchase limit', () => {
  it('enforces purchase limit one server-side, whatever the client posts (A12, A14, A17)', async () => {
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });
    const cookie = newCartCookie();

    const first = await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    expect(first.status).toBe(303);

    // A duplicate add (retry / duplicate scheduler tick) must not become quantity two.
    const second = await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    expect(second.status).toBe(303);

    // A client asking for more than one is forced back to one and recorded as an incident.
    const override = await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '99' }, cookie);
    expect(override.status).toBe(303);

    const cart = await (await storeGet('/cart', cookie)).text();
    expect(cartLineCount(cart)).toBe(1);
    expect(intAttr(cart, 'data-bts-cart-qty')).toBe(1);

    const incidents = await adminIncidentTypes();
    expect(incidents).toContain('purchase_limit_reached');
    expect(incidents).toContain('qty_override_rejected');
  });
});

describe('demo storefront: delivery fee rule', () => {
  it('charges 299 minor units under a 10000 item total and 0 at or above it (A11)', async () => {
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });

    const underCookie = newCartCookie();
    await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, underCookie);
    const underSession = await startCheckout(underCookie);
    const underHtml = await (await storeGet(`/checkout/${underSession}`, underCookie)).text();
    expect(intAttr(underHtml, 'data-bts-item-total-minor')).toBe(9990);
    expect(intAttr(underHtml, 'data-bts-delivery-fee-minor')).toBe(299);
    expect(intAttr(underHtml, 'data-bts-delivered-total-minor')).toBe(10289);

    // The seeded bundle is 19980 minor units: at/over the threshold delivery is free.
    const overCookie = newCartCookie();
    await storePostForm('/cart/add', { product_id: 'etb-151-bundle', variant_id: 'en', qty: '1' }, overCookie);
    const overSession = await startCheckout(overCookie);
    const overHtml = await (await storeGet(`/checkout/${overSession}`, overCookie)).text();
    expect(intAttr(overHtml, 'data-bts-item-total-minor')).toBe(19980);
    expect(intAttr(overHtml, 'data-bts-delivery-fee-minor')).toBe(0);
    expect(intAttr(overHtml, 'data-bts-delivered-total-minor')).toBe(19980);
  });
});

describe('demo storefront: submission', () => {
  it('is idempotent per checkout session: a second submit returns the same order and creates none (A12, A19, A20)', async () => {
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });
    const cookie = newCartCookie();
    await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    const session = await startCheckout(cookie);

    const firstRes = await storePostForm(`/checkout/${session}/submit`, {}, cookie);
    expect(firstRes.status).toBe(200);
    const firstHtml = await firstRes.text();
    const orderRef = attr(firstHtml, 'data-bts-order-ref');
    expect(orderRef).toMatch(/^ord_/);
    expect(intAttr(firstHtml, 'data-bts-order-qty')).toBe(1);
    expect(intAttr(firstHtml, 'data-bts-order-total-minor')).toBe(10289);

    const secondRes = await storePostForm(`/checkout/${session}/submit`, {}, cookie);
    expect(secondRes.status).toBe(200);
    const secondHtml = await secondRes.text();
    expect(attr(secondHtml, 'data-bts-order-ref')).toBe(orderRef);

    const orders = await adminOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderRef).toBe(orderRef);
    expect(orders[0]?.quantity).toBe(1);

    // Stock moved exactly once.
    expect(await variantStock('etb-151', 'en')).toBe(4);
  });

  it('returns 409 and creates no order when stock hits zero before submission (A15)', async () => {
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 1 });
    const cookie = newCartCookie();
    await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    const session = await startCheckout(cookie);

    // Someone else buys the last unit between review and submit.
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 0 });

    const res = await storePostForm(`/checkout/${session}/submit`, {}, cookie);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(attr(html, 'data-bts-error')).toBe('sold_out');
    expect(html).not.toMatch(/data-bts-order-ref/);

    expect(await adminOrders()).toHaveLength(0);
    expect(await adminIncidentTypes()).toContain('sold_out_before_submission');

    const orderLookup = (await (await storeGet(`/api/orders?session=${session}`)).json()) as { order: unknown };
    expect(orderLookup.order).toBeNull();
  });
});

describe('demo storefront: injectable faults (A16)', () => {
  it('serves a captcha challenge page instead of the product when captchaOnProduct is set', async () => {
    await adminPost('/admin/faults', { captchaOnProduct: true });
    const res = await storeGet('/product/etb-151?variant=en');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(attr(html, 'data-bts-access-control')).toBe('captcha');
    expect(html).not.toMatch(/data-bts-product-id/);

    await adminPost('/admin/faults', { captchaOnProduct: false });
    const cleared = await (await storeGet('/product/etb-151?variant=en')).text();
    expect(attr(cleared, 'data-bts-product-id')).toBe('etb-151');
  });

  it('returns 429 with Retry-After when rateLimitOnProduct is set', async () => {
    await adminPost('/admin/faults', { rateLimitOnProduct: { retryAfterSeconds: 42 } });
    const res = await storeGet('/product/etb-151?variant=en');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    await res.text();

    await adminPost('/admin/faults', { rateLimitOnProduct: null });
    const cleared = await storeGet('/product/etb-151?variant=en');
    expect(cleared.status).toBe(200);
    await cleared.text();
  });

  it('failAddToCartOnce fails the response once while the line is already in the cart, and a retry never doubles it (A15, A14)', async () => {
    await adminPost('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });
    await adminPost('/admin/faults', { failAddToCartOnce: true });
    const cookie = newCartCookie();

    const failed = await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    expect(failed.status).toBe(500);
    await failed.text();

    // The outcome is only resolvable by re-reading the cart: the line went in before the fault fired.
    const afterFault = await (await storeGet('/cart', cookie)).text();
    expect(cartLineCount(afterFault)).toBe(1);
    expect(intAttr(afterFault, 'data-bts-cart-qty')).toBe(1);

    // The fault is one-shot; a blind retry succeeds at the HTTP level but the limit keeps quantity at one.
    const retry = await storePostForm('/cart/add', { product_id: 'etb-151', variant_id: 'en', qty: '1' }, cookie);
    expect(retry.status).toBe(303);
    const afterRetry = await (await storeGet('/cart', cookie)).text();
    expect(cartLineCount(afterRetry)).toBe(1);
    expect(intAttr(afterRetry, 'data-bts-cart-qty')).toBe(1);
  });
});

describe('demo storefront: admin separation (section 9)', () => {
  it('does not expose any admin route on the storefront origin', async () => {
    const storePort = new URL(store.storeOrigin).port;
    const adminPort = new URL(store.adminOrigin).port;
    expect(storePort).not.toBe(adminPort);

    for (const path of ['/admin/state', '/admin/orders', '/admin/faults', '/admin/schedule-restock']) {
      const res = await storeGet(path);
      expect(res.status, `${path} must not be served by the storefront`).toBe(404);
      const body = await res.text();
      expect(body).not.toMatch(/scheduled_restocks|"faults"|"incidents"/);
    }

    // Mutating admin controls are equally absent: a POST to the storefront cannot set stock.
    const attempt = await fetch(`${store.storeOrigin}/admin/stock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'etb-151', variantId: 'en', quantity: 99 }),
    });
    expect(attempt.status).toBe(404);
    await attempt.text();
    expect(await variantStock('etb-151', 'en')).toBe(0);

    // Future restock data is not readable from the storefront either.
    await adminPost('/admin/schedule-restock', {
      productId: 'etb-151',
      variantId: 'en',
      quantity: 3,
      atIso: new Date(clockMs + 60_000).toISOString(),
    });
    const productHtml = await (await storeGet('/product/etb-151?variant=en')).text();
    expect(productHtml).not.toMatch(/restock|scheduled/i);
    expect(attr(productHtml, 'data-bts-availability')).toBe('UNAVAILABLE');
  });
});

describe('demo storefront: scheduled restock (A03)', () => {
  it('flips availability only once the injected clock passes the scheduled time', async () => {
    const before = await (await storeGet('/product/etb-151?variant=en')).text();
    expect(attr(before, 'data-bts-availability')).toBe('UNAVAILABLE');
    const revisionBefore = attr(before, 'data-bts-page-revision');

    await adminPost('/admin/schedule-restock', {
      productId: 'etb-151',
      variantId: 'en',
      quantity: 4,
      atIso: new Date(clockMs + 90_000).toISOString(),
    });

    // Still in the future: nothing changes, and the page gives away nothing about the schedule.
    advanceClock(60_000);
    const during = await (await storeGet('/product/etb-151?variant=en')).text();
    expect(attr(during, 'data-bts-availability')).toBe('UNAVAILABLE');
    expect(attr(during, 'data-bts-page-revision')).toBe(revisionBefore);

    // Past the scheduled instant: the next storefront read applies the restock.
    advanceClock(31_000);
    const after = await (await storeGet('/product/etb-151?variant=en')).text();
    expect(attr(after, 'data-bts-availability')).toBe('AVAILABLE');
    expect(attr(after, 'data-bts-page-revision')).not.toBe(revisionBefore);
    expect(intAttr(after, 'data-bts-price-minor')).toBe(9990);
    expect(intAttr(after, 'data-bts-purchase-limit')).toBe(1);

    expect(await adminIncidentTypes()).toContain('restock_applied');

    // Applied exactly once, even after further reads.
    await (await storeGet('/product/etb-151?variant=en')).text();
    expect(await variantStock('etb-151', 'en')).toBe(4);
  });
});
