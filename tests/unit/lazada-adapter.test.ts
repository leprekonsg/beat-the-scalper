/**
 * Deterministic tests for src/adapters/lazada.ts (the feasibility-gated Lazada adapter). No
 * network access, no Playwright: the gate itself and the optional `deps.live` delegation are pure
 * store/logic behaviour.
 */
import { describe, expect, it } from 'vitest';
import { BLOCKED_MESSAGE, LazadaObservationAdapter, NotImplementedError } from '../../src/adapters/lazada.ts';
import type { ObservationAdapter, ObserveRequest } from '../../src/adapters/types.ts';
import { Store } from '../../src/storage/db.ts';
import { makeIntent, makeObservation } from './builders.ts';

const intent = makeIntent({ mode: 'lazada_assist', authority: 'observe' }, { productUrl: 'https://www.lazada.sg/products/pokemon-etb-i1-s1.html' });
const req: ObserveRequest = { missionId: 'msn_001', intent, now: '2026-09-19T05:00:00.000Z' };

function newStore(): Store {
  return new Store(':memory:');
}

describe('LazadaObservationAdapter (feasibility gate)', () => {
  it('is blocked by default (liveObserveEnabled false), performing no delegation', async () => {
    const store = newStore();
    const adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: false });
    const obs = await adapter.observeTarget(req);
    expect(obs.provenance).toBe('blocked');
    expect(obs.error).toBe(BLOCKED_MESSAGE);
    store.close();
  });

  it('is blocked when liveObserveEnabled is true but the store setting has not recorded a pass', async () => {
    const store = newStore();
    const adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: true });
    const obs = await adapter.observeTarget(req);
    expect(obs.provenance).toBe('blocked');
    store.close();
  });

  it('throws NotImplementedError when the gate passes and no live adapter is supplied (current production wiring)', async () => {
    const store = newStore();
    store.setSetting('feasibility.observe', 'passed');
    const adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: true });
    await expect(adapter.observeTarget(req)).rejects.toBeInstanceOf(NotImplementedError);
    store.close();
  });

  it('delegates to deps.live only once the gate passes', async () => {
    const store = newStore();
    let calls = 0;
    const liveResult = makeObservation({ provenance: 'live_verified', missionId: req.missionId });
    const fakeLive: ObservationAdapter = {
      name: 'fake-live',
      provenance: 'live_verified',
      origin: 'https://www.lazada.sg',
      async observeTarget(): Promise<typeof liveResult> {
        calls += 1;
        return liveResult;
      },
    };

    // Gate not yet passed: delegate must not be called.
    const adapterBeforeGate = new LazadaObservationAdapter({ store, liveObserveEnabled: false, live: fakeLive });
    const blocked = await adapterBeforeGate.observeTarget(req);
    expect(blocked.provenance).toBe('blocked');
    expect(calls).toBe(0);

    // Gate passed: delegate is used and its result is returned verbatim.
    store.setSetting('feasibility.observe', 'passed');
    const adapterAfterGate = new LazadaObservationAdapter({ store, liveObserveEnabled: true, live: fakeLive });
    const result = await adapterAfterGate.observeTarget(req);
    expect(calls).toBe(1);
    expect(result).toBe(liveResult);
    store.close();
  });

  it('does not delegate when liveObserveEnabled is false even if the store records a pass and a live adapter is supplied', async () => {
    const store = newStore();
    store.setSetting('feasibility.observe', 'passed');
    let calls = 0;
    const fakeLive: ObservationAdapter = {
      name: 'fake-live',
      provenance: 'live_verified',
      origin: 'https://www.lazada.sg',
      async observeTarget() {
        calls += 1;
        return makeObservation({ provenance: 'live_verified', missionId: req.missionId });
      },
    };
    const adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: false, live: fakeLive });
    const obs = await adapter.observeTarget(req);
    expect(obs.provenance).toBe('blocked');
    expect(calls).toBe(0);
    store.close();
  });

  it('propagates a live adapter failure instead of fabricating a blocked result', async () => {
    const store = newStore();
    store.setSetting('feasibility.observe', 'passed');
    const failingLive: ObservationAdapter = {
      name: 'fake-live',
      provenance: 'live_verified',
      origin: 'https://www.lazada.sg',
      async observeTarget() {
        throw new Error('browser gone');
      },
    };
    const adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: true, live: failingLive });
    await expect(adapter.observeTarget(req)).rejects.toThrow(/browser gone/);
    store.close();
  });
});
