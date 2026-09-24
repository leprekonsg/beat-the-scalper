/**
 * Browser acceptance pass over the BTS dashboard, named by the acceptance IDs in
 * fixtures/acceptance-cases.json (BTS_FABLE_BUILD_PLAN.md Section 14).
 *
 * The stack is the demo one: the owned storefront, a virtual clock starting at 12:58 SGT, and the
 * offline-replay model path. No real retailer is contacted and no real-money path exists in the build.
 *
 * Evidence rule for every spec below: a state chip, a countdown, or an animation is never accepted as
 * proof of an outcome. Outcomes are read from the ledger (`event-item` lines) and from the demo store's
 * own order book at /admin/orders.
 */
import { expect, test } from '@playwright/test';
import { sessionToken } from './stack.ts';
import {
  activeMissionId,
  admin,
  advanceClock,
  api,
  armMission,
  connect,
  health,
  ledgerLine,
  missionEventTypes,
  missionView,
  productUrlFor,
  resetStack,
  storeOrders,
  waitForMissionState,
} from './helpers.ts';

test.beforeEach(async () => {
  await resetStack();
});

test.afterAll(async () => {
  await resetStack();
});

test('S3-Dashboard: a rejected token stays out and a valid token opens the board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connect-prompt')).toBeVisible();

  await page.getByTestId('token-input').fill('not-the-session-token');
  await page.getByTestId('token-connect').click();
  await expect(page.getByTestId('token-error')).toBeVisible();
  await expect(page.getByTestId('band-now')).toHaveCount(0);

  await page.getByTestId('token-input').fill(sessionToken());
  await page.getByTestId('token-connect').click();

  // The observatory band is the one place every screen states the time facts.
  await expect(page.getByTestId('band-now')).toBeVisible();
  await expect(page.getByTestId('band-next-check')).toBeVisible();
  await expect(page.getByTestId('band-window')).toBeVisible();
  await expect(page.getByTestId('band-now')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByTestId('mission-form')).toBeVisible();
});

test('A05/A11: arming from the form starts watching and prints a Demo observation with Unknown kept as a value', async ({ page }) => {
  await connect(page);

  await page.getByTestId('mission-field-product-format').fill('Elite Trainer Box');
  await page.getByTestId('mission-field-language').fill('English');
  await page.getByTestId('mission-field-product-url').fill(productUrlFor('A05-form'));
  await page.getByTestId('mission-field-description').fill('Pokemon TCG: Scarlet & Violet 151 Elite Trainer Box');
  await page.getByTestId('mission-field-retailer-product-id').fill('etb-151');
  await page.getByTestId('mission-field-variant-id').fill('en');
  await page.getByTestId('mission-field-seller-ref').fill('pokemon-store-online-sg');
  await page.getByTestId('mission-field-max-delivered-price').fill('120.00');
  await page.getByTestId('mission-field-packaging-policy').selectOption('ask');
  await page.getByTestId('mission-field-restock-window-enabled').check();
  await page.getByTestId('mission-field-authority').selectOption('demo_purchase');

  await page.getByTestId('mission-save-draft').click();
  await expect(page.getByTestId('mission-state')).toHaveText('DRAFT');
  await expect(page.getByTestId('mission-missing-facts')).toHaveCount(0);

  // Arming is gated on accepting the expiry proposal, not on the draft alone.
  await expect(page.getByTestId('mission-arm')).toBeDisabled();
  await page.getByTestId('mission-accept-expiry').check();
  await page.getByTestId('mission-arm').click();

  await expect(page.getByTestId('candidate-card')).toBeVisible();
  await expect(page.getByTestId('mission-state')).toHaveText('WATCHING');
  await expect(page.getByTestId('monitor-health')).toHaveText('Healthy');
  await expect(page.getByTestId('next-check')).not.toHaveText('Not scheduled');
  await expect(page.getByTestId('last-successful-observation')).not.toHaveText('Unknown');

  // The ledger, not the chip, is the record that an observation happened, and it is labelled Demo.
  const observed = ledgerLine(page, 'observation.completed').first();
  await expect(observed).toBeVisible();
  await expect(observed.getByTestId('event-provenance')).toHaveText('Demo');

  // A05: the first observation validates the offer even though nothing was ever seen sold out before.
  // A11: the item price is under budget while the delivered total is still Unknown - not eligibility.
  await expect(page.getByTestId('availability')).toHaveText('UNAVAILABLE');
  await expect(page.getByTestId('item-price')).toHaveText('S$99.90');
  await expect(page.getByTestId('delivered-total')).toContainText('Unknown');
  await expect(page.getByTestId('delivered-total')).toHaveAttribute('data-within-budget', 'unknown');
  await expect(page.getByTestId('packaging-condition')).toHaveAttribute('data-condition', 'stated_removed');
  await expect(page.getByTestId('packaging-condition')).toContainText('Stated removed');
});

test('A09/A12/A14/A19: an ask-policy packaging notice pauses for review, and accepting it completes exactly one order', async ({ page }) => {
  const missionId = await armMission('A09-review');
  await connect(page);
  await expect(page.getByTestId('candidate-card')).toBeVisible();

  // The presenter publishes the restock on the admin origin; the mission only learns about it by looking.
  await admin('/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });
  await advanceClock(120_000);

  await waitForMissionState(missionId, (s) => s === 'PAUSED', 'PAUSED for condition review');
  await expect(page.getByTestId('mission-state')).toHaveText('PAUSED');
  await expect(page.getByTestId('review-banner')).toBeVisible();
  await expect(page.getByTestId('review-banner')).toContainText('Stated removed');
  await expect(page.getByTestId('accept-condition')).toBeVisible();
  expect(await missionEventTypes(missionId)).toContain('condition.review_requested');
  expect(await storeOrders()).toHaveLength(0);
  // The restock alert fired on detection, before the review pause, and carries the packaging check.
  await expect(page.getByTestId('restock-alert')).toContainText('In stock now');
  await expect(page.getByTestId('restock-alert')).toContainText('Listing states a packaging change');

  await page.getByTestId('accept-condition').click();

  // The proof of purchase is the merchant's own order book plus the two ledger lines - never the chip.
  await waitForMissionState(missionId, (s) => s === 'COMPLETED', 'COMPLETED after accepting the condition', 40_000);
  await expect(ledgerLine(page, 'order.observed')).toHaveCount(1);
  await expect(ledgerLine(page, 'mission.completed')).toHaveCount(1);

  const orders = await storeOrders();
  expect(orders).toHaveLength(1);
  expect(orders[0]?.quantity).toBe(1);
  expect(orders[0]?.status).toBe('PLACED');

  // A12/A14: a duplicate tick or repeated alert must not create a second order or a second cart line.
  await advanceClock(120_000);
  await page.waitForTimeout(2000);
  expect(await storeOrders()).toHaveLength(1);

  // A19: the outcome is recorded, not re-attempted; the mission is final.
  expect((await missionView(missionId)).state).toBe('COMPLETED');
  const types = await missionEventTypes(missionId);
  expect(types.filter((t) => t === 'order.observed')).toHaveLength(1);
  expect(types.filter((t) => t === 'mission.completed')).toHaveLength(1);
});

test('A22: pause and resume from WATCHING', async ({ page }) => {
  const missionId = await armMission('A22-pause');
  await connect(page);
  await expect(page.getByTestId('mission-state')).toHaveText('WATCHING');

  await page.getByTestId('control-pause').click();
  await expect(page.getByTestId('mission-state')).toHaveText('PAUSED');
  expect((await missionView(missionId)).state).toBe('PAUSED');

  await page.getByTestId('control-resume').click();
  await expect(page.getByTestId('mission-state')).toHaveText('WATCHING');
  expect((await missionView(missionId)).state).toBe('WATCHING');

  const transitions = await missionEventTypes(missionId);
  expect(transitions.filter((t) => t === 'mission.transition').length).toBeGreaterThanOrEqual(3);
});

test('A22: cancelling takes two clicks, and the refused-when-locked note is absent while watching', async ({ page }) => {
  const missionId = await armMission('A22-cancel');
  await connect(page);
  await expect(page.getByTestId('mission-state')).toHaveText('WATCHING');

  // WATCHING is not a locked state, so the refusal note must not be on screen.
  await expect(page.getByTestId('locked-note')).toHaveCount(0);
  await expect(page.getByTestId('handoff-section')).toHaveCount(0);

  await page.getByTestId('control-cancel').click();
  await expect(page.getByTestId('control-cancel-confirm')).toBeVisible();
  await expect(page.getByTestId('control-cancel')).toHaveCount(0);

  await page.getByTestId('control-cancel-confirm').click();
  await waitForMissionState(missionId, (s) => s === 'CANCELLED', 'CANCELLED');

  // Cancellation is a ledger fact; the card itself leaves the pocket once the mission is final.
  await expect(ledgerLine(page, 'mission.transition').first()).toContainText('CANCELLED');
  expect(await activeMissionId()).toBeNull();
  expect(await storeOrders()).toHaveLength(0);
});

test('A06/A10: an imported announcement is labelled as a model output, never as live verified, and prefills the card', async ({ page }) => {
  await connect(page);
  await expect(page.getByTestId('import-panel')).toBeVisible();

  await page
    .getByTestId('import-field-text')
    .fill('Scarlet & Violet 151 Elite Trainer Box launches 25 September 2026, live from 10:00am Singapore time on our official Lazada store. Limit one per customer.');
  await page.getByTestId('import-submit').click();

  const provenance = page.getByTestId('import-provenance');
  await expect(provenance).toBeVisible();
  // A06/A10: an extraction is manual input or offline replay. It is never "Live verified" - that label
  // belongs to a verified first-party observation, not to anything a model produced.
  await expect(provenance).toHaveText(/Offline replay|Manual input/);
  await expect(provenance).not.toHaveText(/Live verified/);
  await expect(page.getByTestId('import-evidence-id')).toContainText('Evidence evd_');

  await page.getByTestId('import-use-in-mission').click();
  await expect(page.getByTestId('mission-field-product-format')).toHaveValue('Elite Trainer Box');
  await expect(page.getByTestId('mission-field-language')).toHaveValue('English');
  await expect(page.getByTestId('mission-field-launch-date')).toHaveValue('2026-09-25');
  await expect(page.getByTestId('mission-field-launch-time')).toHaveValue('10:00');
});

test('A12: the same shared restock alert imported twice is recorded once', async ({ page }) => {
  const missionId = await armMission('A12-dedupe');
  await connect(page);
  await expect(page.getByTestId('candidate-card')).toBeVisible();

  await page.getByTestId('signal-dedupe-key').fill('lazada-alert-13-27');
  await page.getByTestId('signal-import').click();
  await expect(ledgerLine(page, 'signal.imported')).toHaveCount(1);

  await page.getByTestId('signal-import').click();
  await page.waitForTimeout(1500);
  await expect(ledgerLine(page, 'signal.imported')).toHaveCount(1);

  // The API says so too: the second delivery of the same key is a duplicate, not a new signal.
  const again = await api<{ queued: boolean; duplicate: boolean }>(`/api/missions/${missionId}/signal`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'restock_alert', dedupeKey: 'lazada-alert-13-27' }),
  });
  expect(again).toEqual({ queued: false, duplicate: true });
  expect((await missionEventTypes(missionId)).filter((t) => t === 'signal.imported')).toHaveLength(1);
});

test('A16: a CAPTCHA pauses the mission and the access control is shown in the observation pocket', async ({ page }) => {
  await admin('/admin/faults', { captchaOnProduct: true });
  const missionId = await armMission('A16-captcha');
  await connect(page);
  await advanceClock(60_000);

  await waitForMissionState(missionId, (s) => s === 'PAUSED', 'PAUSED on the access control', 25_000);
  await expect(page.getByTestId('mission-state')).toHaveText('PAUSED');
  await expect(page.getByTestId('access-control')).toContainText('CAPTCHA shown');
  await expect(page.getByTestId('availability')).toHaveText('UNKNOWN');

  // No bypass was attempted and nothing was bought.
  expect(await missionEventTypes(missionId)).toContain('access_control.paused');
  expect((await missionView(missionId)).mission.pauseReason).toBe('captcha');
  expect(await storeOrders()).toHaveLength(0);
});

test('A16: a rate-limited read backs off by the server-stated Retry-After', async ({ page }) => {
  await admin('/admin/faults', { rateLimitOnProduct: { retryAfterSeconds: 45 } });
  const missionId = await armMission('A16-rate-limit');
  await connect(page);
  await advanceClock(60_000);

  await expect
    .poll(async () => (await missionView(missionId)).lastObservation?.accessControl, { timeout: 25_000 })
    .toBe('rate_limited');

  const view = await missionView(missionId);
  expect(view.lastObservation?.retryAfterSeconds).toBe(45);
  // The scheduler obeys the server, not the mission's appetite: next check is exactly Retry-After away.
  const h = await health();
  expect(h.nextCheckAt).not.toBeNull();
  expect((Date.parse(h.nextCheckAt!) - Date.parse(h.clock.now)) / 1000).toBe(45);

  await expect(page.getByTestId('access-control')).toContainText('Rate limited');
  await expect(page.getByTestId('access-control')).toContainText('retry after 45s');
  expect(await storeOrders()).toHaveLength(0);
});

test('S3-Dashboard: the footer states the no-real-money fact and the legend holds all five provenances', async ({ page }) => {
  await connect(page);

  await expect(page.getByTestId('footer-no-real-money-note')).toHaveText('No real-money submission path exists in this build.');
  await expect(page.getByTestId('footer-demo-store-note')).toContainText('127.0.0.1:4310');

  const legend = page.getByTestId('provenance-legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.chip')).toHaveCount(5);
  for (const label of ['Live verified', 'Manual input', 'Demo', 'Offline replay', 'Blocked']) {
    await expect(legend.getByText(label, { exact: true })).toBeVisible();
  }
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('S3-Dashboard: on a 390x844 screen the card pocket comes first and its controls are reachable', async ({ page }) => {
    const missionId = await armMission('mobile-card-first');
    await connect(page);
    await expect(page.getByTestId('candidate-card')).toBeVisible();

    const cardBox = await page.getByTestId('candidate-card').boundingBox();
    const monitorBox = await page.getByTestId('monitor-health').boundingBox();
    const ledgerBox = await page.getByTestId('timeline').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(monitorBox).not.toBeNull();
    expect(ledgerBox).not.toBeNull();
    // The card the collector acts on is the first pocket in the column, above monitor and ledger.
    expect(cardBox!.y).toBeLessThan(monitorBox!.y);
    expect(cardBox!.y).toBeLessThan(ledgerBox!.y);
    expect(cardBox!.width).toBeLessThanOrEqual(390);

    for (const testId of ['control-pause', 'control-review', 'control-cancel']) {
      const control = page.getByTestId(testId);
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }

    // Clickable, not merely visible: the pause control works at this width.
    await page.getByTestId('control-pause').click();
    await expect(page.getByTestId('mission-state')).toHaveText('PAUSED');
    expect((await missionView(missionId)).state).toBe('PAUSED');
  });
});
