import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redact, StaleGenerationError, Store } from '../../src/storage/db.ts';
import { IllegalTransitionError } from '../../src/domain/state.ts';
import { makeIntent } from './builders.ts';

const T0 = '2026-09-25T05:27:00.000Z';
const T1 = '2026-09-25T05:27:05.000Z';
const T2 = '2026-09-25T05:27:40.000Z';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

describe('missions', () => {
  it('A12: only one active mission may exist at a time', () => {
    store.createMission(makeIntent(), T0);
    const second = makeIntent({ id: 'msn_002', fulfillmentKey: 'fk_second_mission_002' });
    expect(() => store.createMission(second, T0)).toThrow(/One active mission at a time/);
    expect(store.listMissions()).toHaveLength(1);

    // A cancelled mission frees the slot without erasing the first record.
    store.transition('msn_001', 'CANCELLED', T1);
    expect(store.createMission(second, T1).id).toBe('msn_002');
    expect(store.activeMission()?.id).toBe('msn_002');
    expect(store.listMissions()).toHaveLength(2);
  });

  it('A13: updateIntent rejects a fulfillmentKey change', () => {
    store.createMission(makeIntent(), T0);
    const edited = makeIntent({ revision: 2, fulfillmentKey: 'fk_rewritten_by_caller' });
    expect(() => store.updateIntent('msn_001', edited, T1, 'edit')).toThrow(/fulfillmentKey is immutable/);
    expect(store.getMission('msn_001')?.intent.revision).toBe(1);
  });

  it.each([{ revision: 1, why: 'same revision' }, { revision: 3, why: 'skips a revision' }])(
    'A13: updateIntent rejects revision $revision ($why)',
    ({ revision }) => {
      store.createMission(makeIntent(), T0);
      const edited = makeIntent({ revision });
      expect(() => store.updateIntent('msn_001', edited, T1, 'edit')).toThrow(/revision must increment by one/);
      expect(store.getMission('msn_001')?.intent.revision).toBe(1);
    },
  );

  it('A13: an accepted intent edit stores the new revision and an immutable event copy', () => {
    store.createMission(makeIntent(), T0);
    const edited = makeIntent({ revision: 2, maxDeliveredPriceMinor: 13000 });
    const row = store.updateIntent('msn_001', edited, T1, 'user raised the budget');
    expect(row.intent.revision).toBe(2);
    expect(row.intent.maxDeliveredPriceMinor).toBe(13000);
    const revised = store.listEvents('msn_001').find((e) => e.type === 'intent.revised');
    expect(revised?.payload.reason).toBe('user raised the budget');
    expect((revised?.payload.intent as { revision: number }).revision).toBe(2);
  });

  it('A22: an illegal transition throws and leaves the stored state and timeline unchanged', () => {
    store.createMission(makeIntent(), T0);
    store.transition('msn_001', 'WATCHING', T0);
    const eventsBefore = store.listEvents('msn_001').length;

    expect(() => store.transition('msn_001', 'CHECKOUT_READY', T1)).toThrow(IllegalTransitionError);
    expect(store.getMission('msn_001')?.state).toBe('WATCHING');
    expect(store.listEvents('msn_001')).toHaveLength(eventsBefore); // the transaction rolled back

    // The legal edge still works afterwards, so the connection is not left in a broken transaction.
    expect(store.transition('msn_001', 'CANDIDATE', T1).state).toBe('CANDIDATE');
  });

  it('A12: only one observation may be outstanding per mission', () => {
    store.createMission(makeIntent(), T0);
    expect(store.claimObservation('msn_001', T0, 30_000)).toBe(true);
    expect(store.claimObservation('msn_001', T1, 30_000)).toBe(false); // duplicate scheduler tick
    store.releaseObservation('msn_001', T1);
    expect(store.claimObservation('msn_001', T1, 30_000)).toBe(true);
    // A crashed observation is reclaimable only after the staleness window.
    expect(store.claimObservation('msn_001', T2, 30_000)).toBe(true);
    expect(store.getMission('msn_001')?.observationInFlightSince).toBe(T2);
  });
});

describe('attempts and the execution lock', () => {
  beforeEach(() => {
    store.createMission(makeIntent(), T0);
    store.transition('msn_001', 'WATCHING', T0);
    store.transition('msn_001', 'CANDIDATE', T0);
  });

  it('A12: claimAttempt raises the generation, takes the lock, and a second claim is refused', () => {
    const attempt = store.claimAttempt('msn_001', 'obs_001', T0);
    expect(attempt.generation).toBe(1);
    expect(attempt.state).toBe('CLAIMED');
    expect(attempt.intentRevision).toBe(1);
    const mission = store.getMission('msn_001')!;
    expect(mission.generation).toBe(1);
    expect(mission.executionLockAttemptId).toBe(attempt.attemptId);

    expect(() => store.claimAttempt('msn_001', 'obs_002', T1)).toThrow(new RegExp(`Execution lock held by attempt ${attempt.attemptId}`));
    expect(store.listAttempts('msn_001')).toHaveLength(1);
  });

  it('A19: a started submission keeps blocking new attempts even after the lock is released', () => {
    const attempt = store.claimAttempt('msn_001', 'obs_001', T0);
    store.updateAttempt(attempt.attemptId, 1, { state: 'SUBMISSION_STARTED', submissionAt: T0 }, T0, 'attempt.submission_started');
    store.releaseExecutionLock('msn_001', T1); // the worker process died and the lease expired

    expect(() => store.claimAttempt('msn_001', 'obs_002', T1)).toThrow(/Unresolved prior attempt/);
    expect(() => store.claimAttempt('msn_001', 'obs_002', T1)).toThrow(/reconcile before any new attempt/);
    expect(store.getAttempt(attempt.attemptId)?.state).toBe('SUBMISSION_STARTED');
    expect(store.getAttempt(attempt.attemptId)?.submissionAt).toBe(T0);
  });

  it('A21: a handoff-locked attempt also blocks a new attempt after a restart', () => {
    const attempt = store.claimAttempt('msn_001', 'obs_001', T0);
    store.updateAttempt(attempt.attemptId, 1, { state: 'HANDOFF_LOCKED', handoffAt: T0 }, T0, 'attempt.handoff');
    store.releaseExecutionLock('msn_001', T1); // the worker lease expired during the human handoff

    expect(() => store.claimAttempt('msn_001', 'obs_002', T1)).toThrow(/Unresolved prior attempt/);
    expect(store.getAttempt(attempt.attemptId)?.state).toBe('HANDOFF_LOCKED');
    expect(store.getAttempt(attempt.attemptId)?.handoffAt).toBe(T0);
  });

  it('A22: updateAttempt with a stale generation is rejected', () => {
    const attempt = store.claimAttempt('msn_001', 'obs_001', T0);
    expect(() => store.updateAttempt(attempt.attemptId, 0, { state: 'PREPARING' }, T1)).toThrow(StaleGenerationError);
    expect(() => store.updateAttempt(attempt.attemptId, 99, { state: 'PREPARING' }, T1)).toThrow(/Stale generation 99; current is 1/);
    expect(store.getAttempt(attempt.attemptId)?.state).toBe('CLAIMED');
  });

  it('A22: once a stop is requested, a non-reconciling attempt update is rejected', () => {
    const attempt = store.claimAttempt('msn_001', 'obs_001', T0);
    store.patchMission('msn_001', { stopRequested: 'CANCELLED' }, T0);
    expect(() => store.updateAttempt(attempt.attemptId, 1, { state: 'PREPARING' }, T1)).toThrow(/stop requested/i);
    // Reconciling states stay permitted so an unresolved order remains visible.
    expect(store.updateAttempt(attempt.attemptId, 1, { state: 'UNKNOWN' }, T1).state).toBe('UNKNOWN');
  });
});

describe('events', () => {
  it('A12: the same dedupeKey is recorded once and ignored the second time', () => {
    store.createMission(makeIntent(), T0);
    const first = store.appendEvent({ missionId: 'msn_001', type: 'signal.restock_alert', at: T0, provenance: 'manual_input', dedupeKey: 'alert:lazada:42min', payload: { text: '42 minutes ago' } });
    const second = store.appendEvent({ missionId: 'msn_001', type: 'signal.restock_alert', at: T1, provenance: 'manual_input', dedupeKey: 'alert:lazada:42min', payload: { text: '42 minutes ago' } });

    expect(first?.eventId).toBeTruthy();
    expect(second).toBeNull();
    expect(store.listEvents('msn_001').filter((e) => e.dedupeKey === 'alert:lazada:42min')).toHaveLength(1);
  });

  it('A12: distinct dedupe keys are both retained with their source relationship', () => {
    store.createMission(makeIntent(), T0);
    store.appendEvent({ missionId: 'msn_001', type: 'signal.restock_alert', at: T0, provenance: 'manual_input', dedupeKey: 'alert:a', payload: {} });
    store.appendEvent({ missionId: 'msn_001', type: 'signal.restock_alert', at: T1, provenance: 'manual_input', dedupeKey: 'alert:b', payload: {} });
    expect(store.listEvents('msn_001').filter((e) => e.type === 'signal.restock_alert')).toHaveLength(2);
  });
});

describe('redact', () => {
  it('credential-like keys are replaced recursively before anything is persisted', () => {
    const redacted = redact({
      cookie: 'session=abc',
      apiToken: 'sk-live-123',
      user: { password: 'hunter2', shippingAddress: '1 Orchard Rd', nested: [{ authToken: 'tok' }, { quantity: 1 }] },
      quantity: 1,
      productUrl: 'http://127.0.0.1:4310/product/etb-sv10',
    });
    expect(redacted).toEqual({
      cookie: '[redacted]',
      apiToken: '[redacted]',
      user: { password: '[redacted]', shippingAddress: '[redacted]', nested: [{ authToken: '[redacted]' }, { quantity: 1 }] },
      quantity: 1,
      productUrl: 'http://127.0.0.1:4310/product/etb-sv10',
    });
  });

  it('A12: persisted event payloads are redacted on the way into the timeline', () => {
    store.createMission(makeIntent(), T0);
    store.appendEvent({ missionId: 'msn_001', type: 'browser.session', at: T0, provenance: 'demo', payload: { cookie: 'session=abc', pageRevision: 'rev-1' } });
    const event = store.listEvents('msn_001').find((e) => e.type === 'browser.session');
    expect(event?.payload).toEqual({ cookie: '[redacted]', pageRevision: 'rev-1' });
  });
});
