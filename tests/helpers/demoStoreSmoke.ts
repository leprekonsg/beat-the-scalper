/**
 * Quick self-check for the demo storefront + adapter/executor (not a vitest test).
 *
 * Starts the demo store on ephemeral ports with a throwaway SQLite file and browser profile,
 * drives it exactly like the worker would: observe (UNAVAILABLE) -> admin restock -> observe
 * (AVAILABLE, stated_removed) -> add one to cart -> review checkout (delivered total
 * 9990 + 299 = 10289) -> submit twice through the executor -> assert exactly one order exists.
 *
 * Run with: npx tsx tests/helpers/demoStoreSmoke.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoStore } from '../../demo/store/server.ts';
import { createDemoBrowser, DemoStoreAdapter, DemoStoreExecutor } from '../../src/adapters/demoStore.ts';
import { makeIntent } from '../unit/builders.ts';
import type { ObserveRequest } from '../../src/adapters/types.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'bts-demo-smoke-'));
  const dbPath = join(workDir, 'demo-store.sqlite');
  const dataDir = join(workDir, 'data');

  console.log('[smoke] starting demo store on ephemeral ports...');
  const store = await startDemoStore({ storePort: 0, adminPort: 0, dbPath });
  console.log(`[smoke] storefront=${store.storeOrigin} admin=${store.adminOrigin}`);

  const incidents: { type: string; detail: string; at: string }[] = [];
  const browser = await createDemoBrowser({
    storeOrigin: store.storeOrigin,
    headless: true,
    dataDir,
    onIncident: (incident) => incidents.push(incident),
  });

  let evidenceCount = 0;
  const adapter = new DemoStoreAdapter({
    page: browser.page,
    storeOrigin: store.storeOrigin,
    now: () => new Date(),
    onEvidence: () => {
      evidenceCount += 1;
    },
    dataDir,
  });
  const executor = new DemoStoreExecutor({ page: browser.page, storeOrigin: store.storeOrigin });

  try {
    const intent = makeIntent(
      { maxDeliveredPriceMinor: 20_000, packagingPolicy: 'ask' },
      {
        productUrl: `${store.storeOrigin}/product/etb-151?variant=en`,
        retailerProductId: 'etb-151',
        variantId: 'en',
        sellerRef: 'pokemon-store-online-sg',
        sellerEvidenceId: null,
        productFormat: 'Elite Trainer Box',
        language: 'English',
        description: 'Pokemon TCG Scarlet & Violet 151 Elite Trainer Box, English, one unit',
      },
    );
    const req: ObserveRequest = { missionId: 'smoke_mission_1', intent, now: new Date().toISOString() };

    // 1. Initial stock is 0 -> UNAVAILABLE.
    console.log('[smoke] observing etb-151/en (expect UNAVAILABLE, initial stock is 0)...');
    const obs1 = await adapter.observeTarget(req);
    assert(obs1.availability === 'UNAVAILABLE', `expected UNAVAILABLE, got ${obs1.availability} (error=${obs1.error})`);
    assert(obs1.error === null, `expected no error on a normal UNAVAILABLE observation, got: ${obs1.error}`);
    console.log(`[smoke] OK: availability=${obs1.availability} pageRevision=${obs1.pageRevision}`);

    // 2. Admin sets stock (agent never touches the admin origin directly; this simulates the presenter).
    console.log('[smoke] admin: setting etb-151/en stock to 5...');
    const stockRes = await fetch(`${store.adminOrigin}/admin/stock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'etb-151', variantId: 'en', quantity: 5 }),
    });
    assert(stockRes.ok, `admin/stock failed: ${stockRes.status}`);

    // 3. Re-observe -> AVAILABLE, stated_removed packaging.
    console.log('[smoke] observing etb-151/en again (expect AVAILABLE, stated_removed)...');
    const obs2 = await adapter.observeTarget(req);
    assert(obs2.availability === 'AVAILABLE', `expected AVAILABLE, got ${obs2.availability} (error=${obs2.error})`);
    assert(obs2.offer !== null, 'expected an offer on the AVAILABLE observation');
    assert(obs2.offer.packagingCondition === 'stated_removed', `expected stated_removed packaging, got ${obs2.offer.packagingCondition}`);
    assert(obs2.offer.itemPriceMinor === 9990, `expected item price 9990, got ${obs2.offer.itemPriceMinor}`);
    assert(obs2.pageRevision !== obs1.pageRevision, 'page revision should change when availability changes');
    assert(evidenceCount === 2, `expected 2 evidence callbacks (one per observation), got ${evidenceCount}`);
    console.log(`[smoke] OK: availability=${obs2.availability} packaging=${obs2.offer.packagingCondition} price=${obs2.offer.itemPriceMinor}`);

    // 4. Add exactly one to cart.
    console.log('[smoke] adding one to cart...');
    const addResult = await executor.addOneToCart(intent);
    assert(addResult.ok, `addOneToCart failed: ${!addResult.ok ? addResult.error : ''}`);
    assert(addResult.value.lines.length === 1, `expected 1 cart line, got ${addResult.value.lines.length}`);
    assert(addResult.value.lines[0]?.quantity === 1, 'expected quantity 1 in the cart line');
    console.log(`[smoke] OK: cart has ${addResult.value.lines.length} line(s)`);

    // Adding a second time must not increase quantity (purchase limit 1 / A14 discipline).
    const addAgain = await executor.addOneToCart(intent);
    assert(addAgain.ok, `second addOneToCart failed: ${!addAgain.ok ? addAgain.error : ''}`);
    assert(addAgain.value.lines.length === 1 && addAgain.value.lines[0]?.quantity === 1, 'a second add-to-cart must not duplicate or bump quantity');

    // 5. Review checkout: delivered total = 9990 (item) + 299 (delivery, under 10000) = 10289.
    console.log('[smoke] reviewing checkout...');
    const review = await executor.reviewCheckout(intent, '');
    assert(review.ok, `reviewCheckout failed: ${!review.ok ? review.error : ''}`);
    assert(review.value.itemTotalMinor === 9990, `expected item total 9990, got ${review.value.itemTotalMinor}`);
    assert(review.value.deliveryFeeMinor === 299, `expected delivery fee 299, got ${review.value.deliveryFeeMinor}`);
    assert(review.value.deliveredTotalMinor === 10289, `expected delivered total 10289, got ${review.value.deliveredTotalMinor}`);
    const sessionId = review.value.checkoutSessionId;
    assert(sessionId !== null, 'expected a checkout session id after review');
    console.log(`[smoke] OK: delivered total = ${review.value.deliveredTotalMinor} (session ${sessionId})`);

    // 6. Submit once.
    console.log('[smoke] submitting order (1st time)...');
    const submit1 = await executor.submitDemoOrder(intent, sessionId);
    assert(submit1.ok, `first submitDemoOrder failed: ${!submit1.ok ? submit1.error : ''}`);
    assert(submit1.value.quantity === 1, `expected order quantity 1, got ${submit1.value.quantity}`);
    assert(submit1.value.totalMinor === 10289, `expected order total 10289, got ${submit1.value.totalMinor}`);
    console.log(`[smoke] OK: order ${submit1.value.orderRef} status=${submit1.value.status} total=${submit1.value.totalMinor}`);

    // 7. Re-open the checkout review (the "place order" control only exists on that page) and submit again.
    console.log('[smoke] re-opening checkout review and submitting again (2nd time, must be idempotent)...');
    const reviewAgain = await executor.reviewCheckout(intent, sessionId);
    assert(reviewAgain.ok, `second reviewCheckout failed: ${!reviewAgain.ok ? reviewAgain.error : ''}`);
    const submit2 = await executor.submitDemoOrder(intent, sessionId);
    assert(submit2.ok, `second submitDemoOrder failed: ${!submit2.ok ? submit2.error : ''}`);
    assert(submit2.value.orderRef === submit1.value.orderRef, `idempotency violated: got a different order ref (${submit1.value.orderRef} vs ${submit2.value.orderRef})`);
    console.log(`[smoke] OK: second submission returned the same order ${submit2.value.orderRef}`);

    // 8. findOrderForSession agrees.
    const found = await executor.findOrderForSession(sessionId);
    assert(found.ok, `findOrderForSession failed: ${!found.ok ? found.error : ''}`);
    assert(found.value !== null && found.value.orderRef === submit1.value.orderRef, 'findOrderForSession did not return the created order');

    // 9. Exactly one order exists overall.
    const ordersRes = await fetch(`${store.adminOrigin}/admin/orders`);
    assert(ordersRes.ok, `admin/orders failed: ${ordersRes.status}`);
    const orders = (await ordersRes.json()) as unknown[];
    assert(orders.length === 1, `expected exactly 1 order in /admin/orders, got ${orders.length}`);
    console.log(`[smoke] OK: /admin/orders reports exactly ${orders.length} order`);

    // 10. A26: cross-origin target must be rejected outright.
    console.log('[smoke] checking A26 (cross-origin rejection)...');
    const crossOriginIntent = makeIntent({}, { productUrl: 'https://example.com/product/etb-151', retailerProductId: 'etb-151', variantId: 'en' });
    let rejected = false;
    try {
      await adapter.observeTarget({ missionId: 'smoke_mission_1', intent: crossOriginIntent, now: new Date().toISOString() });
    } catch {
      rejected = true;
    }
    assert(rejected, 'expected observeTarget to throw for a cross-origin productUrl (A26)');
    console.log('[smoke] OK: cross-origin target was rejected');

    console.log(`[smoke] incidents recorded by the browser factory during this run: ${incidents.length}`);
    console.log('[smoke] ALL CHECKS PASSED');
  } finally {
    await executor.close();
    await browser.close();
    await store.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
