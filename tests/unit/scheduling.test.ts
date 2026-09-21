import { describe, expect, it } from 'vitest';
import { OriginRateLimiter, planLaunch, planNextCheck, PREFLIGHT_LEAD_MS, recoverAfterDowntime, transientBackoffMs } from '../../src/domain/scheduling.ts';
import { monitorPolicyFromConfig } from '../../src/domain/policy.ts';
import { DEMO_MONITOR_POLICY, type MonitorPolicy } from '../../src/domain/types.ts';
import { makeIntent } from './builders.ts';

const DEMO = DEMO_MONITOR_POLICY;
const LIVE_DISABLED: MonitorPolicy = monitorPolicyFromConfig({
  mode: 'lazada_assist',
  liveObserveEnabled: false,
  livePrepareEnabled: false,
  baselineIntervalSeconds: null,
  priorityIntervalSeconds: null,
});

describe('planLaunch', () => {
  it('A01: a source-confirmed 2026-09-25 10:00 SGT launch schedules 02:00Z with a 01:50Z preflight', () => {
    const plan = planLaunch({ dateLocal: '2026-09-25', timeLocal: '10:00', basis: 'source_confirmed' });
    expect(plan.launchAt).toBe('2026-09-25T02:00:00.000Z');
    expect(plan.preflightAt).toBe('2026-09-25T01:50:00.000Z');
    expect(plan.launchBasis).toBe('source_confirmed');
    expect(Date.parse(plan.launchAt!) - Date.parse(plan.preflightAt!)).toBe(PREFLIGHT_LEAD_MS);
    expect(plan.message).toMatch(/Source-confirmed/);
  });

  it('A02: user-expected 10:00 with no date stays draft; no daily launch is scheduled', () => {
    const plan = planLaunch({ dateLocal: null, timeLocal: '10:00', basis: 'user_expected' });
    expect(plan.launchAt).toBeNull();
    expect(plan.preflightAt).toBeNull();
    expect(plan.launchBasis).toBe('user_expected');
    expect(plan.message).toMatch(/Expected by user/);
    expect(plan.message).toMatch(/release date needed/i);
  });

  it('A02: a bare time without a stated date is only a user expectation, never source-confirmed', () => {
    const plan = planLaunch({ dateLocal: null, timeLocal: '10:00', basis: 'source_confirmed' });
    expect(plan.launchBasis).toBe('user_expected');
    expect(plan.launchAt).toBeNull();
  });

  it('A02: no launch information at all yields an unknown basis and no schedule', () => {
    const plan = planLaunch({ dateLocal: null, timeLocal: null, basis: 'unknown' });
    expect(plan).toEqual({ launchAt: null, launchBasis: 'unknown', preflightAt: null, message: 'No launch information' });
  });
});

describe('planNextCheck', () => {
  it('A03: at 13:27 SGT inside the enabled window the demo cadence is the 2s priority interval', () => {
    const plan = planNextCheck(new Date('2026-09-25T05:27:00.000Z'), makeIntent(), DEMO);
    expect(plan.cadence).toBe('restock_window_priority');
    expect(plan.intervalMs).toBe(2000);
    expect(plan.nextCheckAt).toBe('2026-09-25T05:27:02.000Z');
    expect(plan.labels.join(' | ')).toMatch(/user-observed restock window 13:00-14:00 Asia\/Singapore/i);
  });

  it('A04: at 15:00 SGT the baseline 30s cadence still watches outside the window', () => {
    const plan = planNextCheck(new Date('2026-09-25T07:00:00.000Z'), makeIntent(), DEMO);
    expect(plan.cadence).toBe('baseline');
    expect(plan.intervalMs).toBe(30_000);
    expect(plan.nextCheckAt).toBe('2026-09-25T07:00:30.000Z');
    expect(plan.labels.join(' | ')).toMatch(/Baseline watch \(outside expected windows\)/);
  });

  it('A01: at 09:55 SGT with a 10:00 launch the launch-priority cadence applies', () => {
    const intent = makeIntent({ launchAt: '2026-09-25T02:00:00.000Z', launchBasis: 'source_confirmed', launchEvidenceId: 'ev_ann_001' });
    const plan = planNextCheck(new Date('2026-09-25T01:55:00.000Z'), intent, DEMO);
    expect(plan.cadence).toBe('launch_priority');
    expect(plan.intervalMs).toBe(2000);
    expect(plan.labels.join(' | ')).toMatch(/Source-confirmed launch window/);
  });

  it('A03: a baseline check just before 13:00 is advanced to the window start instead of overshooting it', () => {
    const plan = planNextCheck(new Date('2026-09-25T04:59:50.000Z'), makeIntent(), DEMO);
    expect(plan.cadence).toBe('baseline');
    expect(plan.nextCheckAt).toBe('2026-09-25T05:00:00.000Z'); // window start, not 05:00:20Z
    expect(plan.labels.join(' | ')).toMatch(/Advanced to restock window start/);
  });

  it('A16: live mode with liveObserveEnabled false is disabled with the feasibility-gate label', () => {
    const intent = makeIntent({ mode: 'lazada_assist', authority: 'observe' });
    const plan = planNextCheck(new Date('2026-09-25T05:27:00.000Z'), intent, LIVE_DISABLED);
    expect(plan.cadence).toBe('disabled');
    expect(plan.intervalMs).toBeNull();
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.labels.join(' | ')).toMatch(/feasibility gate/i);
  });

  it('A22: an expired intent schedules nothing', () => {
    const intent = makeIntent({ expiresAt: '2026-09-25T05:00:00.000Z' });
    const plan = planNextCheck(new Date('2026-09-25T05:27:00.000Z'), intent, DEMO);
    expect(plan.cadence).toBe('expired');
    expect(plan.intervalMs).toBeNull();
    expect(plan.nextCheckAt).toBeNull();
    expect(plan.labels.join(' | ')).toMatch(/expired/i);
  });

  it('A16: Retry-After 120s raises the interval above the priority cadence', () => {
    const plan = planNextCheck(new Date('2026-09-25T05:27:00.000Z'), makeIntent(), DEMO, { retryAfterSeconds: 120 });
    expect(plan.intervalMs).toBeGreaterThanOrEqual(120_000);
    expect(plan.intervalMs).toBe(120_000);
    expect(plan.nextCheckAt).toBe('2026-09-25T05:29:00.000Z');
    expect(plan.labels.join(' | ')).toMatch(/Honouring Retry-After 120s/);
  });

  it('A16: the next check never falls past the mission expiry', () => {
    const intent = makeIntent({ expiresAt: '2026-09-25T05:27:10.000Z' });
    const plan = planNextCheck(new Date('2026-09-25T05:27:00.000Z'), intent, DEMO, { retryAfterSeconds: 120 });
    expect(plan.nextCheckAt).toBe('2026-09-25T05:27:10.000Z');
  });
});

describe('backoff, downtime recovery, and per-origin limits', () => {
  it.each([
    { failures: 0, ms: 0 },
    { failures: 1, ms: 5_000 },
    { failures: 2, ms: 10_000 },
    { failures: 3, ms: 20_000 },
    { failures: 7, ms: 300_000 },
    { failures: 20, ms: 300_000 },
  ])('A16: transientBackoffMs($failures) is $ms', ({ failures, ms }) => {
    expect(transientBackoffMs(failures)).toBe(ms);
  });

  it('A23: after three hours of downtime exactly one observation runs and the missed ticks are discarded', () => {
    const storedNextCheckAt = '2026-09-25T05:00:00.000Z';
    const now = new Date('2026-09-25T08:00:00.000Z');
    const result = recoverAfterDowntime(now, storedNextCheckAt);

    expect(result).toEqual({ runNow: true, missedTicksDiscarded: true });
    // The result is a single decision, not a replayable list of missed instants.
    expect(Object.keys(result).sort()).toEqual(['missedTicksDiscarded', 'runNow']);
    expect(Object.values(result).some((v) => Array.isArray(v))).toBe(false);
    // A 30s baseline over three hours would otherwise be 360 catch-up ticks.
    expect((now.getTime() - Date.parse(storedNextCheckAt)) / 30_000).toBe(360);
    expect(result.runNow ? 1 : 0).toBe(1);
  });

  it.each([
    { stored: '2026-09-25T07:59:30.000Z', runNow: true, missedTicksDiscarded: false, why: 'due within the last minute' },
    { stored: '2026-09-25T08:30:00.000Z', runNow: false, missedTicksDiscarded: false, why: 'still in the future' },
    { stored: null, runNow: false, missedTicksDiscarded: false, why: 'nothing scheduled' },
  ])('A23: recoverAfterDowntime with a stored check $why', ({ stored, runNow, missedTicksDiscarded }) => {
    expect(recoverAfterDowntime(new Date('2026-09-25T08:00:00.000Z'), stored)).toEqual({ runNow, missedTicksDiscarded });
  });

  it('A16: OriginRateLimiter blocks the call after the per-minute allowance and releases it a minute later', () => {
    const limiter = new OriginRateLimiter(3);
    const t0 = 1_000;
    expect([limiter.tryAcquire('lazada.sg', t0), limiter.tryAcquire('lazada.sg', t0 + 10), limiter.tryAcquire('lazada.sg', t0 + 20)]).toEqual([true, true, true]);
    expect(limiter.tryAcquire('lazada.sg', t0 + 30)).toBe(false);
    expect(limiter.tryAcquire('lazada.sg', t0 + 60_001)).toBe(true);
  });

  it('A16: the per-origin bucket is shared by the announcement and product adapters', () => {
    const limiter = new OriginRateLimiter(2);
    const announcementAdapter = (ms: number) => limiter.tryAcquire('lazada.sg', ms);
    const productAdapter = (ms: number) => limiter.tryAcquire('lazada.sg', ms);
    expect(announcementAdapter(0)).toBe(true);
    expect(productAdapter(100)).toBe(true);
    expect(productAdapter(200)).toBe(false); // the announcement check consumed part of the shared allowance
    expect(announcementAdapter(300)).toBe(false);
    expect(limiter.tryAcquire('other-origin.example', 300)).toBe(true); // a different origin keeps its own bucket
  });

  it('A16: a null allowance means no limiter (owned demo store only)', () => {
    const limiter = new OriginRateLimiter(null);
    expect([1, 2, 3, 4, 5].every((n) => limiter.tryAcquire('127.0.0.1:4310', n))).toBe(true);
  });

  describe('OriginRateLimiter.nextAllowedAt', () => {
    it('a null policy is always allowed now', () => {
      const limiter = new OriginRateLimiter(null);
      expect(limiter.nextAllowedAt('lazada.sg', 999_999)).toBe(999_999);
    });

    it('an empty window (no calls yet) is allowed now', () => {
      const limiter = new OriginRateLimiter(1);
      expect(limiter.nextAllowedAt('lazada.sg', 5_000)).toBe(5_000);
    });

    it('a full window is allowed once the oldest stamp falls out of it, 60s later', () => {
      const limiter = new OriginRateLimiter(1);
      const t0 = 10_000;
      expect(limiter.tryAcquire('lazada.sg', t0)).toBe(true);
      expect(limiter.nextAllowedAt('lazada.sg', t0 + 5_000)).toBe(t0 + 60_000);
      // A read-only query: it does not itself consume the allowance.
      expect(limiter.tryAcquire('lazada.sg', t0 + 5_000)).toBe(false);
    });

    it('is allowed again once the window has room, even without an intervening tryAcquire', () => {
      const limiter = new OriginRateLimiter(2);
      const t0 = 0;
      expect(limiter.tryAcquire('lazada.sg', t0)).toBe(true);
      expect(limiter.tryAcquire('lazada.sg', t0 + 1_000)).toBe(true);
      expect(limiter.nextAllowedAt('lazada.sg', t0 + 2_000)).toBe(t0 + 60_000); // oldest of the two stamps
      expect(limiter.nextAllowedAt('lazada.sg', t0 + 60_001)).toBe(t0 + 60_001); // that stamp has aged out
    });
  });
});
