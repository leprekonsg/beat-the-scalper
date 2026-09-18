/**
 * Clock injection and Asia/Singapore local-window arithmetic.
 * Instants are ISO-8601 UTC strings. Elapsed time uses monotonic milliseconds.
 */

export const SG_TZ = 'Asia/Singapore' as const;

export interface Clock {
  /** Wall-clock instant. */
  now(): Date;
  /** Monotonic milliseconds for elapsed-time measurement. */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  monotonicMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}

/** Deterministic, manually advanced clock for tests and the labelled demo acceleration. */
export class VirtualClock implements Clock {
  private current: number;
  private mono = 0;
  constructor(start: string | Date) {
    this.current = typeof start === 'string' ? Date.parse(start) : start.getTime();
    if (Number.isNaN(this.current)) throw new Error(`VirtualClock start is not a valid instant: ${String(start)}`);
  }
  now(): Date {
    return new Date(this.current);
  }
  monotonicMs(): number {
    return this.mono;
  }
  advanceMs(ms: number): void {
    if (ms < 0) throw new Error('VirtualClock cannot move backwards');
    this.current += ms;
    this.mono += ms;
  }
  set(iso: string): void {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`Invalid instant: ${iso}`);
    if (t < this.current) throw new Error('VirtualClock cannot move backwards');
    this.mono += t - this.current;
    this.current = t;
  }
}

export function toIso(d: Date): string {
  return d.toISOString();
}

/** Offset (minutes east of UTC) of `tz` at the given instant, via Intl. Singapore is +480 with no DST. */
export function tzOffsetMinutes(instant: Date, tz: string = SG_TZ): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Convert a local calendar date+time in `tz` to a UTC ISO instant. */
export function localToUtcIso(dateLocal: string, timeLocal: string, tz: string = SG_TZ): string {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeLocal);
  if (!dm) throw new Error(`Local date must be YYYY-MM-DD, got "${dateLocal}"`);
  if (!tm) throw new Error(`Local time must be HH:mm, got "${timeLocal}"`);
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] ?? '0'));
  // Two-pass correction handles zones with DST; Singapore has a fixed offset.
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let utc = guess - offset * 60_000;
  offset = tzOffsetMinutes(new Date(utc), tz);
  utc = guess - offset * 60_000;
  return new Date(utc).toISOString();
}

export interface LocalDateTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
}

export function utcToLocal(instantIso: string, tz: string = SG_TZ): LocalDateTime {
  const d = new Date(instantIso);
  const offset = tzOffsetMinutes(d, tz);
  const shifted = new Date(d.getTime() + offset * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const time = shifted.toISOString().slice(11, 16);
  return { date, time };
}

export interface WindowSpec {
  timezone: string;
  startLocal: string; // HH:mm
  endLocal: string; // HH:mm
}

export interface WindowInstance {
  startAt: string;
  endAt: string;
}

/** The window instance containing `now`, or the next one starting after `now`. */
export function currentOrNextWindow(now: Date, spec: WindowSpec): WindowInstance {
  const { date } = utcToLocal(now.toISOString(), spec.timezone);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const day = addDays(date, dayOffset);
    const startAt = localToUtcIso(day, spec.startLocal, spec.timezone);
    const endAt = localToUtcIso(day, spec.endLocal, spec.timezone);
    if (Date.parse(endAt) > now.getTime()) return { startAt, endAt };
  }
  throw new Error('unreachable: window search exceeded two days');
}

export function isWithinWindow(now: Date, spec: WindowSpec): boolean {
  const w = currentOrNextWindow(now, spec);
  const t = now.getTime();
  return t >= Date.parse(w.startAt) && t < Date.parse(w.endAt);
}

export function addDays(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d! + days);
  return new Date(t).toISOString().slice(0, 10);
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function minutes(n: number): number {
  return n * 60_000;
}
export function seconds(n: number): number {
  return n * 1000;
}
