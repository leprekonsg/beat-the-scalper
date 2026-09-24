/**
 * Pure restock-alert decision, packaging-cache validity, and notifier delivery. No network: the
 * webhook notifier gets a fake fetch.
 */
import { describe, expect, it } from 'vitest';
import { evaluateEligibility } from '../../src/domain/policy.ts';
import { packagingCacheApplies, packagingCacheNeedsRefresh, restockAlertDecision } from '../../src/domain/restockAlert.ts';
import type { PackagingCacheEntry } from '../../src/domain/restockAlert.ts';
import type { Observation } from '../../src/domain/types.ts';
import { normaliseArtworkRef } from '../../src/adapters/lazadaLive.ts';
import { MultiNotifier, WebhookNotifier, notificationText } from '../../src/worker/notifier.ts';
import type { RestockNotification, RestockNotifier } from '../../src/worker/notifier.ts';
import { makeIntent, makeObservation } from '../../src/worker/fakes.ts';

const NOW = new Date('2026-09-24T05:00:00.000Z');

function obs(offer: Partial<NonNullable<Observation['offer']>> = {}, over: Partial<Observation> = {}): Observation {
  return makeObservation({ availability: 'AVAILABLE', capturedAt: NOW.toISOString(), ...over, offer: { ...offer } as NonNullable<Observation['offer']> });
}

function decide(intentOver: Parameters<typeof makeIntent>[0], o: Observation) {
  const intent = makeIntent(intentOver);
  return restockAlertDecision(intent, o, evaluateEligibility(intent, o, { now: NOW, maxEvidenceAgeMs: 20_000 }));
}

describe('restockAlertDecision', () => {
  it('goes on a matching offer and lists what is still unknown (delivered total) without blocking', () => {
    const d = decide({ maxDeliveredPriceMinor: 12_000 }, obs({ itemPriceMinor: 10_990, deliveryFeeMinor: null }));
    expect(d.go).toBe(true);
    expect(d.headline).toBe('In stock now: Test ETB, S$109.90, Test Seller');
    expect(d.checkBeforePaying.join(' ')).toMatch(/Delivered total unknown \(item price alone is under budget/);
    expect(d.blockers).toEqual([]);
  });

  it('blocks a wrong seller, product format, or language', () => {
    expect(decide({}, obs({ sellerRef: 'reseller' })).go).toBe(false);
    expect(decide({}, obs({ productFormat: 'Booster Bundle' })).go).toBe(false);
    expect(decide({}, obs({ language: 'JP' })).go).toBe(false);
  });

  it('blocks an item price alone over budget even though the delivered total is unknown', () => {
    const d = decide({ maxDeliveredPriceMinor: 10_000 }, obs({ itemPriceMinor: 10_001, deliveryFeeMinor: null }));
    expect(d.go).toBe(false);
    expect(d.blockers).toEqual(['Item price S$100.01 alone exceeds budget S$100.00']);
  });

  it('does not double-count when the delivered total itself is over budget', () => {
    const d = decide({ maxDeliveredPriceMinor: 10_000 }, obs({ itemPriceMinor: 10_500, deliveryFeeMinor: 300 }));
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0]).toMatch(/Delivered total 10800 exceeds budget/);
  });

  it('blocks a stated removal under must_be_intact, but only lists an unreadable notice', () => {
    expect(decide({ packagingPolicy: 'must_be_intact' }, obs({ packagingCondition: 'stated_removed' })).go).toBe(false);
    const unreadable = decide({ packagingPolicy: 'must_be_intact' }, obs({ packagingCondition: 'unreadable' }));
    expect(unreadable.go).toBe(true);
    expect(unreadable.checkBeforePaying.join(' ')).toMatch(/must_be_intact cannot pass without stated evidence/);
  });

  it('never goes on an observation that is not AVAILABLE', () => {
    expect(decide({}, obs({}, { availability: 'UNKNOWN' })).go).toBe(false);
  });

  it('leaves evidence freshness out of the checks shown to the user', () => {
    const stale = obs({}, { capturedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(decide({}, stale).checkBeforePaying.join(' ')).not.toMatch(/Evidence is/);
  });
});

function entry(over: Partial<PackagingCacheEntry> = {}): PackagingCacheEntry {
  return {
    condition: 'stated_removed',
    evidenceId: 'evd_cached',
    observationId: 'obs_cached',
    assessedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    retailerProductId: 'prod-1',
    variantId: 'var-1',
    artworkRef: 'img.example/etb.jpg',
    provenance: 'manual_input',
    ...over,
  };
}

const MAX_AGE = 30 * 60_000;
const unreadable = (artworkRef: string | null = 'img.example/etb.jpg'): Observation => obs({ packagingCondition: 'unreadable', artworkRef });

describe('packagingCacheApplies', () => {
  it('applies for the same product, variant and artwork within the age limit', () => {
    expect(packagingCacheApplies(entry(), unreadable(), NOW, MAX_AGE)).toEqual({ applies: true, ageMs: 5 * 60_000 });
  });

  it('never overrides a condition the page stated itself', () => {
    const r = packagingCacheApplies(entry(), obs({ packagingCondition: 'stated_intact', artworkRef: 'img.example/etb.jpg' }), NOW, MAX_AGE);
    expect(r).toEqual({ applies: false, reason: 'page stated packaging itself (stated_intact)' });
  });

  it('rejects another variant, changed artwork, a missing artwork, or an expired entry', () => {
    expect(packagingCacheApplies(entry({ variantId: 'var-2' }), unreadable(), NOW, MAX_AGE).applies).toBe(false);
    expect(packagingCacheApplies(entry(), unreadable('img.example/new.jpg'), NOW, MAX_AGE).applies).toBe(false);
    expect(packagingCacheApplies(entry(), unreadable(null), NOW, MAX_AGE).applies).toBe(false);
    expect(packagingCacheApplies(entry({ assessedAt: new Date(NOW.getTime() - MAX_AGE - 1).toISOString() }), unreadable(), NOW, MAX_AGE).applies).toBe(false);
  });

  it('a null artwork matches only a null artwork', () => {
    expect(packagingCacheApplies(entry({ artworkRef: null }), unreadable(null), NOW, MAX_AGE).applies).toBe(true);
  });

  it('rejects an entry from the future (clock skew) rather than trusting it forever', () => {
    expect(packagingCacheApplies(entry({ assessedAt: new Date(NOW.getTime() + 60_000).toISOString() }), unreadable(), NOW, MAX_AGE).applies).toBe(false);
  });
});

describe('packagingCacheNeedsRefresh', () => {
  it('refreshes with no entry, and past half the entry life so a restock never lands on an expired one', () => {
    expect(packagingCacheNeedsRefresh(null, unreadable(), NOW, MAX_AGE)).toBe(true);
    expect(packagingCacheNeedsRefresh(entry(), unreadable(), NOW, MAX_AGE)).toBe(false);
    expect(packagingCacheNeedsRefresh(entry({ assessedAt: new Date(NOW.getTime() - 16 * 60_000).toISOString() }), unreadable(), NOW, MAX_AGE)).toBe(true);
  });

  it('does not spend a model call when the page shows packaging or has no product identity', () => {
    expect(packagingCacheNeedsRefresh(null, obs({ packagingCondition: 'stated_removed' }), NOW, MAX_AGE)).toBe(false);
    expect(packagingCacheNeedsRefresh(null, obs({ packagingCondition: 'unreadable', variantId: null }), NOW, MAX_AGE)).toBe(false);
  });
});

describe('normaliseArtworkRef', () => {
  it('drops the query so CDN resize parameters do not invalidate the cache', () => {
    expect(normaliseArtworkRef('https://img.lazcdn.com/g/p/abc.jpg?w=720&q=80')).toBe('img.lazcdn.com/g/p/abc.jpg');
    expect(normaliseArtworkRef('//img.lazcdn.com/g/p/abc.jpg')).toBe('img.lazcdn.com/g/p/abc.jpg');
  });

  it('is null for a missing or unparseable value', () => {
    expect(normaliseArtworkRef(null)).toBeNull();
    expect(normaliseArtworkRef('not a url')).toBeNull();
  });
});

const GO: RestockNotification = {
  kind: 'go',
  missionId: 'm1',
  headline: 'In stock now: ETB, S$109.90, Pokemon Store Online Singapore',
  details: ['Check before paying: Delivered total unknown'],
  productUrl: 'https://www.lazada.sg/products/x-i1-s2.html',
  at: NOW.toISOString(),
};

describe('WebhookNotifier', () => {
  it('posts ntfy-style urgent headers with a click-through to the listing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await new WebhookNotifier('https://ntfy.sh/bts-topic', fakeFetch).notify(GO);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://ntfy.sh/bts-topic');
    expect(headers.Priority).toBe('urgent');
    expect(headers.Click).toBe(GO.productUrl);
    expect(calls[0]!.init.body).toBe(notificationText(GO));
  });

  it('rejects on a non-2xx response so the worker records delivery_failed', async () => {
    const fakeFetch = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await expect(new WebhookNotifier('https://ntfy.sh/bts-topic', fakeFetch).notify(GO)).rejects.toThrow('webhook responded HTTP 429');
  });

  it('titles a drill as a test but keeps the urgent priority, so the drill times the real delivery path', async () => {
    const calls: RequestInit[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await new WebhookNotifier('https://ntfy.sh/bts-topic', fakeFetch).notify({ ...GO, drill: true });
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.Title).toBe('BTS drill (test, not a restock): in stock now');
    expect(headers.Priority).toBe('urgent');
  });

  it('refuses plain http to a remote host', () => {
    expect(() => new WebhookNotifier('http://ntfy.sh/bts-topic')).toThrow(/must be https/);
    expect(() => new WebhookNotifier('http://127.0.0.1:8080/hook')).not.toThrow();
  });
});

describe('MultiNotifier', () => {
  it('delivers to every notifier and reports each failure by name', async () => {
    const sent: string[] = [];
    const ok: RestockNotifier = { name: 'console', notify: async () => void sent.push('console') };
    const bad: RestockNotifier = { name: 'webhook', notify: async () => Promise.reject(new Error('HTTP 500')) };
    await expect(new MultiNotifier([ok, bad]).notify(GO)).rejects.toThrow('webhook: HTTP 500');
    expect(sent).toEqual(['console']);
  });
});
