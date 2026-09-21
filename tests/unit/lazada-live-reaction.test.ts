/**
 * Deterministic tests for the pure statistics helpers behind scripts/lazada-live-reaction.ts
 * (src/eval/reactionStats.ts). No script, browser, worker, or network involved.
 */
import { describe, expect, it } from 'vitest';
import { max, missionStateAtOrBefore, p50, p95, percentile, reactionFloorMs, summarizeTimings } from '../../src/eval/reactionStats.ts';

describe('percentile / p50 / p95 / max', () => {
  it('returns null for every stat on an empty array', () => {
    expect(p50([])).toBeNull();
    expect(p95([])).toBeNull();
    expect(max([])).toBeNull();
    expect(percentile([], 50)).toBeNull();
  });

  it('computes p50 (nearest-rank) over an unsorted array', () => {
    expect(p50([4, 1, 3, 2])).toBe(2);
  });

  it('computes p95 over a larger sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(p95(values)).toBe(95);
  });

  it('computes max regardless of input order', () => {
    expect(max([10, 2, 37, 4])).toBe(37);
  });

  it('is stable for a single-element array', () => {
    expect(p50([42])).toBe(42);
    expect(p95([42])).toBe(42);
    expect(max([42])).toBe(42);
  });

  // Nearest-rank definition: the value at ordinal rank ceil(p/100 * n), 1-based, no interpolation.
  it('nearest-rank n=2: p50 is the 1st value, p95 the 2nd', () => {
    expect(p50([20, 10])).toBe(10);
    expect(p95([20, 10])).toBe(20);
  });

  it('nearest-rank n=5: p50 is the 3rd value, p95 the 5th', () => {
    const v = [50, 10, 40, 20, 30];
    expect(p50(v)).toBe(30);
    expect(p95(v)).toBe(50);
  });

  it('nearest-rank n=20: p50 is the 10th value, p95 the 19th', () => {
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 100).reverse(); // 2000..100
    expect(p50(v)).toBe(1000);
    expect(p95(v)).toBe(1900);
    expect(percentile(v, 100)).toBe(2000);
    expect(percentile(v, 0)).toBe(100);
  });

  it('does not mutate its input', () => {
    const v = [3, 1, 2];
    p50(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('summarizeTimings', () => {
  it('reports n and all three stats together', () => {
    const s = summarizeTimings([100, 200, 300, 400]);
    expect(s.n).toBe(4);
    expect(s.max).toBe(400);
    expect(s.p50).not.toBeNull();
    expect(s.p95).not.toBeNull();
  });

  it('reports all-null stats with n=0 for an empty input', () => {
    const s = summarizeTimings([]);
    expect(s).toEqual({ p50: null, p95: null, max: null, n: 0 });
  });
});

describe('reactionFloorMs', () => {
  it('is cadence/2 when there is no measured latency at all', () => {
    expect(reactionFloorMs({ cadenceSeconds: 60, observeMsP95: null, interpretationMsP95: null, validationMsP95: null })).toBe(30_000);
  });

  it('adds observe/interpretation/validation p95 timings on top of cadence/2', () => {
    const floor = reactionFloorMs({ cadenceSeconds: 120, observeMsP95: 2000, interpretationMsP95: 5000, validationMsP95: 100 });
    expect(floor).toBe(60_000 + 2000 + 5000 + 100);
  });

  it('scales with cadence', () => {
    const a = reactionFloorMs({ cadenceSeconds: 60, observeMsP95: 0, interpretationMsP95: 0, validationMsP95: 0 });
    const b = reactionFloorMs({ cadenceSeconds: 600, observeMsP95: 0, interpretationMsP95: 0, validationMsP95: 0 });
    expect(b).toBe(a * 10);
  });
});

describe('missionStateAtOrBefore', () => {
  it('falls back to initialState when transitions is empty', () => {
    expect(missionStateAtOrBefore([], '2026-09-19T00:00:10.000Z', 'DRAFT')).toBe('DRAFT');
  });

  it('falls back to initialState when the query instant is before every transition', () => {
    const transitions = [{ at: '2026-09-19T00:00:10.000Z', to: 'WATCHING' }];
    expect(missionStateAtOrBefore(transitions, '2026-09-19T00:00:05.000Z', 'DRAFT')).toBe('DRAFT');
  });

  it('the real bug: a transition before the query window (not inside it) is still picked up', () => {
    // Regression for scripts/lazada-live-reaction.ts: the store's only transition is DRAFT -> WATCHING,
    // recorded by worker.approveIntent() well before the first observation completes. The old
    // implementation only looked *inside* [completedAt, nextStartedAt) and so never saw it, reporting
    // `stateAfter: null` for every read even though the mission was WATCHING throughout.
    const transitions = [{ at: '2026-09-19T00:00:00.000Z', to: 'WATCHING' }];
    const completedAt = '2026-09-19T00:05:00.000Z'; // long after the transition, no transition in between
    expect(missionStateAtOrBefore(transitions, completedAt, 'DRAFT')).toBe('WATCHING');
  });

  it('picks the latest transition at or before the query instant, ignoring later ones', () => {
    const transitions = [
      { at: '2026-09-19T00:00:00.000Z', to: 'WATCHING' },
      { at: '2026-09-19T00:01:00.000Z', to: 'CANDIDATE' },
      { at: '2026-09-19T00:02:00.000Z', to: 'VALIDATING' },
    ];
    expect(missionStateAtOrBefore(transitions, '2026-09-19T00:01:30.000Z', 'DRAFT')).toBe('CANDIDATE');
  });

  it('an exact match on `at` counts as at-or-before', () => {
    const transitions = [{ at: '2026-09-19T00:01:00.000Z', to: 'CANDIDATE' }];
    expect(missionStateAtOrBefore(transitions, '2026-09-19T00:01:00.000Z', 'DRAFT')).toBe('CANDIDATE');
  });

  it('is order-independent over the input array', () => {
    const transitions = [
      { at: '2026-09-19T00:02:00.000Z', to: 'VALIDATING' },
      { at: '2026-09-19T00:00:00.000Z', to: 'WATCHING' },
      { at: '2026-09-19T00:01:00.000Z', to: 'CANDIDATE' },
    ];
    expect(missionStateAtOrBefore(transitions, '2026-09-19T00:01:30.000Z', 'DRAFT')).toBe('CANDIDATE');
  });
});
