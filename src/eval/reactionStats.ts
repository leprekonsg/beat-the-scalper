/**
 * Pure statistics helpers for the live reaction-speed measurement script
 * (scripts/lazada-live-reaction.ts). Kept separate and pure so they are unit-testable without
 * Playwright, a live Worker run, or any network access.
 */

/**
 * Nearest-rank percentile over `values` (not interpolated). `p` is 0-100. Returns null for an
 * empty input rather than NaN, so callers never need a separate emptiness check.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx]!;
}

export function p50(values: number[]): number | null {
  return percentile(values, 50);
}

export function p95(values: number[]): number | null {
  return percentile(values, 95);
}

export function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

export interface TimingStats {
  p50: number | null;
  p95: number | null;
  max: number | null;
  n: number;
}

export function summarizeTimings(values: number[]): TimingStats {
  return { p50: p50(values), p95: p95(values), max: max(values), n: values.length };
}

/**
 * reactionFloorMs: the best-case detection-to-decision time for an *unannounced* restock under a
 * fixed polling cadence. `cadenceSeconds/2` is the mean wait for the poller to notice a change
 * that can occur at any point in the interval (a restock landing right after a check is missed by
 * nearly the whole cadence; one landing right before is caught almost immediately -- the average
 * of a uniform draw over the interval is half of it). The p95 timings are added, not the p50 or
 * mean ones, because this number is reported as a bound the system meets at least 95% of the time,
 * not a lucky-case figure.
 */
export function reactionFloorMs(input: { cadenceSeconds: number; observeMsP95: number | null; interpretationMsP95: number | null; validationMsP95: number | null }): number {
  return (input.cadenceSeconds * 1000) / 2 + (input.observeMsP95 ?? 0) + (input.interpretationMsP95 ?? 0) + (input.validationMsP95 ?? 0);
}

/** The `to` state and `at` instant of one `mission.transition` event, as read off the store's event log. */
export interface MissionTransitionSample {
  at: string;
  to: string;
}

/**
 * The mission state in effect at `atIso`: the `to` of the latest `transitions` entry whose `at` is
 * `<= atIso`, or `initialState` when none qualifies (e.g. `atIso` is before the mission's first
 * transition, or `transitions` is empty). `transitions` need not be sorted; every entry is checked.
 *
 * Used to fix a bug in scripts/lazada-live-reaction.ts where `stateAfter` was computed only from
 * transitions strictly *after* an observation completed, so a mission that transitioned once (e.g.
 * DRAFT -> WATCHING) before its first observation -- the common case -- showed `stateAfter: null` for
 * every read even though the mission was WATCHING throughout.
 */
export function missionStateAtOrBefore(transitions: MissionTransitionSample[], atIso: string, initialState: string): string {
  const at = Date.parse(atIso);
  let state = initialState;
  let bestAt = -Infinity;
  for (const t of transitions) {
    const tAt = Date.parse(t.at);
    if (tAt <= at && tAt >= bestAt) {
      state = t.to;
      bestAt = tAt;
    }
  }
  return state;
}
