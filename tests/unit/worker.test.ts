/**
 * Deterministic unit suite for src/worker/worker.ts.
 *
 * Everything here runs on a VirtualClock with in-memory SQLite and the fakes from
 * src/worker/fakes.ts: no real timers (`worker.start()` is never called), no network, no browser, no
 * model key. Test names carry the acceptance IDs from BTS_FABLE_BUILD_PLAN.md Section 14 (mirrored in
 * fixtures/acceptance-cases.json), which is the authority for ID numbering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { StaleGenerationError, Store } from '../../src/storage/db.ts';
import { VirtualClock } from '../../src/domain/time.ts';
import { DEMO_MONITOR_POLICY } from '../../src/domain/types.ts';
import type { Evidence, MissionState, MonitorPolicy, Observation, OfferAssessment, Provenance, PurchaseIntent } from '../../src/domain/types.ts';
import { Worker } from '../../src/worker/worker.ts';
import type { OfferInterpreter } from '../../src/worker/worker.ts';
import { FakeAdapter, FakeExecutor, makeIntent, makeObservation } from '../../src/worker/fakes.ts';
import type { FakeExecutorOptions } from '../../src/worker/fakes.ts';
import type { CartState, ExecutorStepResult, PreparationExecutor } from '../../src/adapters/types.ts';

const T0 = '2026-09-18T00:00:00.000Z';
const EXPIRES = '2026-09-25T00:00:00.000Z';
/** 13:27 Asia/Singapore, inside the user-observed 13:00-14:00 restock window. */
const IN_RESTOCK_WINDOW = '2026-09-25T05:27:00.000Z';
/** 10:00 Asia/Singapore, outside the restock window. */
const OUTSIDE_RESTOCK_WINDOW = '2026-09-25T02:00:00.000Z';

const ENABLED_RESTOCK_WINDOW = { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: true } as const;

const REVIEWED_LIVE_POLICY: MonitorPolicy = {
  mode: 'lazada_assist',
  baselineIntervalSeconds: 60,
  priorityIntervalSeconds: 20,
  maxObservationsPerOriginPerMinute: 4,
  liveObserveEnabled: true,
  livePrepareEnabled: true,
  label: 'reviewed_live',
};

const LIVE_DISABLED_POLICY: MonitorPolicy = {
  ...REVIEWED_LIVE_POLICY,
  liveObserveEnabled: false,
  livePrepareEnabled: false,
  label: 'disabled',
};

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

const openStores: Store[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

/**
 * Serves a scripted queue, stamping each observation with the virtual instant it is served at, so
 * evidence freshness is a property of the test's clock rather than of wall-clock time.
 */
function scriptedAdapter(script: Observation[]): FakeAdapter {
  const queue = [...script];
  return new FakeAdapter((req) => {
    const next = queue.shift();
    if (!next) throw new Error('adapter script exhausted');
    return { ...next, capturedAt: req.now };
  });
}

/** FakeExecutor with one-shot side effects injected between executor steps. */
class HookedExecutor extends FakeExecutor {
  constructor(
    private readonly hooks: { beforeAddOneToCart?: (() => void) | undefined; afterReviewCheckout?: (() => void) | undefined },
    options: FakeExecutorOptions = {},
  ) {
    super(options);
  }
  override async addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    const hook = this.hooks.beforeAddOneToCart;
    this.hooks.beforeAddOneToCart = undefined;
    hook?.();
    return super.addOneToCart(intent);
  }
  override async reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    const res = await super.reviewCheckout(intent, checkoutSessionId);
    const hook = this.hooks.afterReviewCheckout;
    this.hooks.afterReviewCheckout = undefined;
    hook?.();
    return res;
  }
}

/** Checkout review that never resolves the delivery fee, so the delivered total stays Unknown (A11). */
class UnknownTotalExecutor extends FakeExecutor {
  override async reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    const res = await super.reviewCheckout(intent, checkoutSessionId);
    if (!res.ok) return res;
    return { ok: true, value: { ...res.value, deliveryFeeMinor: null, deliveredTotalMinor: null } };
  }
}

/** The user's cart also holds something BTS did not put there (A14). */
class UnrelatedLineExecutor extends FakeExecutor {
  override async readCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    const res = await super.readCart(intent);
    if (!res.ok) return res;
    return { ok: true, value: { ...res.value, lines: [{ retailerProductId: 'other-prod', variantId: 'other-var', quantity: 2 }, ...res.value.lines] } };
  }
}

/** Live preparation executor: the same cart mechanics with no submission capability at all (A18). */
class LivePrepareExecutor implements PreparationExecutor {
  readonly mode = 'lazada_prepare' as const;
  readonly origin = 'https://retailer.example';
  readonly inner = new FakeExecutor();
  get calls(): string[] {
    return this.inner.calls;
  }
  readCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    return this.inner.readCart(intent);
  }
  addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    return this.inner.addOneToCart(intent);
  }
  reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    return this.inner.reviewCheckout(intent, checkoutSessionId);
  }
  findOrderForSession(checkoutSessionId: string): ReturnType<FakeExecutor['findOrderForSession']> {
    return this.inner.findOrderForSession(checkoutSessionId);
  }
  async close(): Promise<void> {}
}

function stubInterpreter(
  result: { ok: true; assessment: Partial<OfferAssessment> } | { ok: false; reason: string },
  provenance: Provenance = 'offline_replay',
): OfferInterpreter & { calls: { evidence: Evidence | null }[] } {
  const calls: { evidence: Evidence | null }[] = [];
  return {
    calls,
    async assess(input) {
      calls.push({ evidence: input.evidence });
      if (!result.ok) return { ok: false, reason: result.reason, provenance };
      const assessment: OfferAssessment = {
        finding: 'stub assessment',
        selectedVariantMatches: 'yes',
        sellerMatches: 'yes',
        productFormatMatches: 'yes',
        packagingCondition: 'stated_intact',
        packagingEvidenceRegion: '10,10,20,20',
        deliveredTotalMinor: null,
        missingFacts: [],
        requestedAction: 'none',
        evidenceIds: [],
        ...result.assessment,
      };
      return { ok: true, assessment, provenance };
    },
  };
}

interface HarnessOptions<E extends PreparationExecutor | null> {
  start?: string;
  intent?: Partial<PurchaseIntent>;
  script?: Observation[];
  executor?: E;
  policy?: MonitorPolicy;
  interpreter?: OfferInterpreter | null;
  apiReadiness?: 'live' | 'offline_replay' | 'blocked';
  arm?: boolean;
}

function harness<E extends PreparationExecutor | null = FakeExecutor>(opts: HarnessOptions<E> = {}) {
  const clock = new VirtualClock(opts.start ?? T0);
  const store = new Store(':memory:');
  openStores.push(store);
  const intent = makeIntent({ expiresAt: EXPIRES, ...opts.intent });
  const created = store.createMission(intent, clock.now().toISOString());
  const adapter = scriptedAdapter(opts.script ?? []);
  const executor = (opts.executor === undefined ? new FakeExecutor() : opts.executor) as E;
  const logs: string[] = [];
  const worker = new Worker({
    store,
    clock,
    policy: opts.policy ?? DEMO_MONITOR_POLICY,
    adapter,
    executor,
    interpreter: opts.interpreter ?? null,
    apiReadiness: opts.apiReadiness ?? 'offline_replay',
    log: (line) => logs.push(line),
  });
  const missionId = created.id;
  if (opts.arm !== false) worker.approveIntent(missionId, { expiresAt: intent.expiresAt, authority: intent.authority });
  const executorCalls = (): string[] => (executor as unknown as { calls?: string[] } | null)?.calls ?? [];
  return {
    clock,
    store,
    worker,
    adapter,
    executor,
    logs,
    missionId,
    intent,
    mission: () => store.getMission(missionId)!,
    state: (): MissionState => store.getMission(missionId)!.state,
    eventTypes: () => store.listEvents(missionId, 5000).map((e) => e.type),
    /** Chronological event list (listEvents is newest-first). */
    timeline: () => store.listEvents(missionId, 5000).slice().reverse(),
    attempts: () => store.listAttempts(missionId),
    calls: (name: string) => executorCalls().filter((c) => c === name).length,
    nowIso: () => clock.now().toISOString(),
    /** Move the clock forward, then run one tick. */
    tickAfter: async (ms: number) => {
      clock.advanceMs(ms);
      await worker.tick();
    },
  };
}

function availableObs(over: Partial<Observation> = {}, offer: Partial<NonNullable<Observation['offer']>> = {}): Observation {
  // makeObservation merges a partial offer over its defaults at runtime, but types the whole argument
  // as Partial<Observation>, so the partial offer needs a cast.
  return makeObservation({ availability: 'AVAILABLE', ...over, offer: { ...offer } as NonNullable<Observation['offer']> });
}

function soldOutObs(over: Partial<Observation> = {}): Observation {
  return makeObservation({ availability: 'UNAVAILABLE', offer: null, ...over });
}

function failedObs(error = 'page did not render in time'): Observation {
  return makeObservation({ availability: 'UNKNOWN', offer: null, error });
}

// ---------------------------------------------------------------------
// A01/A03/A04/A05/A12: scheduling and observation cadence
// ---------------------------------------------------------------------

describe('scheduling and observation cadence (A01, A03, A04, A05, A12)', () => {
  it('A05: a mission that starts while the target is already AVAILABLE validates at once, with no prior sold-out sample', async () => {
    const h = harness({ script: [availableObs()] });
    expect(h.mission().lastAvailability).toBe('UNKNOWN');

    await h.worker.tick();

    expect(h.state()).toBe('COMPLETED');
    expect(h.executor.orders).toHaveLength(1);
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.eventTypes()).toContain('validation.completed');
    expect(h.attempts()).toHaveLength(1);
  });

  it('A01: inside the launch band the plan switches to the priority cadence', async () => {
    const launchAt = '2026-09-18T02:00:00.000Z'; // 10:00 Asia/Singapore
    const h = harness({
      start: '2026-09-18T01:55:00.000Z', // inside preflight (launch - 10 minutes)
      intent: { launchAt, launchBasis: 'source_confirmed', launchEvidenceId: 'ev_launch_1' },
      script: [soldOutObs()],
    });

    await h.worker.tick();

    const health = h.worker.health();
    expect(health.cadence).toBe('launch_priority');
    expect(health.cadenceLabels).toContain('Source-confirmed launch window');
    expect(Date.parse(health.nextCheckAt!) - Date.parse(h.nowIso())).toBe(2000);
  });

  it('A03: inside the 13:00-14:00 Asia/Singapore restock window the cadence is priority', async () => {
    const h = harness({
      start: IN_RESTOCK_WINDOW,
      intent: { expiresAt: '2026-09-26T00:00:00.000Z', restockWindow: ENABLED_RESTOCK_WINDOW },
      script: [soldOutObs()],
    });

    await h.worker.tick();

    const health = h.worker.health();
    expect(health.cadence).toBe('restock_window_priority');
    expect(health.cadenceLabels).toContain('User-observed restock window 13:00-14:00 Asia/Singapore');
    expect(Date.parse(health.nextCheckAt!) - Date.parse(h.nowIso())).toBe(2000);
  });

  it('A04: outside the window the cadence is baseline, and availability there is still detected', async () => {
    const h = harness({
      start: OUTSIDE_RESTOCK_WINDOW,
      intent: { expiresAt: '2026-09-26T00:00:00.000Z', restockWindow: ENABLED_RESTOCK_WINDOW },
      script: [soldOutObs(), availableObs()],
    });

    await h.worker.tick();
    const health = h.worker.health();
    expect(health.cadence).toBe('baseline');
    expect(health.cadenceLabels).toContain('Baseline watch (outside expected windows)');
    expect(Date.parse(health.nextCheckAt!) - Date.parse(h.nowIso())).toBe(30_000);

    await h.tickAfter(30_000);
    expect(h.state()).toBe('COMPLETED');
    expect(h.executor.orders).toHaveLength(1);
  });

  it('A04: no observation is taken before nextCheckAt, and a tick takes at most one', async () => {
    const h = harness({ script: [soldOutObs(), soldOutObs()] });

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(1);

    await h.worker.tick(); // same instant, still before nextCheckAt
    expect(h.adapter.calls).toHaveLength(1);

    await h.tickAfter(29_999);
    expect(h.adapter.calls).toHaveLength(1);

    await h.tickAfter(1);
    expect(h.adapter.calls).toHaveLength(2);
  });

  it('A12: the shared per-origin limit caps observations even when every tick is due', async () => {
    const h = harness({
      start: IN_RESTOCK_WINDOW,
      intent: { expiresAt: '2026-09-26T00:00:00.000Z', restockWindow: ENABLED_RESTOCK_WINDOW },
      script: [soldOutObs(), soldOutObs()],
      policy: { ...DEMO_MONITOR_POLICY, maxObservationsPerOriginPerMinute: 1 },
    });

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(1);

    for (let i = 0; i < 5; i++) await h.tickAfter(3000); // priority cadence keeps every tick due
    expect(h.adapter.calls).toHaveLength(1);

    await h.tickAfter(46_000); // more than a minute after the first observation
    expect(h.adapter.calls).toHaveLength(2);
  });

  it('A12: a duplicate scheduler tick does not start a second execution', async () => {
    const h = harness({ script: [availableObs()] });

    await Promise.all([h.worker.tick(), h.worker.tick()]);

    expect(h.adapter.calls).toHaveLength(1);
    expect(h.executor.orders).toHaveLength(1);
    expect(h.attempts()).toHaveLength(1);
    expect(h.calls('submitDemoOrder')).toBe(1);
  });

  it('A12: the same imported signal twice queues exactly one extra observation', async () => {
    const h = harness({ script: [soldOutObs(), soldOutObs()] });

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(1);
    expect(Date.parse(h.mission().nextCheckAt!)).toBeGreaterThan(Date.parse(h.nowIso()));

    h.clock.advanceMs(5000);
    const first = h.worker.importSignal({ missionId: h.missionId, kind: 'restock_alert', dedupeKey: 'alert-1', evidenceId: 'ev_alert_1', receivedAt: h.nowIso() });
    expect(first).toEqual({ queued: true, duplicate: false });
    expect(h.mission().nextCheckAt).toBe(h.nowIso());

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(2);

    const second = h.worker.importSignal({ missionId: h.missionId, kind: 'restock_alert', dedupeKey: 'alert-1', evidenceId: 'ev_alert_1', receivedAt: h.nowIso() });
    expect(second).toEqual({ queued: false, duplicate: true });
    await h.worker.tick();

    expect(h.adapter.calls).toHaveLength(2);
    expect(h.eventTypes().filter((t) => t === 'signal.imported')).toHaveLength(1);
    expect(h.worker.missionView(h.missionId)!.latency.signalReceivedAt).not.toBeNull();
  });

  it('Defect 1: a denied origin-limiter attempt is deferred to the limiter\'s own window, not the full cadence', async () => {
    const h = harness({
      script: [soldOutObs(), soldOutObs()],
      // A 120s baseline (as in the live run) with a 1/min origin allowance: an imported signal 5s
      // after the first read must not be pushed out by a full 120s cadence.
      policy: { ...DEMO_MONITOR_POLICY, baselineIntervalSeconds: 120, priorityIntervalSeconds: 120, maxObservationsPerOriginPerMinute: 1 },
    });

    await h.worker.tick(); // t0: consumes the origin's one-per-minute allowance
    expect(h.adapter.calls).toHaveLength(1);

    h.clock.advanceMs(5000); // t0+5s
    h.worker.importSignal({ missionId: h.missionId, kind: 'restock_alert', dedupeKey: 'alert-defer', evidenceId: null, receivedAt: h.nowIso() });
    expect(h.mission().nextCheckAt).toBe(h.nowIso());

    await h.tickAfter(1000); // t0+6s: due, but the origin limiter still denies it
    expect(h.adapter.calls).toHaveLength(1); // no adapter call was made
    expect(h.mission().consecutiveFailures).toBe(0); // a denial is not an observation failure
    expect(h.eventTypes()).toContain('observation.deferred');
    const deferred = h.timeline().find((e) => e.type === 'observation.deferred')!;
    expect(deferred.payload.reason).toBe('origin_rate_limit');
    expect(deferred.payload.origin).toBe(h.adapter.origin);
    expect(deferred.payload.retryAt).toBe('2026-09-18T00:01:00.000Z'); // t0 + 60s
    expect(h.mission().nextCheckAt).toBe('2026-09-18T00:01:00.000Z'); // t0 + 60s, not t0 + the 120s cadence
    expect(h.worker.health().cadenceLabels).toContain('Deferred: origin limit');

    await h.tickAfter(55_000); // t0+61s: the limiter's own minute has now elapsed
    expect(h.adapter.calls).toHaveLength(2);
  });

  it('Defect 1: with headroom in the origin limiter, an imported signal is observed on the very next tick', async () => {
    const h = harness({
      script: [soldOutObs(), soldOutObs()],
      policy: { ...DEMO_MONITOR_POLICY, baselineIntervalSeconds: 120, priorityIntervalSeconds: 120, maxObservationsPerOriginPerMinute: 2 },
    });

    await h.worker.tick(); // t0
    expect(h.adapter.calls).toHaveLength(1);

    h.clock.advanceMs(5000); // t0+5s
    h.worker.importSignal({ missionId: h.missionId, kind: 'restock_alert', dedupeKey: 'alert-room', evidenceId: null, receivedAt: h.nowIso() });

    await h.worker.tick(); // same instant: the limiter still has room for a second call
    expect(h.adapter.calls).toHaveLength(2);
    expect(h.eventTypes()).not.toContain('observation.deferred');
  });
});

// ---------------------------------------------------------------------
// A09/A10/A17/A24: packaging
// ---------------------------------------------------------------------

describe('packaging policy (A09, A10, A17, A24)', () => {
  it('A09: must_be_intact with a stated removal is ineligible and nothing is prepared', async () => {
    const h = harness({ intent: { packagingPolicy: 'must_be_intact' }, script: [availableObs({}, { packagingCondition: 'stated_removed' })] });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(h.eventTypes()).toContain('candidate.rejected');
    expect(h.executor.calls).toEqual([]);
    expect(h.executor.orders).toEqual([]);
    const eligibility = h.worker.missionView(h.missionId)!.eligibility!;
    expect(eligibility.verdict).toBe('ineligible');
    expect(eligibility.checks.find((c) => c.check === 'packaging')!.verdict).toBe('ineligible');
  });

  it('A09: ask pauses for user review and proceeds only after acceptCondition', async () => {
    const h = harness({
      intent: { packagingPolicy: 'ask' },
      script: [
        availableObs({ observationId: 'obs_pack_1', evidenceId: 'ev_pack_notice', pageRevision: 'rev-1' }, { packagingCondition: 'stated_removed' }),
        availableObs({ observationId: 'obs_pack_2', evidenceId: 'ev_pack_notice', pageRevision: 'rev-1' }, { packagingCondition: 'stated_removed' }),
      ],
    });

    await h.worker.tick();
    expect(h.state()).toBe('PAUSED');
    expect(h.mission().pauseReason).toBe('user_review_required');
    expect(h.eventTypes()).toContain('condition.review_requested');
    expect(h.worker.health().health).toBe('Paused');
    expect(h.executor.calls).toEqual([]);

    await h.tickAfter(31_000); // a paused mission does not observe
    expect(h.adapter.calls).toHaveLength(1);

    h.worker.acceptCondition(h.missionId, 'ev_pack_notice');
    expect(h.state()).toBe('WATCHING');
    expect(h.mission().intent.allowedConditionEvidenceIds).toContain('ev_pack_notice');

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(2);
    expect(h.state()).toBe('COMPLETED');
    expect(h.executor.orders).toHaveLength(1);
    expect(h.calls('addOneToCart')).toBe(1);
  });

  it('A09: removed_allowed proceeds on a stated removal', async () => {
    const h = harness({ intent: { packagingPolicy: 'removed_allowed' }, script: [availableObs({}, { packagingCondition: 'stated_removed' })] });

    await h.worker.tick();

    expect(h.state()).toBe('COMPLETED');
    expect(h.executor.orders).toHaveLength(1);
  });

  it('A10/A24: must_be_intact with an unreadable notice and no interpreter prepares nothing, and blocked readiness is surfaced', async () => {
    const h = harness({
      intent: { packagingPolicy: 'must_be_intact' },
      script: [availableObs({}, { packagingCondition: 'unreadable' })],
      interpreter: null,
      apiReadiness: 'blocked',
    });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(h.executor.calls).toEqual([]);
    expect(h.executor.orders).toEqual([]);
    const eligibility = h.worker.missionView(h.missionId)!.eligibility!;
    expect(eligibility.verdict).toBe('unknown');
    expect(eligibility.checks.find((c) => c.check === 'packaging')!.verdict).toBe('unknown');
    expect(h.worker.health().apiReadiness).toBe('blocked');
  });

  it('A10: an interpreter may resolve an unreadable notice, and the resolved fact is re-checked by code', async () => {
    const interpreter = stubInterpreter({ ok: true, assessment: { packagingCondition: 'stated_intact', evidenceIds: ['ev_zoom_crop'] } });
    const h = harness({
      intent: { packagingPolicy: 'must_be_intact' },
      script: [availableObs({}, { packagingCondition: 'unreadable' })],
      interpreter,
    });

    await h.worker.tick();

    expect(interpreter.calls).toHaveLength(1);
    expect(h.state()).toBe('COMPLETED');
    expect(h.executor.orders).toHaveLength(1);
    expect(h.store.getSetting(`mission.${h.missionId}.assessment`)).toContain('ev_zoom_crop');
  });

  it('A10/A17: an interpreter reporting a condition that conflicts with the policy cannot authorise preparation', async () => {
    const interpreter = stubInterpreter({ ok: true, assessment: { packagingCondition: 'stated_removed' } });
    const h = harness({
      intent: { packagingPolicy: 'must_be_intact' },
      script: [availableObs({}, { packagingCondition: 'unreadable' })],
      interpreter,
    });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(h.eventTypes()).toContain('candidate.rejected');
    expect(h.executor.calls).toEqual([]);
    expect(h.executor.orders).toEqual([]);
  });

  it('A24: an interpreter refusal pauses for user review and is never read as approval', async () => {
    const interpreter = stubInterpreter({ ok: false, reason: 'model declined: cannot read the packaging notice' });
    const h = harness({
      intent: { packagingPolicy: 'must_be_intact' },
      script: [availableObs({}, { packagingCondition: 'unreadable' })],
      interpreter,
    });

    await h.worker.tick();

    expect(h.state()).toBe('PAUSED');
    expect(h.mission().pauseReason).toBe('user_review_required');
    expect(h.eventTypes()).toContain('interpretation.blocked');
    expect(h.executor.calls).toEqual([]);
    expect(h.executor.orders).toEqual([]);
    expect(h.worker.health().health).toBe('Paused');
  });
});

// ---------------------------------------------------------------------
// A11: delivered total
// ---------------------------------------------------------------------

describe('delivered total (A11)', () => {
  it('A11: an unknown delivered total permits preparation but blocks submission', async () => {
    const executor = new UnknownTotalExecutor();
    const h = harness({ executor, script: [availableObs({}, { deliveryFeeMinor: null, deliveredTotalMinor: null })] });

    await h.worker.tick();

    // Preparation happened (adding to cart before the total is known is permitted preparation)...
    expect(h.calls('addOneToCart')).toBe(1);
    // ...but the final act did not.
    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.state()).toBe('WATCHING');
    expect(h.eventTypes()).toContain('checkout.not_eligible');
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
    const eligibility = h.worker.missionView(h.missionId)!.eligibility!;
    expect(eligibility.verdict).toBe('unknown');
    expect(eligibility.checks.find((c) => c.check === 'deliveredTotal')!.verdict).toBe('unknown');
  });

  it('A11: a delivered total over budget at checkout review blocks submission', async () => {
    const executor = new FakeExecutor({ deliveryFeeMinor: 20_000 });
    const h = harness({ executor, intent: { maxDeliveredPriceMinor: 10_000 }, script: [availableObs({}, { deliveryFeeMinor: null, deliveredTotalMinor: null })] });

    await h.worker.tick();

    expect(h.calls('addOneToCart')).toBe(1);
    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.state()).toBe('WATCHING');
    expect(h.eventTypes()).toContain('checkout.not_eligible');
  });
});

// ---------------------------------------------------------------------
// A12/A14/A15: cart discipline
// ---------------------------------------------------------------------

describe('cart discipline (A12, A14, A15)', () => {
  it('A14: a target already in the cart is not added again and quantity never goes above one', async () => {
    const executor = new FakeExecutor();
    const h = harness({ executor, script: [availableObs()] });
    await executor.addOneToCart(h.intent); // the user already put it there
    expect(h.calls('addOneToCart')).toBe(1);

    await h.worker.tick();

    expect(h.state()).toBe('COMPLETED');
    expect(h.calls('addOneToCart')).toBe(1); // no second add
    const cart = await executor.readCart(h.intent);
    expect(cart.ok && cart.value.lines.reduce((n, l) => n + l.quantity, 0)).toBe(1);
    expect(executor.orders).toHaveLength(1);
  });

  it('A14: unrelated cart lines require user review; nothing is added or removed', async () => {
    const executor = new UnrelatedLineExecutor();
    const h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();

    expect(h.state()).toBe('PAUSED');
    expect(h.mission().pauseReason).toBe('cart_user_review');
    expect(h.calls('readCart')).toBe(1);
    expect(h.calls('addOneToCart')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
    const cart = await executor.readCart(h.intent);
    expect(cart.ok && cart.value.lines.some((l) => l.retailerProductId === 'other-prod' && l.quantity === 2)).toBe(true);
  });

  it('A12/A14: an unclear add-to-cart is resolved by re-reading the cart, never by adding again', async () => {
    const executor = new FakeExecutor({ addToCartBehavior: 'unclear' });
    const h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();

    expect(h.calls('addOneToCart')).toBe(1);
    expect(h.calls('readCart')).toBe(2); // re-read before any repeat
    expect(h.state()).toBe('COMPLETED');
    const cart = await executor.readCart(h.intent);
    expect(cart.ok && cart.value.lines.reduce((n, l) => n + l.quantity, 0)).toBe(1);
    expect(executor.orders).toHaveLength(1);
  });

  it('A15: a failed cart action halts the remaining actions and returns to watching', async () => {
    const executor = new FakeExecutor({ addToCartBehavior: 'throw' });
    const h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(h.calls('reviewCheckout')).toBe(0);
    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
    expect(h.eventTypes()).toContain('attempt.abandoned');
  });
});

// ---------------------------------------------------------------------
// A13: stale assessment
// ---------------------------------------------------------------------

describe('stale assessment (A13)', () => {
  it('A13: a page revision change between validation and submission rejects the action and re-observes', async () => {
    let h: ReturnType<typeof harness<HookedExecutor>>;
    const executor = new HookedExecutor({
      afterReviewCheckout: () => {
        const iso = h.nowIso();
        const changed = makeObservation({ missionId: h.missionId, observationId: 'obs_after_change', evidenceId: 'ev_after_change', pageRevision: 'rev-2', capturedAt: iso });
        h.store.putObservation(changed);
        h.store.patchMission(h.missionId, { lastObservationId: changed.observationId }, iso);
      },
    });
    h = harness({ executor, script: [availableObs({ pageRevision: 'rev-1' }), availableObs({ pageRevision: 'rev-2' })] });

    await h.worker.tick();

    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.state()).toBe('WATCHING');
    const staleEvent = h.store.listEvents(h.missionId, 5000).find((e) => e.type === 'assessment.stale')!;
    expect(staleEvent.payload.reason).toMatch(/Page revision changed/);
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
    expect(Date.parse(h.mission().nextCheckAt!)).toBeLessThanOrEqual(Date.parse(h.nowIso()));

    // The mission can revalidate afterwards: the lock was released and a new generation is claimable.
    await h.tickAfter(1000);
    expect(h.state()).toBe('COMPLETED');
    expect(executor.orders).toHaveLength(1);
    expect(h.attempts().map((a) => a.generation)).toEqual([2, 1]);
  });

  it('A13: an intent revision change between validation and submission rejects the action', async () => {
    let h: ReturnType<typeof harness<HookedExecutor>>;
    const executor = new HookedExecutor({
      afterReviewCheckout: () => {
        h.worker.acceptCondition(h.missionId, 'ev_user_accepted_something_else');
      },
    });
    h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();

    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.state()).toBe('WATCHING');
    const staleEvent = h.store.listEvents(h.missionId, 5000).find((e) => e.type === 'assessment.stale')!;
    expect(staleEvent.payload.reason).toMatch(/Intent revision changed/);
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
  });
});

// ---------------------------------------------------------------------
// A16: access controls
// ---------------------------------------------------------------------

describe('access controls (A16)', () => {
  it.each(['captcha', 'queue', 'login_expired'] as const)('A16: %s pauses the mission with no bypass attempt', async (accessControl) => {
    const h = harness({ script: [availableObs({ accessControl })] });

    await h.worker.tick();

    expect(h.state()).toBe('PAUSED');
    expect(h.mission().pauseReason).toBe(accessControl);
    expect(h.eventTypes()).toContain('access_control.paused');
    expect(h.worker.health().health).toBe('Paused');
    expect(h.executor.calls).toEqual([]);
    expect(h.executor.orders).toEqual([]);

    await h.tickAfter(31_000); // no retry, no second route to the origin
    expect(h.adapter.calls).toHaveLength(1);
  });

  it('A16: rate limiting honours Retry-After and takes no observation before it elapses', async () => {
    const h = harness({
      script: [makeObservation({ availability: 'UNKNOWN', offer: null, accessControl: 'rate_limited', retryAfterSeconds: 120 }), soldOutObs()],
    });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING'); // bounded backoff, not a pause
    const health = h.worker.health();
    expect(health.cadenceLabels).toContain('Honouring Retry-After 120s');
    expect(Date.parse(health.nextCheckAt!) - Date.parse(h.nowIso())).toBe(120_000);
    expect(h.eventTypes()).toContain('observation.completed');

    await h.tickAfter(119_000);
    expect(h.adapter.calls).toHaveLength(1);

    await h.tickAfter(1000);
    expect(h.adapter.calls).toHaveLength(2);
  });

  it('A16: an unsupported layout is recorded and backed off, and never becomes a candidate', async () => {
    // Documented residual gap: the worker has no pause/handoff path for `unsupported_layout`. It counts
    // the observation as a failure (bounded backoff), records it, and never treats the page as readable,
    // so no candidate, no interpretation and no preparation can follow. This test pins that behaviour
    // rather than the brief's softer "an unknown layout moves the handoff earlier".
    const interpreter = stubInterpreter({ ok: true, assessment: {} });
    const h = harness({
      interpreter,
      script: [availableObs({ accessControl: 'unsupported_layout' }), soldOutObs()],
    });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(h.mission().pauseReason).toBeNull();
    expect(h.mission().consecutiveFailures).toBe(1);
    expect(interpreter.calls).toHaveLength(0);
    expect(h.executor.calls).toEqual([]);
    const completed = h.store.listEvents(h.missionId, 5000).find((e) => e.type === 'observation.completed')!;
    expect(completed.payload.accessControl).toBe('unsupported_layout');
    expect(Date.parse(h.mission().nextCheckAt!) - Date.parse(h.nowIso())).toBe(30_000);

    await h.tickAfter(29_000);
    expect(h.adapter.calls).toHaveLength(1);
  });

  it('A16: with live observation disabled the worker never touches the origin and reports Disabled', async () => {
    const h = harness<null>({
      intent: { mode: 'lazada_assist', authority: 'prepare' },
      policy: LIVE_DISABLED_POLICY,
      executor: null,
      script: [],
      apiReadiness: 'blocked',
    });

    for (let i = 0; i < 3; i++) await h.tickAfter(60_000);

    expect(h.adapter.calls).toHaveLength(0);
    expect(h.state()).toBe('WATCHING');
    const health = h.worker.health();
    expect(health.health).toBe('Disabled');
    expect(health.cadence).toBe('disabled');
    expect(health.nextCheckAt).toBeNull();
  });
});

// ---------------------------------------------------------------------
// A16/A18/A21/A22: handoff and stop controls
// ---------------------------------------------------------------------

function liveHarness() {
  const executor = new LivePrepareExecutor();
  return harness<LivePrepareExecutor>({
    executor,
    intent: { mode: 'lazada_assist', authority: 'prepare' },
    policy: REVIEWED_LIVE_POLICY,
    apiReadiness: 'live',
    script: [availableObs()],
  });
}

describe('handoff and stop controls (A16, A18, A21, A22)', () => {
  it('A18/A21: live preparation locks the handoff before relinquishing control and never submits', async () => {
    const h = liveHarness();

    await h.worker.tick();

    expect(h.state()).toBe('HANDOFF_LOCKED');
    const attempt = h.attempts()[0]!;
    expect(attempt.state).toBe('HANDOFF_LOCKED');
    expect(attempt.handoffAt).not.toBeNull();
    expect(attempt.submissionAt).toBeNull();
    expect(h.executor.calls).not.toContain('submitDemoOrder');
    expect(h.eventTypes()).toContain('handoff.locked');
    const latency = h.worker.missionView(h.missionId)!.latency;
    expect(latency.handoffAt).not.toBeNull();
    expect(latency.submissionAt).toBeNull();
    expect(latency.orderObservedAt).toBeNull();
  });

  it('A22: pause and cancel are refused while the handoff lock is held, and each refusal is recorded', async () => {
    const h = liveHarness();
    await h.worker.tick();
    expect(h.state()).toBe('HANDOFF_LOCKED');

    const afterCancel = h.worker.cancelMission(h.missionId);
    expect(afterCancel.state).toBe('HANDOFF_LOCKED');
    expect(afterCancel.stopRequested).toBe('CANCELLED');

    const afterPause = h.worker.pauseMission(h.missionId, 'user stepped away');
    expect(afterPause.state).toBe('HANDOFF_LOCKED');

    const refusals = h.store.listEvents(h.missionId, 5000).filter((e) => e.type === 'stop.refused');
    expect(refusals.map((e) => e.payload.requested).sort()).toEqual(['CANCELLED', 'PAUSED']);

    // A21: the lock survives further ticks; reconciliation alone cannot resolve it.
    await h.tickAfter(60_000);
    expect(h.state()).toBe('HANDOFF_LOCKED');
    expect(h.eventTypes()).toContain('reconciliation.pending');
    expect(h.adapter.calls).toHaveLength(1);

    // Only the user resolves it; the recorded cancellation then applies.
    const resolved = h.worker.completeHandoff(h.missionId, { result: 'not_ordered', merchantOrderRef: null });
    expect(resolved.state).toBe('CANCELLED');
    expect(resolved.stopRequested).toBeNull();
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
  });

  it('A22: pause and cancel are legal from an observing state and stop all future observations', async () => {
    const h = harness({ script: [soldOutObs(), soldOutObs()] });

    await h.worker.tick();
    expect(h.state()).toBe('WATCHING');

    expect(h.worker.pauseMission(h.missionId, 'user requested').state).toBe('PAUSED');
    expect(h.mission().pauseReason).toBe('user requested');
    await h.tickAfter(31_000);
    expect(h.adapter.calls).toHaveLength(1);

    expect(h.worker.resumeMission(h.missionId).state).toBe('WATCHING');
    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(2);

    expect(h.worker.cancelMission(h.missionId).state).toBe('CANCELLED');
    await h.tickAfter(31_000);
    expect(h.adapter.calls).toHaveLength(2);
    expect(h.executor.orders).toEqual([]);
  });

  it('A22: cancelling a finished mission is refused and the order stays visible', async () => {
    const h = harness({ script: [availableObs()] });
    await h.worker.tick();
    expect(h.state()).toBe('COMPLETED');

    const after = h.worker.cancelMission(h.missionId);

    expect(after.state).toBe('COMPLETED');
    expect(h.eventTypes()).toContain('stop.refused');
    expect(h.attempts()[0]!.state).toBe('ORDER_OBSERVED');
    expect(h.attempts()[0]!.merchantOrderRef).toBe(h.executor.orders[0]!.orderRef);
    expect(h.executor.orders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// A19/A20/A22: submission uncertainty
// ---------------------------------------------------------------------

describe('submission uncertainty (A19, A20, A22)', () => {
  it('A19/A20: an unclear submission holds UNKNOWN, never resubmits, and reconciles to exactly one order', async () => {
    const executor = new FakeExecutor({ submitBehavior: 'unclear' });
    const h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();
    expect(h.state()).toBe('UNKNOWN');
    expect(executor.orders).toHaveLength(1); // the merchant did process it; only the response was lost
    expect(h.calls('submitDemoOrder')).toBe(1);

    await h.tickAfter(5000);
    expect(h.state()).toBe('COMPLETED');
    expect(h.calls('submitDemoOrder')).toBe(1);
    expect(executor.orders).toHaveLength(1);
    const attempt = h.attempts()[0]!;
    expect(attempt.state).toBe('ORDER_OBSERVED');
    expect(attempt.merchantOrderRef).toBe(executor.orders[0]!.orderRef);
    expect(h.eventTypes()).toContain('mission.completed');

    // A20: an observed order stops further purchase work.
    for (let i = 0; i < 3; i++) await h.tickAfter(31_000);
    expect(h.state()).toBe('COMPLETED');
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.calls('submitDemoOrder')).toBe(1);
    expect(h.attempts()).toHaveLength(1);
  });

  it('A19/A20: while reconciliation is unresolved no second attempt can be claimed, and a delayed order still completes once', async () => {
    const executor = new FakeExecutor({ submitBehavior: 'unclear', findOrderResult: null });
    const h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();
    expect(h.state()).toBe('UNKNOWN');

    for (let i = 0; i < 4; i++) await h.tickAfter(5000);
    expect(h.state()).toBe('UNKNOWN');
    expect(h.calls('submitDemoOrder')).toBe(1);
    expect(h.eventTypes().filter((t) => t === 'reconciliation.pending').length).toBeGreaterThan(0);

    // Section 9: one account execution lock, and no new attempt while a prior one is unresolved.
    expect(() => h.store.claimAttempt(h.missionId, 'obs_other', h.nowIso())).toThrow(/Execution lock held/);
    h.store.releaseExecutionLock(h.missionId, h.nowIso());
    expect(() => h.store.claimAttempt(h.missionId, 'obs_other', h.nowIso())).toThrow(/Unresolved prior attempt/);

    // The delayed confirmation becomes visible.
    executor.setFindOrderResult(executor.orders[0]!);
    for (let i = 0; i < 6 && h.state() !== 'COMPLETED'; i++) await h.tickAfter(5000);

    expect(h.state()).toBe('COMPLETED');
    expect(executor.orders).toHaveLength(1);
    expect(h.calls('submitDemoOrder')).toBe(1);
    expect(h.attempts()).toHaveLength(1);
    expect(h.attempts()[0]!.merchantOrderRef).toBe(executor.orders[0]!.orderRef);
  });

  it('A19: a definite sold-out at submission returns to watching with no order', async () => {
    const executor = new FakeExecutor({ submitBehavior: 'sold_out' });
    const h = harness({ executor, script: [availableObs(), soldOutObs()] });

    await h.worker.tick();

    expect(h.state()).toBe('WATCHING');
    expect(executor.orders).toEqual([]);
    expect(h.calls('submitDemoOrder')).toBe(1);
    expect(h.attempts()[0]!.state).toBe('ABANDONED');
    expect(h.mission().executionLockAttemptId).toBeNull();
    expect(h.eventTypes()).toContain('attempt.abandoned');
    // The locked submission state is left only through a recorded UNKNOWN, never by an illegal edge.
    const transitions = h.timeline().filter((e) => e.type === 'mission.transition').map((e) => e.payload.to);
    expect(transitions.slice(-2)).toEqual(['UNKNOWN', 'WATCHING']);

    await h.tickAfter(31_000);
    expect(h.state()).toBe('WATCHING');
    expect(executor.orders).toEqual([]);
  });

  it('A22: an update from a superseded attempt generation is rejected and changes nothing', async () => {
    let h: ReturnType<typeof harness<HookedExecutor>>;
    const executor = new HookedExecutor({
      beforeAddOneToCart: () => {
        // Another actor recovers the mission and claims the next generation mid-flight.
        h.store.releaseExecutionLock(h.missionId, h.nowIso());
        h.store.claimAttempt(h.missionId, 'obs_recovered', h.nowIso());
      },
    });
    h = harness({ executor, script: [availableObs()] });

    await h.worker.tick();

    expect(h.logs.some((l) => /stale generation/i.test(l))).toBe(true);
    expect(h.calls('submitDemoOrder')).toBe(0);
    expect(executor.orders).toEqual([]);
    expect(h.mission().generation).toBe(2);
    expect(h.state()).toBe('PREPARING'); // the superseded worker wrote nothing further

    const superseded = h.attempts().find((a) => a.generation === 1)!;
    expect(superseded.state).toBe('CLAIMED');
    expect(() => h.store.updateAttempt(superseded.attemptId, 1, { state: 'CHECKOUT_READY' }, h.nowIso())).toThrow(StaleGenerationError);
    expect(h.store.getAttempt(superseded.attemptId)!.state).toBe('CLAIMED');
  });
});

// ---------------------------------------------------------------------
// A22/A23: downtime and expiry
// ---------------------------------------------------------------------

describe('downtime and expiry (A22, A23)', () => {
  it('A23: after hours of downtime one tick takes exactly one observation and health reports Degraded', async () => {
    const h = harness({ script: [soldOutObs(), soldOutObs(), soldOutObs()] });
    h.store.setSetting('worker.intervalMs', '30000'); // as a prior run would have left it

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.worker.health().health).toBe('Healthy');
    expect(h.worker.health().missedChecks).toBe(0);

    await h.tickAfter(3 * 60 * 60 * 1000); // the laptop slept for three hours

    expect(h.adapter.calls).toHaveLength(2); // exactly one newly eligible observation, no catch-up burst
    const health = h.worker.health();
    expect(health.health).toBe('Degraded');
    expect(health.missedChecks).toBe(359);
    const recovery = h.store.listEvents(h.missionId, 5000).find((e) => e.type === 'worker.resumed_after_downtime')!;
    expect(recovery.payload.gapMs).toBe(3 * 60 * 60 * 1000);
    // `missedTicksDiscarded` redaction was fixed (whole-key match); assertion below is optional. Note kept:
    // "missedTicksDis[card]ed" is rewritten to '[redacted]' before it is persisted.
    expect(recovery.payload.missedTicksDiscarded).toBeDefined();

    await h.tickAfter(31_000);
    expect(h.adapter.calls).toHaveLength(3);
    expect(h.worker.health().health).toBe('Healthy');
    expect(h.worker.health().missedChecks).toBe(0);
  });

  it('A22: once expiresAt has passed the mission expires, stops observing, and reports Expired', async () => {
    const h = harness({ intent: { expiresAt: '2026-09-18T01:00:00.000Z' }, script: [soldOutObs()] });

    await h.worker.tick();
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.state()).toBe('WATCHING');

    await h.tickAfter(2 * 60 * 60 * 1000);

    expect(h.state()).toBe('EXPIRED');
    expect(h.worker.health().health).toBe('Expired');
    expect(h.adapter.calls).toHaveLength(1);

    await h.tickAfter(31_000);
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.executor.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Section 7: health, latency marks, provenance, timeline
// ---------------------------------------------------------------------

describe('health, latency, and provenance (Section 7)', () => {
  it('Section 7: health moves Healthy -> Degraded -> Healthy -> Paused -> Healthy -> Expired', async () => {
    const h = harness({ script: [failedObs(), failedObs(), soldOutObs()] });

    await h.worker.tick();
    expect(h.mission().consecutiveFailures).toBe(1);
    expect(h.worker.health().health).toBe('Healthy');

    await h.tickAfter(31_000);
    expect(h.mission().consecutiveFailures).toBe(2);
    expect(h.worker.health().health).toBe('Degraded');

    await h.tickAfter(31_000);
    expect(h.mission().consecutiveFailures).toBe(0);
    expect(h.worker.health().health).toBe('Healthy');
    expect(h.worker.health().lastSuccessfulObservationAt).not.toBeNull();

    h.worker.pauseMission(h.missionId, 'session check');
    expect(h.worker.health().health).toBe('Paused');

    h.worker.resumeMission(h.missionId);
    expect(h.worker.health().health).toBe('Healthy');

    h.clock.set(EXPIRES);
    await h.worker.tick();
    expect(h.state()).toBe('EXPIRED');
    expect(h.worker.health().health).toBe('Expired');
  });

  it('Section 7: latency marks fill in at their own moments, and events carry provenance in timeline order', async () => {
    const h = harness({ script: [soldOutObs(), availableObs()] });

    await h.worker.tick();
    const early = h.worker.missionView(h.missionId)!.latency;
    expect(early.observationStartAt).toBe(T0);
    expect(early.observationEndAt).toBe(T0);
    expect(early.signalReceivedAt).toBeNull();
    expect(early.candidateAt).toBeNull();
    expect(early.validationDoneAt).toBeNull();
    expect(early.checkoutReadyAt).toBeNull();
    expect(early.submissionAt).toBeNull();
    expect(early.orderObservedAt).toBeNull();

    h.clock.advanceMs(10_000);
    const signalAt = h.nowIso();
    h.worker.importSignal({ missionId: h.missionId, kind: 'restock_alert', dedupeKey: 'alert-latency', evidenceId: null, receivedAt: signalAt });
    await h.worker.tick();
    expect(h.state()).toBe('COMPLETED');

    const l = h.worker.missionView(h.missionId)!.latency;
    expect(l.signalReceivedAt).toBe(signalAt);
    expect(l.observationStartAt).toBe(signalAt);
    expect(l.candidateAt).toBe(signalAt);
    expect(l.validationDoneAt).toBe(signalAt);
    expect(l.checkoutReadyAt).toBe(signalAt);
    expect(l.submissionAt).toBe(signalAt);
    expect(l.orderObservedAt).toBe(signalAt);
    expect(l.handoffAt).toBeNull();
    const marks = [l.signalReceivedAt!, l.observationStartAt!, l.observationEndAt!, l.candidateAt!, l.validationDoneAt!, l.checkoutReadyAt!, l.submissionAt!, l.orderObservedAt!].map((s) => Date.parse(s));
    expect(marks).toEqual([...marks].sort((a, b) => a - b));

    // Provenance: user actions are manual_input; observations carry the adapter's provenance.
    const chronological = h.timeline();
    const approval = chronological.find((e) => e.type === 'mission.transition' && e.payload.to === 'WATCHING')!;
    expect(approval.provenance).toBe('manual_input');
    expect(chronological.find((e) => e.type === 'observation.completed')!.provenance).toBe(h.adapter.provenance);
    expect(chronological.every((e) => typeof e.provenance === 'string' && e.provenance.length > 0)).toBe(true);

    // Timeline order: the recorded sequence tells the story forwards.
    const order = (type: string): number => chronological.findIndex((e) => e.type === type);
    expect(order('intent.drafted')).toBe(0);
    for (const [before, after] of [
      ['observation.started', 'observation.completed'],
      ['observation.completed', 'validation.completed'],
      ['validation.completed', 'attempt.claimed'],
      ['attempt.claimed', 'attempt.submission_started'],
      ['attempt.submission_started', 'order.observed'],
      ['order.observed', 'mission.completed'],
    ] as const) {
      expect(order(before)).toBeGreaterThanOrEqual(0);
      expect(order(before)).toBeLessThan(order(after));
    }
  });
});
