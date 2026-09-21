/**
 * Scheduling: launch instants, restock window cadence, baseline cadence, downtime recovery, backoff.
 * The scheduler decides priority; the model never does.
 */
import type { MonitorPolicy, PurchaseIntent, LaunchBasis } from './types.ts';
import { currentOrNextWindow, isWithinWindow, localToUtcIso, minutes, seconds, SG_TZ } from './time.ts';

export const PREFLIGHT_LEAD_MS = minutes(10);
/** Launch-priority band: from preflight until this long after the launch instant. */
export const LAUNCH_PRIORITY_AFTER_MS = minutes(15);

export type CadenceLabel = 'launch_priority' | 'restock_window_priority' | 'baseline' | 'disabled' | 'expired';

export interface SchedulePlan {
  cadence: CadenceLabel;
  intervalMs: number | null;
  nextCheckAt: string | null;
  /** Human labels for the dashboard. */
  labels: string[];
}

export interface LaunchPlan {
  launchAt: string | null;
  launchBasis: LaunchBasis;
  preflightAt: string | null;
  message: string;
}

/**
 * A01/A02: a source-dated local 10:00 launch becomes an exact UTC instant with a preflight reminder.
 * A user expectation with no date stays `user_expected` and schedules nothing.
 */
export function planLaunch(input: { dateLocal: string | null; timeLocal: string | null; basis: LaunchBasis; timezone?: string }): LaunchPlan {
  const tz = input.timezone ?? SG_TZ;
  if (input.basis === 'source_confirmed' && input.dateLocal && input.timeLocal) {
    const launchAt = localToUtcIso(input.dateLocal, input.timeLocal, tz);
    const preflightAt = new Date(Date.parse(launchAt) - PREFLIGHT_LEAD_MS).toISOString();
    return { launchAt, launchBasis: 'source_confirmed', preflightAt, message: `Source-confirmed launch ${input.dateLocal} ${input.timeLocal} ${tz}` };
  }
  if (input.basis === 'user_expected' || (input.timeLocal && !input.dateLocal)) {
    return {
      launchAt: null,
      launchBasis: 'user_expected',
      preflightAt: null,
      message: input.timeLocal ? `Expected by user around ${input.timeLocal} ${tz}; release date needed before scheduling` : 'Expected by user; release date and time needed',
    };
  }
  return { launchAt: null, launchBasis: 'unknown', preflightAt: null, message: 'No launch information' };
}

function inLaunchBand(now: Date, launchAt: string | null): boolean {
  if (!launchAt) return false;
  const t = now.getTime();
  const l = Date.parse(launchAt);
  return t >= l - PREFLIGHT_LEAD_MS && t <= l + LAUNCH_PRIORITY_AFTER_MS;
}

/** Compute the next observation instant from `now`. `lastObservationAt` prevents scheduling in the past. */
export function planNextCheck(now: Date, intent: PurchaseIntent, policy: MonitorPolicy, opts: { backoffMs?: number; retryAfterSeconds?: number | null } = {}): SchedulePlan {
  const labels: string[] = [];
  if (now.getTime() >= Date.parse(intent.expiresAt)) return { cadence: 'expired', intervalMs: null, nextCheckAt: null, labels: ['Mission expired'] };

  const liveDisabled = policy.mode === 'lazada_assist' && !policy.liveObserveEnabled;
  if (liveDisabled || policy.baselineIntervalSeconds === null) {
    return { cadence: 'disabled', intervalMs: null, nextCheckAt: null, labels: ['Live observation disabled until feasibility gate passes'] };
  }

  let cadence: CadenceLabel = 'baseline';
  let intervalMs = seconds(policy.baselineIntervalSeconds);
  labels.push(policy.label === 'demo_defaults' ? 'Demo cadence' : 'Reviewed live cadence');

  if (inLaunchBand(now, intent.launchAt) && policy.priorityIntervalSeconds !== null) {
    cadence = 'launch_priority';
    intervalMs = seconds(policy.priorityIntervalSeconds);
    labels.push(intent.launchBasis === 'source_confirmed' ? 'Source-confirmed launch window' : 'Launch window');
  } else if (intent.restockWindow.enabled && policy.priorityIntervalSeconds !== null && isWithinWindow(now, intent.restockWindow)) {
    cadence = 'restock_window_priority';
    intervalMs = seconds(policy.priorityIntervalSeconds);
    labels.push('User-observed restock window 13:00-14:00 Asia/Singapore');
  } else {
    labels.push('Baseline watch (outside expected windows)');
  }

  // Server-directed delay wins; then bounded backoff for transient errors.
  if (opts.retryAfterSeconds && opts.retryAfterSeconds > 0) {
    intervalMs = Math.max(intervalMs, seconds(opts.retryAfterSeconds));
    labels.push(`Honouring Retry-After ${opts.retryAfterSeconds}s`);
  } else if (opts.backoffMs && opts.backoffMs > 0) {
    intervalMs = Math.max(intervalMs, opts.backoffMs);
    labels.push(`Backoff ${Math.round(opts.backoffMs / 1000)}s`);
  }

  // Do not schedule beyond a window boundary when a priority window is about to start; cap the wait so the
  // baseline cadence can pick up the window promptly.
  let nextCheckAt = new Date(now.getTime() + intervalMs).toISOString();
  if (cadence === 'baseline' && intent.restockWindow.enabled) {
    const w = currentOrNextWindow(now, intent.restockWindow);
    if (Date.parse(w.startAt) > now.getTime() && Date.parse(w.startAt) < Date.parse(nextCheckAt)) {
      nextCheckAt = w.startAt;
      labels.push('Advanced to restock window start');
    }
  }
  if (cadence === 'baseline' && intent.launchAt) {
    const pre = Date.parse(intent.launchAt) - PREFLIGHT_LEAD_MS;
    if (pre > now.getTime() && pre < Date.parse(nextCheckAt)) {
      nextCheckAt = new Date(pre).toISOString();
      labels.push('Advanced to launch preflight');
    }
  }
  if (Date.parse(nextCheckAt) > Date.parse(intent.expiresAt)) {
    nextCheckAt = intent.expiresAt;
  }
  return { cadence, intervalMs, nextCheckAt, labels };
}

/**
 * A23: after downtime, take at most one newly eligible observation. Missed ticks are not replayed.
 * Returns the single instant to run now (if due) or the stored instant when it is still in the future.
 */
export function recoverAfterDowntime(now: Date, storedNextCheckAt: string | null): { runNow: boolean; missedTicksDiscarded: boolean } {
  if (!storedNextCheckAt) return { runNow: false, missedTicksDiscarded: false };
  const due = Date.parse(storedNextCheckAt) <= now.getTime();
  const missedTicksDiscarded = due && now.getTime() - Date.parse(storedNextCheckAt) > minutes(1);
  return { runNow: due, missedTicksDiscarded };
}

/** Bounded exponential backoff for transient errors: 5s, 10s, 20s, ... capped at 5 minutes. */
export function transientBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(minutes(5), seconds(5) * 2 ** (consecutiveFailures - 1));
}

/** Per-origin observation limiter shared across announcement and product checks. */
export class OriginRateLimiter {
  private readonly stamps = new Map<string, number[]>();
  constructor(private readonly perMinute: number | null) {}
  /** Returns true and records the call if allowed. */
  tryAcquire(origin: string, nowMs: number): boolean {
    if (this.perMinute === null) return true;
    const list = (this.stamps.get(origin) ?? []).filter((t) => nowMs - t < 60_000);
    if (list.length >= this.perMinute) {
      this.stamps.set(origin, list);
      return false;
    }
    list.push(nowMs);
    this.stamps.set(origin, list);
    return true;
  }

  /**
   * When a call for `origin` would next be allowed, without recording one. `nowMs` when a call would
   * be allowed right now (no policy, or the window has room); otherwise the instant the oldest stamp
   * in the current 60s window falls out of it (`oldestStampInWindow + 60_000`).
   */
  nextAllowedAt(origin: string, nowMs: number): number {
    if (this.perMinute === null) return nowMs;
    const list = (this.stamps.get(origin) ?? []).filter((t) => nowMs - t < 60_000);
    if (list.length < this.perMinute) return nowMs;
    return Math.min(...list) + 60_000;
  }
}
