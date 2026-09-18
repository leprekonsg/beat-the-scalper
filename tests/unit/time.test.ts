import { describe, expect, it } from 'vitest';
import { currentOrNextWindow, isWithinWindow, localToUtcIso, utcToLocal, VirtualClock, type WindowSpec } from '../../src/domain/time.ts';

const SG_WINDOW: WindowSpec = { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00' };

describe('time (UTC instants, Asia/Singapore local windows, injected clock)', () => {
  it('A01: a local 2026-09-25 10:00 Singapore launch is the UTC instant 02:00Z', () => {
    expect(localToUtcIso('2026-09-25', '10:00')).toBe('2026-09-25T02:00:00.000Z');
  });

  it.each([
    { instant: '2026-09-25T02:00:00.000Z', date: '2026-09-25', time: '10:00' },
    { instant: '2026-09-25T05:27:00.000Z', date: '2026-09-25', time: '13:27' },
    { instant: '2026-09-25T16:30:00.000Z', date: '2026-09-26', time: '00:30' },
  ])('A01: utcToLocal inverts localToUtcIso for $instant', ({ instant, date, time }) => {
    expect(utcToLocal(instant)).toEqual({ date, time });
    expect(localToUtcIso(date, time)).toBe(instant);
  });

  it('A03: currentOrNextWindow at 12:30 SGT yields the same-day 13:00-14:00 window', () => {
    const w = currentOrNextWindow(new Date('2026-09-25T04:30:00.000Z'), SG_WINDOW);
    expect(w).toEqual({ startAt: '2026-09-25T05:00:00.000Z', endAt: '2026-09-25T06:00:00.000Z' });
    expect(utcToLocal(w.startAt)).toEqual({ date: '2026-09-25', time: '13:00' });
  });

  it('A04: currentOrNextWindow at 14:30 SGT (window already closed) yields the next day', () => {
    const w = currentOrNextWindow(new Date('2026-09-25T06:30:00.000Z'), SG_WINDOW);
    expect(w).toEqual({ startAt: '2026-09-26T05:00:00.000Z', endAt: '2026-09-26T06:00:00.000Z' });
    expect(utcToLocal(w.startAt).date).toBe('2026-09-26');
  });

  it.each([
    { instant: '2026-09-25T05:27:00.000Z', local: '13:27', within: true },
    { instant: '2026-09-25T04:59:00.000Z', local: '12:59', within: false },
    { instant: '2026-09-25T06:00:00.000Z', local: '14:00', within: false },
  ])('A04: isWithinWindow is $within at $local SGT', ({ instant, within }) => {
    expect(isWithinWindow(new Date(instant), SG_WINDOW)).toBe(within);
  });

  it('A23: VirtualClock advances wall-clock and monotonic time together and refuses to move backwards', () => {
    const clock = new VirtualClock('2026-09-25T02:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-09-25T02:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);

    clock.advanceMs(90_000);
    expect(clock.now().toISOString()).toBe('2026-09-25T02:01:30.000Z');
    expect(clock.monotonicMs()).toBe(90_000);

    clock.set('2026-09-25T05:27:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-09-25T05:27:00.000Z');
    expect(clock.monotonicMs()).toBe(90_000 + (5 * 3600 + 27 * 60 - (2 * 3600 + 90)) * 1000);

    const monoBefore = clock.monotonicMs();
    expect(() => clock.advanceMs(-1)).toThrow(/cannot move backwards/);
    expect(() => clock.set('2026-09-25T02:00:00.000Z')).toThrow(/cannot move backwards/);
    expect(clock.now().toISOString()).toBe('2026-09-25T05:27:00.000Z');
    expect(clock.monotonicMs()).toBe(monoBefore);
  });
});
