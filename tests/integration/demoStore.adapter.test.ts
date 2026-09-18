/**
 * DemoStoreAdapter / DemoStoreExecutor against the real storefront through headless Chromium.
 *
 * Covers the action-boundary behaviour of BTS_FABLE_BUILD_PLAN.md section 9 that only shows up with
 * a real browser: what the adapter can read off the page, how access controls surface (A16), that a
 * second add-to-cart never becomes quantity two (A14), that a failed add is resolved by re-reading
 * rather than retrying blindly (A15), that a delayed confirmation leaves the outcome unclear instead
 * of resubmitting (A20/A19), and that a non-demo origin is refused outright (A26).
 *
 * One Chromium instance, one storefront, one temp profile/evidence dir; carts are isolated per test
 * by clearing context cookies. Keep this file's wall clock modest: the A20 case intentionally burns
 * ~10s waiting out the injected confirmation delay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoStore, type DemoStoreHandle } from '../../demo/store/server.ts';
import {
  createDemoBrowser,
  DemoStoreAdapter,
  DemoStoreExecutor,
  type DemoBrowserHandle,
  type DemoIncident,
} from '../../src/adapters/demoStore.ts';
import type { ObserveRequest } from '../../src/adapters/types.ts';
import type { Evidence, PurchaseIntent } from '../../src/domain/types.ts';
import { makeIntent } from '../unit/builders.ts';

const TEST_TIMEOUT_MS = 30_000;
/** The executor's own submit timeout is 8s; the A20 fault must land safely past it. */
const DELAYED_CONFIRMATION_MS = 9_500;
const A20_TIMEOUT_MS = 45_000;

let workDir: string;
let dataDir: string;
let store: DemoStoreHandle;
let browser: DemoBrowserHandle;
let adapter: DemoStoreAdapter;
let executor: DemoStoreExecutor;
const evidenceLog: Evidence[] = [];
const incidents: DemoIncident[] = [];

function demoIntent(productUrl?: string): PurchaseIntent {
  return makeIntent(
    { maxDeliveredPriceMinor: 20_000, packagingPolicy: 'ask' },
    {
      productUrl: productUrl ?? `${store.storeOrigin}/product/etb-151?variant=en`,
      retailerProductId: 'etb-151',
      variantId: 'en',
      sellerRef: 'pokemon-store-online-sg',
      sellerEvidenceId: null,
      productFormat: 'Elite Trainer Box',
      language: 'English',
      description: 'Pokemon TCG Scarlet & Violet 151 Elite Trainer Box, English, one unit',
    },
  );
}

function observeRequest(intent: PurchaseIntent): ObserveRequest {
  return { missionId: 'msn_integration_1', intent, now: new Date().toISOString() };
}

async function setFaults(patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${store.adminOrigin}/admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(res.ok, `admin/faults failed with ${res.status}`).toBe(true);
  await res.json();
}
async function setStock(quantity: number): Promise<void> {
  const res = await fetch(`${store.adminOrigin}/admin/stock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'etb-151', variantId: 'en', quantity }),
  });
  expect(res.ok, `admin/stock failed with ${res.status}`).toBe(true);
  await res.json();
}
async function adminOrders(): Promise<{ orderRef: string; quantity: number; totalMinor: number }[]> {
  const res = await fetch(`${store.adminOrigin}/admin/orders`);
  return (await res.json()) as { orderRef: string; quantity: number; totalMinor: number }[];
}

/** A fresh cart for the next test: the storefront keys carts off one HttpOnly cookie. */
async function freshCart(): Promise<void> {
  await browser.context.clearCookies();
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bts-demo-adapter-'));
  dataDir = join(workDir, 'data');
  store = await startDemoStore({ storePort: 0, adminPort: 0, dbPath: join(workDir, 'demo-store.sqlite') });
  browser = await createDemoBrowser({
    storeOrigin: store.storeOrigin,
    headless: true,
    dataDir,
    onIncident: (incident) => incidents.push(incident),
  });
  adapter = new DemoStoreAdapter({
    page: browser.page,
    storeOrigin: store.storeOrigin,
    now: () => new Date(),
    onEvidence: (e) => evidenceLog.push(e),
    dataDir,
  });
  executor = new DemoStoreExecutor({ page: browser.page, storeOrigin: store.storeOrigin });
  await setStock(5);
});

afterAll(async () => {
  await executor?.close();
  await browser?.close();
  await store?.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('DemoStoreAdapter observation', () => {
  it(
    'reads availability, price, packaging notice, purchase limit and writes screenshot evidence',
    async () => {
      const before = evidenceLog.length;
      const obs = await adapter.observeTarget(observeRequest(demoIntent()));

      expect(obs.error).toBeNull();
      expect(obs.accessControl).toBe('none');
      expect(obs.availability).toBe('AVAILABLE');
      expect(obs.pageRevision).toMatch(/^[0-9a-f]{16}$/);

      const offer = obs.offer;
      expect(offer).not.toBeNull();
      expect(offer?.retailerProductId).toBe('etb-151');
      expect(offer?.variantId).toBe('en');
      expect(offer?.sellerRef).toBe('pokemon-store-online-sg');
      expect(offer?.language).toBe('English');
      expect(offer?.productFormat).toBe('Elite Trainer Box');
      expect(offer?.itemPriceMinor).toBe(9990);
      expect(offer?.purchaseLimit).toBe(1);
      // A09/A10: the seeded English variant carries the wrapping-removal notice.
      expect(offer?.packagingCondition).toBe('stated_removed');
      expect(offer?.packagingEvidenceRegion).toBe('packaging-notice-banner');
      // A11: the product page cannot know delivery, so the delivered total stays unknown here and is
      // only established at checkout review (see the executor suite below).
      expect(offer?.deliveryFeeMinor).toBeNull();
      expect(offer?.deliveredTotalMinor).toBeNull();

      expect(evidenceLog.length).toBe(before + 1);
      const evidence = evidenceLog[evidenceLog.length - 1];
      expect(evidence?.evidenceId).toBe(obs.evidenceId);
      expect(evidence?.provenance).toBe('demo');
      const snapshotRef = evidence?.snapshotRef ?? '';
      expect(snapshotRef).toMatch(/\.png$/);
      expect(snapshotRef.startsWith(join(dataDir, 'evidence'))).toBe(true);
      expect(existsSync(snapshotRef)).toBe(true);
      expect(statSync(snapshotRef).size).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports accessControl "captcha" and attempts no bypass (A16)',
    async () => {
      await setFaults({ captchaOnProduct: true });
      try {
        const obs = await adapter.observeTarget(observeRequest(demoIntent()));
        expect(obs.accessControl).toBe('captcha');
        expect(obs.availability).toBe('UNKNOWN');
        expect(obs.offer).toBeNull();
        expect(obs.retryAfterSeconds).toBeNull();
        expect(obs.error).toMatch(/CAPTCHA/i);
        // Evidence is still captured for the challenge itself.
        const evidence = evidenceLog[evidenceLog.length - 1];
        expect(evidence?.observedFields).toMatchObject({ accessControl: 'captcha' });
      } finally {
        await setFaults({ captchaOnProduct: false });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports accessControl "rate_limited" with the Retry-After delay (A16)',
    async () => {
      await setFaults({ rateLimitOnProduct: { retryAfterSeconds: 37 } });
      try {
        const obs = await adapter.observeTarget(observeRequest(demoIntent()));
        expect(obs.accessControl).toBe('rate_limited');
        expect(obs.retryAfterSeconds).toBe(37);
        expect(obs.availability).toBe('UNKNOWN');
        expect(obs.offer).toBeNull();
        expect(obs.error).toMatch(/429/);
        const evidence = evidenceLog[evidenceLog.length - 1];
        expect(evidence?.observedFields).toMatchObject({ httpStatus: 429 });
      } finally {
        await setFaults({ rateLimitOnProduct: null });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a cross-origin target before touching the network (A26)',
    async () => {
      const foreign = demoIntent('https://example.com/product/etb-151');
      await expect(adapter.observeTarget(observeRequest(foreign))).rejects.toThrow(/A26/);
      // A loopback origin that is not the storefront (e.g. the store admin port) is equally refused.
      await expect(adapter.observeTarget(observeRequest(demoIntent(`${store.adminOrigin}/product/etb-151`)))).rejects.toThrow(/A26/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks any non-storefront origin at the network layer, including the store admin port (section 9)',
    async () => {
      const before = incidents.length;
      // Use a throwaway page: a blocked navigation leaves Chromium on an internal error page, which
      // would interfere with the adapter page's next navigation.
      const probe = await browser.context.newPage();
      try {
        await expect(probe.goto(`${store.adminOrigin}/admin/state`, { timeout: 10_000 })).rejects.toThrow(/ERR_FAILED|net::/);
      } finally {
        await probe.close();
      }
      const blocked = incidents.slice(before);
      expect(blocked.some((i) => i.type === 'origin_blocked' && i.detail.startsWith(store.adminOrigin))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('DemoStoreExecutor preparation', () => {
  it(
    'adds exactly one and is a no-op when the line already exists (A14)',
    async () => {
      await freshCart();
      const intent = demoIntent();

      const first = await executor.addOneToCart(intent);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.lines).toEqual([{ retailerProductId: 'etb-151', variantId: 'en', quantity: 1 }]);

      const second = await executor.addOneToCart(intent);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.lines).toEqual([{ retailerProductId: 'etb-151', variantId: 'en', quantity: 1 }]);
      // The second call must not even have re-submitted the form: the page revision is unchanged.
      expect(second.value.pageRevision).toBe(first.value.pageRevision);

      // A11: the delivered total only becomes knowable at checkout review (9990 + 299 delivery).
      const review = await executor.reviewCheckout(intent, '');
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.value.itemTotalMinor).toBe(9990);
      expect(review.value.deliveryFeeMinor).toBe(299);
      expect(review.value.deliveredTotalMinor).toBe(10289);
      expect(review.value.checkoutSessionId).toMatch(/^chk_/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves failAddToCartOnce by re-reading the cart instead of adding twice (A15, A14)',
    async () => {
      await freshCart();
      const intent = demoIntent();
      await setFaults({ failAddToCartOnce: true });

      // The fault returns HTTP 500 *after* the line is stored; only a re-read reveals the truth.
      const first = await executor.addOneToCart(intent);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.lines).toEqual([{ retailerProductId: 'etb-151', variantId: 'en', quantity: 1 }]);

      // A retry after the "failure" must not push quantity to two.
      const retry = await executor.addOneToCart(intent);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.value.lines).toEqual([{ retailerProductId: 'etb-151', variantId: 'en', quantity: 1 }]);

      const cart = await executor.readCart(intent);
      expect(cart.ok).toBe(true);
      if (!cart.ok) return;
      expect(cart.value.lines).toHaveLength(1);
      expect(cart.value.lines[0]?.quantity).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses cross-origin preparation and submission (A26)',
    async () => {
      const foreign = demoIntent('https://example.com/product/etb-151');
      await expect(executor.readCart(foreign)).rejects.toThrow(/A26/);
      await expect(executor.addOneToCart(foreign)).rejects.toThrow(/A26/);
      await expect(executor.reviewCheckout(foreign, '')).rejects.toThrow(/A26/);
      await expect(executor.submitDemoOrder(foreign, 'chk_whatever')).rejects.toThrow(/A26/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('DemoStoreExecutor submission', () => {
  it(
    'returns outcomeUnclear when the confirmation is delayed past the submit timeout, and exactly one order exists (A20, A19)',
    async () => {
      await freshCart();
      const intent = demoIntent();
      const ordersBefore = (await adminOrders()).length;

      const add = await executor.addOneToCart(intent);
      expect(add.ok).toBe(true);
      const review = await executor.reviewCheckout(intent, '');
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      const sessionId = review.value.checkoutSessionId ?? '';
      expect(sessionId).toMatch(/^chk_/);

      await setFaults({ delayedConfirmationMs: DELAYED_CONFIRMATION_MS });
      try {
        const submit = await executor.submitDemoOrder(intent, sessionId);
        expect(submit.ok).toBe(false);
        if (submit.ok) return;
        expect(submit.outcomeUnclear).toBe(true);
        expect(submit.error).toMatch(/did not complete within/);

        // A19/A20: the correct next move is reconciliation, not another submission. The store has
        // already created exactly one order for this session, and it is findable without submitting.
        const found = await executor.findOrderForSession(sessionId);
        expect(found.ok).toBe(true);
        if (!found.ok) return;
        expect(found.value).not.toBeNull();
        expect(found.value?.quantity).toBe(1);
        expect(found.value?.totalMinor).toBe(10289);

        const orders = await adminOrders();
        expect(orders).toHaveLength(ordersBefore + 1);

        // The confirmation does eventually arrive on the same page; the order is then visible.
        await browser.page.waitForSelector('[data-bts-order-ref]', { timeout: 15_000 });
        const visibleRef = await browser.page.locator('[data-bts-order-ref]').getAttribute('data-bts-order-ref');
        expect(visibleRef).toBe(found.value?.orderRef);

        // Re-submitting the same session is still idempotent: no second order.
        await setFaults({ delayedConfirmationMs: 0 });
        const resubmit = await executor.reviewCheckout(intent, sessionId);
        expect(resubmit.ok).toBe(true);
        const second = await executor.submitDemoOrder(intent, sessionId);
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.value.orderRef).toBe(found.value?.orderRef);
        expect(await adminOrders()).toHaveLength(ordersBefore + 1);
      } finally {
        await setFaults({ delayedConfirmationMs: 0 });
      }
    },
    A20_TIMEOUT_MS,
  );
});
