/**
 * Deterministic tests for the pure statistics helpers behind scripts/lazada-live-reaction.ts
 * (src/eval/reactionStats.ts). No script, browser, worker, or network involved.
 */
import { describe, expect, it } from 'vitest';
import { alertPipelineMs, catchProbability, max, missionStateAtOrBefore, p50, p95, percentile, reactionEstimate, summarizeTimings } from '../../src/eval/reactionStats.ts';

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

describe('reactionEstimate', () => {
  it('pairs the mean wait (cadence/2) with p50 and the p95 wait (0.95 x cadence) with p95', () => {
    expect(reactionEstimate({ cadenceSeconds: 120, pipelineMsP50: 2000, pipelineMsP95: 7000 })).toEqual({ meanMs: 62_000, p95Ms: 121_000 });
  });

  it('regression: the old "floor" (cadence/2 + p95s) understated the 120 s p95 by ~57 s', () => {
    const oldFloor = 60_000 + 7_000 + 4_100; // run 3 as reported: ~71 s
    const { p95Ms } = reactionEstimate({ cadenceSeconds: 120, pipelineMsP50: null, pipelineMsP95: 7_000 + 4_100 });
    expect(p95Ms - oldFloor).toBe(54_000);
  });

  it('treats missing pipeline timings as zero', () => {
    expect(reactionEstimate({ cadenceSeconds: 60, pipelineMsP50: null, pipelineMsP95: null })).toEqual({ meanMs: 30_000, p95Ms: 57_000 });
  });
});

describe('catchProbability', () => {
  it('120 s polling, 60 s sell-out, 2 s pipeline, 20 s to buy: 38 of 120 s of arrival phase are caught', () => {
    expect(catchProbability({ cadenceSeconds: 120, selloutSeconds: 60, pipelineMs: 2000, humanActionSeconds: 20 })).toBeCloseTo(38 / 120, 10);
  });

  it('is 0 when the pipeline plus the human alone exceed the sell-out', () => {
    expect(catchProbability({ cadenceSeconds: 60, selloutSeconds: 30, pipelineMs: 12_000, humanActionSeconds: 20 })).toBe(0);
  });

  it('caps at 1 when the margin exceeds the cadence', () => {
    expect(catchProbability({ cadenceSeconds: 10, selloutSeconds: 60, pipelineMs: 2000, humanActionSeconds: 20 })).toBe(1);
  });

  it('a model call on the alert path costs catch probability directly', () => {
    const withoutModel = catchProbability({ cadenceSeconds: 120, selloutSeconds: 60, pipelineMs: 2000, humanActionSeconds: 20 });
    const withOpus = catchProbability({ cadenceSeconds: 120, selloutSeconds: 60, pipelineMs: 2000 + 25_000, humanActionSeconds: 20 });
    expect(withoutModel - withOpus).toBeCloseTo(25 / 120, 10);
  });
});

describe('alertPipelineMs', () => {
  it('sums slack, observe and the validation-to-alert gap', () => {
    expect(alertPipelineMs({ schedulerSlackMs: 600, observeMs: 1900, alertAfterObserveMs: 5 })).toBe(2505);
  });

  it('ignores negative slack (a read that started before its plan) and a missing alert gap', () => {
    expect(alertPipelineMs({ schedulerSlackMs: -40, observeMs: 1900, alertAfterObserveMs: null })).toBe(1900);
  });

  it('is null without slack or observe timing', () => {
    expect(alertPipelineMs({ schedulerSlackMs: null, observeMs: 1900, alertAfterObserveMs: 5 })).toBeNull();
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
