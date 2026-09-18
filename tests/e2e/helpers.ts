/**
 * Test-side helpers for the e2e suite: the local API (presenter side of the token gate), the demo
 * store's admin origin (which the agent can never reach), and the two page rituals every spec repeats.
 *
 * Outcomes are always read back from the ledger or from the store's own /admin/orders. A chip or an
 * animation is never treated as proof that something happened (BTS_FABLE_BUILD_PLAN.md Section 3).
 */
import { expect, type Page } from '@playwright/test';
import { ADMIN_ORIGIN, API_ORIGIN, STORE_ORIGIN, UI_ORIGIN, sessionToken } from './stack.ts';

export interface MissionStateView {
  state: string;
  mission: { id: string; pauseReason: string | null };
  lastObservation: { evidenceId: string; availability: string; accessControl: string; retryAfterSeconds: number | null } | null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-bts-token': sessionToken(), origin: UI_ORIGIN, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Presenter-only origin: test controls and the store's own order book. Never reachable by the agent. */
export async function admin<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ADMIN_ORIGIN}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export interface StoreOrder {
  orderRef: string;
  status: string;
  quantity: number;
  totalMinor: number;
  sessionId: string;
}

export function storeOrders(): Promise<StoreOrder[]> {
  return admin<StoreOrder[]>('/admin/orders');
}

export function advanceClock(ms: number): Promise<unknown> {
  return api('/api/clock/advance', { method: 'POST', body: JSON.stringify({ ms }) });
}

export async function health(): Promise<{ nextCheckAt: string | null; clock: { now: string }; health: string }> {
  const res = await api<{ health: { nextCheckAt: string | null; clock: { now: string }; health: string } }>('/api/health');
  return res.health;
}

export function missionView(id: string): Promise<MissionStateView> {
  return api<MissionStateView>(`/api/missions/${id}`);
}

export async function missionEventTypes(id: string): Promise<string[]> {
  const res = await api<{ events: { type: string }[] }>(`/api/missions/${id}/events?limit=200`);
  return res.events.map((e) => e.type);
}

export async function activeMissionId(): Promise<string | null> {
  const res = await api<{ mission: { mission: { id: string } } | null }>('/api/state');
  return res.mission?.mission.id ?? null;
}

export async function waitForMissionState(id: string, accept: (state: string) => boolean, label: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await missionView(id)).state;
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Mission ${id} never reached ${label} within ${timeoutMs}ms (last state: ${last})`);
}

/**
 * One active mission at a time is a product rule, and the fulfillment key is deliberately stable across
 * duplicate URLs, so every spec needs its own target identity: `caseTag` becomes a query parameter on
 * the same demo product page (same item, same price, same stated packaging - different mission).
 */
export function productUrlFor(caseTag: string): string {
  return `${STORE_ORIGIN}/product/etb-151?variant=en&case=${encodeURIComponent(caseTag)}`;
}

export function missionDraftBody(caseTag: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'demo',
    description: 'Pokemon TCG: Scarlet & Violet 151 Elite Trainer Box',
    productUrl: productUrlFor(caseTag),
    retailerProductId: 'etb-151',
    variantId: 'en',
    sellerRef: 'pokemon-store-online-sg',
    sellerEvidenceId: null,
    productFormat: 'Elite Trainer Box',
    language: 'English',
    maxDeliveredPriceSgd: '120.00',
    packagingPolicy: 'ask',
    launch: { dateLocal: null, timeLocal: null, basis: 'unknown' },
    restockWindowEnabled: true,
    expiresAt: sevenDaysOut(),
    authority: 'demo_purchase',
    ...overrides,
  };
}

export function sevenDaysOut(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

/** Arms a mission through the API for specs whose subject is not the form itself. */
export async function armMission(caseTag: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const body = missionDraftBody(caseTag, overrides);
  const created = await api<{ mission: { mission: { id: string } } }>('/api/missions', { method: 'POST', body: JSON.stringify(body) });
  const id = created.mission.mission.id;
  await api(`/api/missions/${id}/approve`, { method: 'POST', body: JSON.stringify({ expiresAt: body.expiresAt, authority: body.authority }) });
  await waitForMissionState(id, (s) => s !== 'DRAFT', 'WATCHING after arming');
  return id;
}

/** Cancels whatever is still active, clears store faults, and reseeds the storefront (stock back to zero). */
export async function resetStack(): Promise<void> {
  const id = await activeMissionId();
  if (id) {
    await api(`/api/missions/${id}/cancel`, { method: 'POST' });
  }
  await admin('/admin/faults', { captchaOnProduct: false, rateLimitOnProduct: null, failAddToCartOnce: false, delayedConfirmationMs: 0 });
  await admin('/admin/reset', {});
}

/** Loads the dashboard with the session token already in sessionStorage (the band's own storage key). */
export async function connect(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((t) => sessionStorage.setItem('bts.sessionToken', t), sessionToken());
  await page.reload();
  await expect(page.getByTestId('band-now')).toBeVisible();
}

/** A ledger line for one event type, e.g. `ledgerLine(page, 'order.observed')`. */
export function ledgerLine(page: Page, eventType: string) {
  return page.locator(`[data-testid="event-item"][data-event-type="${eventType}"]`);
}
