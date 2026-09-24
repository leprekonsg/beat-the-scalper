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
 * Reaction to an *unannounced* restock under fixed-interval polling. A restock lands uniformly at
 * random within the interval, so the wait until the next read is U(0, cadence): mean cadence/2, p95
 * 0.95 x cadence. `pipelineMs*` is everything after the read is due (scheduler slack, observe, and
 * whatever runs before the alert). The two figures pair like with like: mean wait + p50 pipeline, and
 * p95 wait + p95 pipeline. (The earlier "floor", cadence/2 + p95s, mixed a mean with p95s and was
 * reported as a 95% bound it was not: at 120 s it said ~71 s where the p95 is ~128 s.)
 */
export interface ReactionEstimate {
  meanMs: number;
  p95Ms: number;
}

export function reactionEstimate(input: { cadenceSeconds: number; pipelineMsP50: number | null; pipelineMsP95: number | null }): ReactionEstimate {
  const cadenceMs = input.cadenceSeconds * 1000;
  return { meanMs: cadenceMs / 2 + (input.pipelineMsP50 ?? 0), p95Ms: 0.95 * cadenceMs + (input.pipelineMsP95 ?? 0) };
}

/**
 * Share of restocks that alert the user with at least `humanActionSeconds` left before sell-out:
 * P(wait + pipeline + human <= sellout) with wait ~ U(0, cadence), i.e. (sellout - pipeline - human) /
 * cadence clamped to [0, 1]. With a sub-minute sell-out this, not the mean reaction, is the number that
 * says whether polling alone can work. Pass a p95 pipeline for a conservative figure.
 */
export function catchProbability(input: { cadenceSeconds: number; selloutSeconds: number; pipelineMs: number; humanActionSeconds: number }): number {
  const marginMs = input.selloutSeconds * 1000 - input.pipelineMs - input.humanActionSeconds * 1000;
  if (marginMs <= 0) return 0;
  const cadenceMs = input.cadenceSeconds * 1000;
  if (cadenceMs <= 0) return 1;
  return Math.min(1, marginMs / cadenceMs);
}

/** Pipeline time from the planned read instant to the alert, per read: slack + observe + validation-to-alert. */
export function alertPipelineMs(r: { schedulerSlackMs: number | null; observeMs: number | null; alertAfterObserveMs: number | null }): number | null {
  if (r.schedulerSlackMs === null || r.observeMs === null) return null;
  return Math.max(0, r.schedulerSlackMs) + r.observeMs + (r.alertAfterObserveMs ?? 0);
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
