/**
 * The BTS worker: one long-lived scheduler/executor loop. SQLite (via Store) owns mission state;
 * this class only reads/writes through Store methods and never keeps authoritative state in memory
 * beyond transient bookkeeping (current action label, last schedule plan, rate limiter, degraded flag).
 *
 * Every step re-reads the mission before acting and treats a StaleGenerationError (thrown by
 * Store.updateAttempt when the generation/state moved under us) as an expected stop signal for the
 * current tick, not a fatal error.
 */
import { createHash } from 'node:crypto';
import type { Attempt, Event, Evidence, MissionState, MonitorHealth, MonitorPolicy, Observation, OfferAssessment, Provenance, PurchaseIntent } from '../domain/types.ts';
import { intentIsResolved } from '../domain/types.ts';
import { LOCKED_STATES, OBSERVING_STATES, TERMINAL_STATES, stopRequestOutcome } from '../domain/state.ts';
import type { AssessmentBinding, CartLine, EligibilityResult } from '../domain/policy.ts';
import { assessmentIsCurrent, evaluateEligibility, planCart } from '../domain/policy.ts';
import { OriginRateLimiter, planNextCheck, recoverAfterDowntime, transientBackoffMs } from '../domain/scheduling.ts';
import { packagingCacheApplies, packagingCacheNeedsRefresh, restockAlertDecision } from '../domain/restockAlert.ts';
import type { PackagingCacheEntry, RestockAlertDecision } from '../domain/restockAlert.ts';
import type { CadenceLabel, SchedulePlan } from '../domain/scheduling.ts';
import { VirtualClock } from '../domain/time.ts';
import type { Clock } from '../domain/time.ts';
import { Store, StaleGenerationError } from '../storage/db.ts';
import type { MissionRow } from '../storage/db.ts';
import { isDemoSubmissionExecutor } from '../adapters/types.ts';
import type { CartState, ObservationAdapter, PreparationExecutor } from '../adapters/types.ts';
import type { HealthSnapshot, LatencyMarks, MissionView, WorkerApi } from './types.ts';
import type { RestockNotification, RestockNotifier } from './notifier.ts';

/**
 * Implemented by the agent layer. The worker calls this only when packaging is unreadable, the page
 * layout is unsupported, or the deterministic packaging check itself resolved to 'unknown'. The
 * worker always re-runs `evaluateEligibility` on whatever condition the interpreter reports; the
 * interpreter cannot assert eligibility directly, so it can only resolve an unknown into a concrete
 * fact, never override an already-established mismatch (mismatches are 'ineligible', not 'unknown',
 * so they are never routed here).
 */
export interface OfferInterpreter {
  assess(input: { intent: PurchaseIntent; observation: Observation; evidence: Evidence | null }): Promise<
    | { ok: true; assessment: OfferAssessment; provenance: Provenance }
    | { ok: false; reason: string; provenance: Provenance }
  >;
}

export interface WorkerDeps {
  store: Store;
  clock: Clock;
  policy: MonitorPolicy;
  adapter: ObservationAdapter;
  executor: PreparationExecutor | null;
  interpreter?: OfferInterpreter | null;
  apiReadiness: 'live' | 'offline_replay' | 'blocked';
  browserReadiness?: () => 'ready' | 'not_started' | 'failed';
  log?: (line: string) => void;
  maxEvidenceAgeMs?: number;
  staleObservationMs?: number;
  leaseMs?: number;
  /** Receives the restock alert (and any retraction). Called without awaiting; see notifier.ts. */
  notifier?: RestockNotifier | null;
  /** How long an interpreted packaging condition may resolve an unreadable notice. Default 30 min. */
  packagingCacheMaxAgeMs?: number;
  /**
   * While a restock is in progress (last clean read AVAILABLE) on an observe mission, read again
   * after this long instead of the full cadence, so the episode's end -- the sell-out -- is timed to
   * this resolution (`restock.ended`). Still subject to the origin limiter. Null (default) keeps the
   * cadence.
   */
  followUpWhileAvailableMs?: number | null;
}

/** A run of AVAILABLE reads, stored per mission until a clean non-AVAILABLE read ends it. */
interface RestockEpisode {
  /** The last clean read before the episode (the restock began after it); null when there was none. */
  startedAfter: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  availableReads: number;
}

/** States recovered via reconciliation rather than fresh observation (A19-A21). */
const RECOVERABLE_STATES = new Set<MissionState>(['SUBMISSION_STARTED', 'HANDOFF_LOCKED', 'UNKNOWN', 'ORDER_OBSERVED']);

function orderPayload(order: { orderRef: string; status: string; quantity: number; totalMinor: number } | null): Record<string, unknown> {
  return { order };
}

export class Worker implements WorkerApi {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly policy: MonitorPolicy;
  private readonly adapter: ObservationAdapter;
  private readonly executor: PreparationExecutor | null;
  private readonly interpreter: OfferInterpreter | null;
  private readonly apiReadiness: 'live' | 'offline_replay' | 'blocked';
  private readonly browserReadinessFn: (() => 'ready' | 'not_started' | 'failed') | null;
  private readonly log: (line: string) => void;
  private readonly maxEvidenceAgeMs: number;
  private readonly staleObservationMs: number;
  private readonly leaseMs: number;
  private readonly rateLimiter: OriginRateLimiter;
  private readonly notifier: RestockNotifier | null;
  private readonly packagingCacheMaxAgeMs: number;
  private readonly followUpWhileAvailableMs: number | null;
  /** Notification deliveries and packaging refreshes still running; stop() waits for them. */
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly packagingRefreshInFlight = new Set<string>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private currentAction: string | null = null;
  private lastPlan: SchedulePlan | null = null;
  private forcedDegraded = false;
  private missedChecks = 0;

  constructor(deps: WorkerDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.adapter = deps.adapter;
    this.executor = deps.executor;
    this.interpreter = deps.interpreter ?? null;
    this.apiReadiness = deps.apiReadiness;
    this.browserReadinessFn = deps.browserReadiness ?? null;
    this.log = deps.log ?? (() => {});
    this.maxEvidenceAgeMs = deps.maxEvidenceAgeMs ?? 20000;
    this.staleObservationMs = deps.staleObservationMs ?? 60000;
    this.leaseMs = deps.leaseMs ?? 15000;
    this.rateLimiter = new OriginRateLimiter(this.policy.maxObservationsPerOriginPerMinute);
    this.notifier = deps.notifier ?? null;
    this.packagingCacheMaxAgeMs = deps.packagingCacheMaxAgeMs ?? 30 * 60_000;
    this.followUpWhileAvailableMs = deps.followUpWhileAvailableMs ?? null;
  }

  // ---------------------------------------------------------------------
  // Provenance helper: worker-internal bookkeeping not tied to a specific
  // observation/interpreter result is labelled by mode and API readiness.
  // ---------------------------------------------------------------------
  private provFor(mission: MissionRow): Provenance {
    if (mission.intent.mode === 'demo') return 'demo';
    if (this.apiReadiness === 'blocked') return 'blocked';
    if (this.apiReadiness === 'offline_replay') return 'offline_replay';
    return 'live_verified';
  }

  // ---------------------------------------------------------------------
  // tick()
  // ---------------------------------------------------------------------
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } catch (err) {
      if (err instanceof StaleGenerationError) {
        this.log(`tick: stopped (stale generation/state): ${err.message}`);
      } else {
        this.log(`tick error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    } finally {
      this.currentAction = 'idle';
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = this.clock.now();
    this.heartbeat(now);

    let mission = this.store.activeMission();
    if (!mission) return;

    mission = this.applyExpiry(mission, now);
    if (TERMINAL_STATES.has(mission.state)) return;

    if (RECOVERABLE_STATES.has(mission.state)) {
      await this.reconcileLockedAttempt(mission, this.clock.now());
      return;
    }

    if (OBSERVING_STATES.has(mission.state)) {
      // Section 7: live defaults are null/disabled. With no permitted cadence the worker never touches the
      // origin at all (an unset nextCheckAt would otherwise read as "due" on every tick).
      const plan = planNextCheck(now, mission.intent, this.policy);
      if (plan.cadence === 'disabled') {
        this.lastPlan = plan;
        // There is no next eligible observation, so do not leave a stale instant on the mission.
        if (mission.nextCheckAt !== null) this.store.patchMission(mission.id, { nextCheckAt: null }, now.toISOString());
        return;
      }
    }

    if (OBSERVING_STATES.has(mission.state) && this.dueForCheck(mission, now)) {
      const becameCandidate = await this.observeAndTransition(mission, this.clock.now());
      if (becameCandidate) {
        const after = this.store.getMission(mission.id);
        if (after && after.state === 'CANDIDATE') await this.handleCandidate(after, this.clock.now());
      }
    }
  }

  private dueForCheck(mission: MissionRow, now: Date): boolean {
    return mission.nextCheckAt === null || Date.parse(mission.nextCheckAt) <= now.getTime();
  }

  // ---------------------------------------------------------------------
  // Step 1: heartbeat + downtime detection
  // ---------------------------------------------------------------------
  private heartbeat(now: Date): void {
    this.currentAction = 'heartbeat';
    const nowIso = now.toISOString();
    const prev = this.store.getSetting('worker.heartbeatAt');
    const storedInterval = this.store.getSetting('worker.intervalMs');
    this.missedChecks = 0;
    if (prev && storedInterval) {
      const intervalMs = Number(storedInterval);
      const gap = now.getTime() - Date.parse(prev);
      if (intervalMs > 0 && gap > intervalMs * 3) {
        this.forcedDegraded = true;
        this.missedChecks = Math.max(0, Math.floor(gap / intervalMs) - 1);
        const mission = this.store.activeMission();
        if (mission) {
          const recovery = recoverAfterDowntime(now, mission.nextCheckAt);
          this.store.appendEvent({
            missionId: mission.id,
            type: 'worker.resumed_after_downtime',
            at: nowIso,
            provenance: this.provFor(mission),
            payload: { missedTicksDiscarded: recovery.missedTicksDiscarded, gapMs: gap },
          });
        }
      }
    }
    this.store.setSetting('worker.heartbeatAt', nowIso);
  }

  // ---------------------------------------------------------------------
  // Step 3: expiry
  // ---------------------------------------------------------------------
  private applyExpiry(mission: MissionRow, now: Date): MissionRow {
    if (now.getTime() < Date.parse(mission.intent.expiresAt)) return mission;
    if (TERMINAL_STATES.has(mission.state)) return mission;
    const nowIso = now.toISOString();
    if (LOCKED_STATES.has(mission.state)) {
      if (mission.stopRequested !== 'EXPIRED') this.store.patchMission(mission.id, { stopRequested: 'EXPIRED' }, nowIso);
      return this.store.getMission(mission.id)!;
    }
    const target = stopRequestOutcome(mission.state, 'EXPIRED');
    if (target !== mission.state) return this.store.transition(mission.id, target, nowIso, {}, this.provFor(mission));
    return mission;
  }

  // ---------------------------------------------------------------------
  // Step 4: recovery of locked attempts
  // ---------------------------------------------------------------------
  private shouldReconcileNow(missionId: string, generation: number): boolean {
    const key = `mission.${missionId}.reconcileTicks.${generation}`;
    const n = Number(this.store.getSetting(key) ?? '0') + 1;
    this.store.setSetting(key, String(n));
    if (n <= 3) return true;
    return (n - 3) % 3 === 0;
  }

  private async reconcileLockedAttempt(mission: MissionRow, now: Date): Promise<void> {
    this.currentAction = 'reconciling';
    if (!this.executor) return;
    const attempt = this.store.listAttempts(mission.id)[0];
    if (!attempt || !attempt.checkoutSessionId) return;
    if (!this.shouldReconcileNow(mission.id, attempt.generation)) return;

    const res = await this.executor.findOrderForSession(attempt.checkoutSessionId);
    const fresh = this.store.getMission(mission.id);
    if (!fresh || fresh.generation !== mission.generation) return; // another actor already resolved this
    const nowIso = this.clock.now().toISOString();

    if (res.ok && res.value) {
      const order = res.value;
      this.store.updateAttempt(attempt.attemptId, attempt.generation, { state: 'ORDER_OBSERVED', merchantOrderRef: order.orderRef, reconciliationOutcome: order.status }, nowIso, 'order.observed', orderPayload(order));
      this.store.transition(mission.id, 'ORDER_OBSERVED', nowIso, orderPayload(order), this.provFor(fresh));
      this.store.transition(mission.id, 'COMPLETED', nowIso, orderPayload(order), this.provFor(fresh));
      this.store.releaseExecutionLock(mission.id, nowIso);
      this.store.appendEvent({ missionId: mission.id, attemptId: attempt.attemptId, type: 'mission.completed', at: nowIso, provenance: this.provFor(fresh), payload: orderPayload(order) });
      return;
    }

    if (mission.state === 'SUBMISSION_STARTED' || mission.state === 'UNKNOWN') {
      if (mission.state !== 'UNKNOWN') this.store.transition(mission.id, 'UNKNOWN', nowIso, {}, this.provFor(fresh));
      this.store.appendEvent({ missionId: mission.id, attemptId: attempt.attemptId, type: 'reconciliation.pending', at: nowIso, provenance: this.provFor(fresh), payload: { missionState: mission.state, attemptState: attempt.state } });
      return;
    }

    // HANDOFF_LOCKED (or ORDER_OBSERVED awaiting confirmation) with no order found: remain locked; only the user can resolve it.
    this.store.appendEvent({ missionId: mission.id, attemptId: attempt.attemptId, type: 'reconciliation.pending', at: nowIso, provenance: this.provFor(fresh), payload: { missionState: mission.state, attemptState: attempt.state } });
  }

  // ---------------------------------------------------------------------
  // Step 5: scheduling + observation
  // ---------------------------------------------------------------------
  private async observeAndTransition(mission: MissionRow, now: Date): Promise<boolean> {
    const claimIso = now.toISOString();
    if (!this.store.claimObservation(mission.id, claimIso, this.staleObservationMs)) return false;
    this.currentAction = 'observing';
    let becameCandidate = false;
    let obs: Observation | null = null;
    // Set only when the origin limiter denies this attempt (never a failure: no adapter call was made,
    // so consecutiveFailures and lastObservationId are left untouched below).
    let deferredRetryAtMs: number | null = null;
    try {
      if (this.rateLimiter.tryAcquire(this.adapter.origin, now.getTime())) {
        // plannedAt is the instant that made this read due (cadence, signal import, or resume), so scheduler
        // slack is computed from the event log alone: started.at - plannedAt.
        this.store.appendEvent({ missionId: mission.id, type: 'observation.started', at: this.clock.now().toISOString(), provenance: this.adapter.provenance, payload: { origin: this.adapter.origin, plannedAt: mission.nextCheckAt } });
        obs = await this.adapter.observeTarget({ missionId: mission.id, intent: mission.intent, now: this.clock.now().toISOString() });
        this.store.putObservation(obs);
        const endIso = this.clock.now().toISOString();
        this.store.appendEvent({ missionId: mission.id, type: 'observation.completed', at: endIso, provenance: obs.provenance, payload: { observationId: obs.observationId, availability: obs.availability, accessControl: obs.accessControl, error: obs.error } });

        const priorAvailability = mission.lastAvailability;
        this.store.patchMission(mission.id, { lastObservationId: obs.observationId }, endIso);
        if (obs.error === null && obs.accessControl === 'none') {
          this.store.patchMission(mission.id, { lastAvailability: obs.availability, lastSuccessfulObservationId: obs.observationId, consecutiveFailures: 0 }, endIso);
          this.forcedDegraded = false;
        } else {
          this.store.patchMission(mission.id, { consecutiveFailures: mission.consecutiveFailures + 1 }, endIso);
        }

        if (obs.accessControl === 'captcha' || obs.accessControl === 'queue' || obs.accessControl === 'login_expired') {
          const cur = this.store.getMission(mission.id)!;
          if (!LOCKED_STATES.has(cur.state) && !TERMINAL_STATES.has(cur.state) && cur.state !== 'PAUSED') {
            this.store.transition(mission.id, 'PAUSED', endIso, { pauseReason: obs.accessControl }, obs.provenance);
          }
          this.store.patchMission(mission.id, { pauseReason: obs.accessControl }, endIso);
          this.store.appendEvent({ missionId: mission.id, type: 'access_control.paused', at: endIso, provenance: obs.provenance, payload: { accessControl: obs.accessControl } });
        } else if (obs.accessControl === 'none') {
          if (obs.error === null) this.trackRestockEpisode(mission, obs);
          const cur = this.store.getMission(mission.id)!;
          if ((priorAvailability === 'UNAVAILABLE' || priorAvailability === 'UNKNOWN') && obs.availability === 'AVAILABLE' && cur.state === 'WATCHING') {
            this.store.transition(mission.id, 'CANDIDATE', endIso, { observationId: obs.observationId }, obs.provenance);
            becameCandidate = true;
          } else if (obs.availability === 'UNAVAILABLE' && cur.state === 'CANDIDATE') {
            this.store.transition(mission.id, 'WATCHING', endIso, { observationId: obs.observationId, reason: 'stock disappeared before validation' }, obs.provenance);
          }
          // While out of stock, interpret the listing artwork ahead of time so a restock never waits on a model.
          if (!becameCandidate && obs.error === null) this.maybeRefreshPackaging(mission.id, obs);
        }
        // rate_limited and unsupported_layout: no forced transition here; scheduling below honours retryAfterSeconds,
        // and unsupported_layout may be resolved by the interpreter during candidate validation.
      } else {
        // Denied by the origin limiter: no adapter call happened, so this is not an observation failure.
        // Record the deferral and let the re-plan below cap the wait at the limiter's own window instead
        // of the full cadence, so an imported signal never loses its priority to a busy origin bucket.
        deferredRetryAtMs = this.rateLimiter.nextAllowedAt(this.adapter.origin, now.getTime());
        this.store.appendEvent({
          missionId: mission.id,
          type: 'observation.deferred',
          at: this.clock.now().toISOString(),
          provenance: this.provFor(mission),
          payload: { reason: 'origin_rate_limit', origin: this.adapter.origin, retryAt: new Date(deferredRetryAtMs).toISOString() },
        });
      }
    } finally {
      this.store.releaseObservation(mission.id, this.clock.now().toISOString());
    }

    const finalMission = this.store.getMission(mission.id)!;
    if (!TERMINAL_STATES.has(finalMission.state)) {
      const plan = planNextCheck(this.clock.now(), finalMission.intent, this.policy, {
        backoffMs: transientBackoffMs(finalMission.consecutiveFailures),
        retryAfterSeconds: obs?.retryAfterSeconds ?? null,
      });
      this.lastPlan = plan;
      let nextCheckAt = plan.nextCheckAt;
      if (deferredRetryAtMs !== null) {
        // Never wait past what the origin limiter itself would allow: honour the policy's own cadence
        // when it is sooner, otherwise fall back to the limiter's window (this also covers a null
        // plan.nextCheckAt, e.g. the mission expired in the same instant).
        nextCheckAt = new Date(plan.nextCheckAt !== null ? Math.min(deferredRetryAtMs, Date.parse(plan.nextCheckAt)) : deferredRetryAtMs).toISOString();
        this.lastPlan = { ...plan, labels: [...plan.labels, 'Deferred: origin limit'] };
      } else if (this.followUpWhileAvailableMs !== null && finalMission.intent.authority === 'observe' && (finalMission.state === 'WATCHING' || finalMission.state === 'CANDIDATE') && this.readRestockEpisode(mission.id) !== null) {
        // CANDIDATE included: the first AVAILABLE read is scheduled here, before handleCandidate returns an
        // observe mission to WATCHING.
        const followUpMs = this.clock.now().getTime() + this.followUpWhileAvailableMs;
        if (plan.nextCheckAt !== null && followUpMs < Date.parse(plan.nextCheckAt)) {
          nextCheckAt = new Date(followUpMs).toISOString();
          this.lastPlan = { ...plan, labels: [...plan.labels, 'Follow-up: restock in progress'] };
        }
      }
      this.store.patchMission(mission.id, { nextCheckAt }, this.clock.now().toISOString());
    }
    return becameCandidate;
  }

  // ---------------------------------------------------------------------
  // Step 6: candidate handling
  // ---------------------------------------------------------------------
  /** Packaging conditions the user has explicitly accepted for this mission, recorded by acceptCondition(). */
  private acceptedPackagingConditions(missionId: string): string[] {
    const raw = this.store.getSetting(`mission.${missionId}.acceptedPackaging`);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  private applyAcceptedConditionOverride(mission: MissionRow, obs: Observation, result: EligibilityResult): EligibilityResult {
    if (mission.intent.packagingPolicy !== 'ask') return result;
    const idx = result.checks.findIndex((c) => c.check === 'packaging');
    if (idx === -1) return result;
    const pc = result.checks[idx]!;
    if (pc.verdict !== 'unknown') return result;
    // A09: the acceptance is of a *stated condition*, not of one screenshot. acceptCondition() clears the
    // availability sample so the offer is re-observed, and a fresh observation always carries a new
    // evidence id, so an evidence-id-only match could never fire and `ask` review looped forever.
    // The same stated condition on the re-observed offer therefore also passes; a *different* condition
    // (including `unreadable`) is not covered by the acceptance and pauses for review again.
    const acceptedEvidence = mission.intent.allowedConditionEvidenceIds.includes(obs.evidenceId);
    const observedCondition = obs.offer?.packagingCondition ?? null;
    const acceptedCondition = observedCondition !== null && this.acceptedPackagingConditions(mission.id).includes(observedCondition);
    if (!acceptedEvidence && !acceptedCondition) return result;
    const checks = result.checks.slice();
    const via = acceptedEvidence ? `evidence ${obs.evidenceId}` : `accepted stated condition ${String(observedCondition)}`;
    checks[idx] = { ...pc, verdict: 'eligible', detail: `${pc.detail} (accepted via ${via})` };
    const anyIneligible = checks.some((c) => c.verdict === 'ineligible');
    const anyUnknown = checks.some((c) => c.verdict === 'unknown');
    const verdict = anyIneligible ? 'ineligible' : anyUnknown ? 'unknown' : 'eligible';
    const nonTotal = checks.filter((c) => c.check !== 'deliveredTotal');
    const preparationPermitted = !anyIneligible && nonTotal.every((c) => c.verdict === 'eligible');
    const requiresUserReview = checks.some((c) => c.check === 'packaging' && c.verdict === 'unknown' && mission.intent.packagingPolicy !== 'must_be_intact');
    return { verdict, checks, preparationPermitted, requiresUserReview };
  }

  private readRestockEpisode(missionId: string): RestockEpisode | null {
    const raw = this.store.getSetting(`mission.${missionId}.restockEpisode`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RestockEpisode;
    } catch {
      return null;
    }
  }

  /**
   * Times how long a restock stayed in stock, from clean reads only. The true duration lies between
   * lastSeenAt - firstSeenAt (it was seen that long) and endedBy - startedAfter (it cannot have been
   * longer), so `restock.ended` carries both bounds rather than a single guessed value.
   */
  private trackRestockEpisode(mission: MissionRow, obs: Observation): void {
    const key = `mission.${mission.id}.restockEpisode`;
    const episode = this.readRestockEpisode(mission.id);
    if (obs.availability === 'AVAILABLE') {
      if (episode === null) {
        const prev = mission.lastSuccessfulObservationId ? this.store.getObservation(mission.lastSuccessfulObservationId) : null;
        const next: RestockEpisode = { startedAfter: prev?.capturedAt ?? null, firstSeenAt: obs.capturedAt, lastSeenAt: obs.capturedAt, availableReads: 1 };
        this.store.setSetting(key, JSON.stringify(next));
      } else {
        this.store.setSetting(key, JSON.stringify({ ...episode, lastSeenAt: obs.capturedAt, availableReads: episode.availableReads + 1 }));
      }
      return;
    }
    if (obs.availability !== 'UNAVAILABLE' || episode === null) return;
    const seenMs = Date.parse(episode.lastSeenAt) - Date.parse(episode.firstSeenAt);
    const maxMs = Date.parse(obs.capturedAt) - Date.parse(episode.startedAfter ?? episode.firstSeenAt);
    this.store.appendEvent({
      missionId: mission.id,
      type: 'restock.ended',
      at: this.clock.now().toISOString(),
      provenance: obs.provenance,
      payload: {
        ...episode,
        endedBy: obs.capturedAt,
        endedObservationId: obs.observationId,
        minDurationMs: seenMs,
        maxDurationMs: maxMs,
        startBounded: episode.startedAfter !== null,
      },
    });
    this.store.setSetting(key, '');
  }

  private async handleCandidate(mission: MissionRow, now: Date): Promise<void> {
    this.currentAction = 'validating';
    let nowIso = now.toISOString();
    let cur = this.store.getMission(mission.id);
    if (!cur || cur.state !== 'CANDIDATE') return;
    cur = this.store.transition(mission.id, 'VALIDATING', nowIso, {}, this.provFor(cur));

    const obsId = cur.lastObservationId;
    if (!obsId) {
      this.store.transition(mission.id, 'WATCHING', nowIso, { reason: 'no observation on record' }, this.provFor(cur));
      return;
    }
    let obs = this.store.getObservation(obsId)!;
    const extraEvidenceIds: string[] = [];

    // Restock path: an artwork-only packaging notice is resolved from the assessment made while watching,
    // not by a model call here. The cached condition is re-checked by evaluateEligibility like any other.
    const cached = this.readPackagingCache(mission.id);
    const cacheCheck = packagingCacheApplies(cached, obs, this.clock.now(), this.packagingCacheMaxAgeMs);
    if (cacheCheck.applies && cached && obs.offer) {
      obs = { ...obs, offer: { ...obs.offer, packagingCondition: cached.condition } };
      extraEvidenceIds.push(cached.evidenceId);
      this.store.appendEvent({
        missionId: mission.id,
        type: 'packaging.cache_applied',
        at: this.clock.now().toISOString(),
        provenance: cached.provenance,
        payload: { condition: cached.condition, evidenceId: cached.evidenceId, assessedAt: cached.assessedAt, ageMs: cacheCheck.ageMs },
      });
    } else if (obs.offer?.packagingCondition === 'unreadable') {
      this.store.appendEvent({ missionId: mission.id, type: 'packaging.cache_missed', at: this.clock.now().toISOString(), provenance: this.provFor(cur), payload: { reason: cacheCheck.applies ? 'no entry' : cacheCheck.reason } });
    }
    let result = this.applyAcceptedConditionOverride(cur, obs, evaluateEligibility(cur.intent, obs, { now: this.clock.now(), maxEvidenceAgeMs: this.maxEvidenceAgeMs }));

    // Restocks sell out within a minute and the human buys on live retailers: alert now, from deterministic
    // checks only, before any model call. Unresolved checks travel with the alert as "check before paying".
    const alert = this.alertOnCandidate(cur, obs, result);

    const packagingVerdict = result.checks.find((c) => c.check === 'packaging')?.verdict;
    const needsInterpretation = !cacheCheck.applies && (obs.offer?.packagingCondition === 'unreadable' || obs.accessControl === 'unsupported_layout' || packagingVerdict === 'unknown');
    if (needsInterpretation && this.interpreter) {
      const evidence = this.store.getEvidence(obs.evidenceId);
      const startMs = performance.now();
      const outcome = await this.interpreter.assess({ intent: cur.intent, observation: obs, evidence });
      const durationMs = Math.round(performance.now() - startMs);
      const afterInterp = this.store.getMission(mission.id);
      if (!afterInterp || afterInterp.generation !== cur.generation) throw new StaleGenerationError('mission changed during interpretation');
      nowIso = this.clock.now().toISOString();
      this.store.appendEvent({
        missionId: mission.id,
        type: 'interpretation.completed',
        at: nowIso,
        provenance: outcome.provenance,
        payload: { observationId: obs.observationId, ok: outcome.ok, durationMs, packagingCondition: outcome.ok ? outcome.assessment.packagingCondition : null },
      });
      if (!outcome.ok) {
        this.store.appendEvent({ missionId: mission.id, type: 'interpretation.blocked', at: nowIso, provenance: outcome.provenance, payload: { reason: outcome.reason } });
        if (cur.intent.authority === 'observe') {
          // Observe authority never acts, so pausing would only stop watching while the user buys from the alert.
          this.store.transition(mission.id, 'WATCHING', nowIso, { reason: 'interpretation unavailable; observe authority keeps watching' }, outcome.provenance);
          return;
        }
        this.store.transition(mission.id, 'PAUSED', nowIso, { pauseReason: 'user_review_required' }, outcome.provenance);
        this.store.patchMission(mission.id, { pauseReason: 'user_review_required' }, nowIso);
        return;
      }
      extraEvidenceIds.push(...outcome.assessment.evidenceIds);
      const tightenedOffer = obs.offer ? { ...obs.offer, packagingCondition: outcome.assessment.packagingCondition } : obs.offer;
      obs = { ...obs, offer: tightenedOffer };
      this.writePackagingCache(mission.id, obs, outcome.provenance);
      result = this.applyAcceptedConditionOverride(cur, obs, evaluateEligibility(cur.intent, obs, { now: this.clock.now(), maxEvidenceAgeMs: this.maxEvidenceAgeMs }));
    }

    nowIso = this.clock.now().toISOString();
    const binding: AssessmentBinding = { intentRevision: cur.intent.revision, pageRevision: obs.pageRevision, evidenceIds: Array.from(new Set([obs.evidenceId, ...extraEvidenceIds])) };
    this.store.setSetting(`mission.${mission.id}.assessment`, JSON.stringify(binding));
    this.store.appendEvent({ missionId: mission.id, type: 'validation.completed', at: nowIso, provenance: obs.provenance, payload: { verdict: result.verdict, checks: result.checks } });

    if (alert.go && result.verdict === 'ineligible') this.retractAlert(cur, obs, result);

    if (result.verdict === 'ineligible') {
      this.store.appendEvent({ missionId: mission.id, type: 'candidate.rejected', at: nowIso, provenance: obs.provenance, payload: { checks: result.checks } });
      this.store.transition(mission.id, 'WATCHING', nowIso, {}, obs.provenance);
      return;
    }
    if (!intentIsResolved(cur.intent)) {
      this.store.appendEvent({ missionId: mission.id, type: 'draft.cannot_arm', at: nowIso, provenance: obs.provenance, payload: { checks: result.checks } });
      this.store.transition(mission.id, 'WATCHING', nowIso, {}, obs.provenance);
      return;
    }
    if (result.requiresUserReview) {
      if (cur.intent.authority === 'observe') {
        // The review belongs to the user at purchase time (it is listed in the alert); BTS keeps watching.
        this.store.appendEvent({ missionId: mission.id, type: 'condition.review_requested', at: nowIso, provenance: obs.provenance, payload: { checks: result.checks } });
        this.store.transition(mission.id, 'WATCHING', nowIso, { reason: 'review listed in the restock alert; observe authority keeps watching' }, obs.provenance);
        return;
      }
      this.store.transition(mission.id, 'PAUSED', nowIso, { pauseReason: 'user_review_required' }, obs.provenance);
      this.store.patchMission(mission.id, { pauseReason: 'user_review_required' }, nowIso);
      this.store.appendEvent({ missionId: mission.id, type: 'condition.review_requested', at: nowIso, provenance: obs.provenance, payload: { checks: result.checks } });
      return;
    }

    const authorityOk = cur.intent.authority === 'demo_purchase' || cur.intent.authority === 'prepare';
    const canPrepare =
      this.executor !== null &&
      result.preparationPermitted &&
      authorityOk &&
      ((cur.intent.mode === 'demo' && this.executor.mode === 'demo') || (cur.intent.mode === 'lazada_assist' && this.executor.mode === 'lazada_prepare' && this.policy.livePrepareEnabled));

    if (canPrepare) {
      await this.prepare(mission.id, obs, this.clock.now());
      return;
    }

    this.store.transition(mission.id, 'WATCHING', nowIso, { reason: 'validated but not actionable under current authority/executor' }, obs.provenance);
  }

  // ---------------------------------------------------------------------
  // Restock alert + packaging cache
  // ---------------------------------------------------------------------
  private alertOnCandidate(mission: MissionRow, obs: Observation, result: EligibilityResult): RestockAlertDecision {
    const decision = restockAlertDecision(mission.intent, obs, result);
    const at = this.clock.now().toISOString();
    if (!decision.go) {
      this.store.appendEvent({ missionId: mission.id, type: 'restock_alert.suppressed', at, provenance: obs.provenance, payload: { observationId: obs.observationId, blockers: decision.blockers } });
      return decision;
    }
    this.store.appendEvent({
      missionId: mission.id,
      type: 'restock_alert.sent',
      at,
      provenance: obs.provenance,
      payload: { observationId: obs.observationId, headline: decision.headline, checkBeforePaying: decision.checkBeforePaying, productUrl: decision.productUrl, notifier: this.notifier?.name ?? null },
    });
    this.deliver({ kind: 'go', missionId: mission.id, headline: decision.headline, details: decision.checkBeforePaying.map((d) => `Check before paying: ${d}`), productUrl: decision.productUrl, at });
    return decision;
  }

  private retractAlert(mission: MissionRow, obs: Observation, result: EligibilityResult): void {
    const reasons = result.checks.filter((c) => c.verdict === 'ineligible').map((c) => c.detail);
    const at = this.clock.now().toISOString();
    this.store.appendEvent({ missionId: mission.id, type: 'restock_alert.retracted', at, provenance: obs.provenance, payload: { observationId: obs.observationId, reasons } });
    this.deliver({ kind: 'retract', missionId: mission.id, headline: `Do not buy: ${obs.offer?.title ?? mission.intent.target.description}`, details: reasons, productUrl: mission.intent.target.productUrl, at });
  }

  /** Fire-and-forget delivery; the outcome is recorded as an event, never thrown into the tick. */
  private deliver(n: RestockNotification): void {
    if (!this.notifier) return;
    const notifier = this.notifier;
    const record = (type: string, payload: Record<string, unknown>): void => {
      try {
        this.store.appendEvent({ missionId: n.missionId, type, at: this.clock.now().toISOString(), provenance: 'manual_input', payload: { kind: n.kind, notifier: notifier.name, ...payload } });
      } catch {
        /* store closed during shutdown; the delivery outcome is lost, not the alert */
      }
    };
    const startMs = performance.now();
    this.track(
      notifier.notify(n).then(
        () => record('restock_alert.delivered', { durationMs: Math.round(performance.now() - startMs) }),
        (err: unknown) => record('restock_alert.delivery_failed', { error: err instanceof Error ? err.message : String(err) }),
      ),
    );
  }

  private track(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => this.backgroundTasks.delete(task));
  }

  private readPackagingCache(missionId: string): PackagingCacheEntry | null {
    const raw = this.store.getSetting(`mission.${missionId}.packagingCache`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PackagingCacheEntry;
    } catch {
      return null;
    }
  }

  private writePackagingCache(missionId: string, obs: Observation, provenance: Provenance): void {
    const offer = obs.offer;
    if (!offer || offer.packagingCondition === 'unreadable' || !offer.retailerProductId || !offer.variantId) return;
    const entry: PackagingCacheEntry = {
      condition: offer.packagingCondition,
      evidenceId: obs.evidenceId,
      observationId: obs.observationId,
      assessedAt: this.clock.now().toISOString(),
      retailerProductId: offer.retailerProductId,
      variantId: offer.variantId,
      artworkRef: offer.artworkRef ?? null,
      provenance,
    };
    this.store.setSetting(`mission.${missionId}.packagingCache`, JSON.stringify(entry));
  }

  /** Background interpretation of a watching observation whose page text cannot show packaging. */
  private maybeRefreshPackaging(missionId: string, obs: Observation): void {
    const interpreter = this.interpreter;
    if (!interpreter || this.packagingRefreshInFlight.has(missionId)) return;
    if (!packagingCacheNeedsRefresh(this.readPackagingCache(missionId), obs, this.clock.now(), this.packagingCacheMaxAgeMs)) return;
    this.packagingRefreshInFlight.add(missionId);
    const record = (type: string, provenance: Provenance, payload: Record<string, unknown>): void => {
      try {
        this.store.appendEvent({ missionId, type, at: this.clock.now().toISOString(), provenance, payload: { observationId: obs.observationId, ...payload } });
      } catch {
        /* store closed during shutdown */
      }
    };
    const run = async (): Promise<void> => {
      const mission = this.store.getMission(missionId);
      if (!mission) return;
      const startMs = performance.now();
      const outcome = await interpreter.assess({ intent: mission.intent, observation: obs, evidence: this.store.getEvidence(obs.evidenceId) });
      const durationMs = Math.round(performance.now() - startMs);
      if (!outcome.ok || outcome.assessment.packagingCondition === 'unreadable') {
        record('packaging.cache_refresh_failed', outcome.provenance, { durationMs, reason: outcome.ok ? 'interpreter could not read the notice' : outcome.reason });
        return;
      }
      const resolved: Observation = obs.offer ? { ...obs, offer: { ...obs.offer, packagingCondition: outcome.assessment.packagingCondition } } : obs;
      this.writePackagingCache(missionId, resolved, outcome.provenance);
      record('packaging.cache_refreshed', outcome.provenance, { durationMs, condition: outcome.assessment.packagingCondition, evidenceId: obs.evidenceId, artworkRef: obs.offer?.artworkRef ?? null });
    };
    this.track(
      run()
        .catch((err: unknown) => record('packaging.cache_refresh_failed', this.adapter.provenance, { reason: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          this.packagingRefreshInFlight.delete(missionId);
        }),
    );
  }

  // ---------------------------------------------------------------------
  // A13: assessment currency guard, re-checked before preparation and before acting.
  // ---------------------------------------------------------------------
  private checkAssessmentCurrent(mission: MissionRow, obs: Observation, attempt?: { attemptId: string; generation: number }): boolean {
    const raw = this.store.getSetting(`mission.${mission.id}.assessment`);
    if (!raw) return true;
    const binding = JSON.parse(raw) as AssessmentBinding;
    const check = assessmentIsCurrent(binding, { intentRevision: mission.intent.revision, pageRevision: obs.pageRevision, evidenceId: obs.evidenceId });
    if (check.current) return true;
    const nowIso = this.clock.now().toISOString();
    this.store.appendEvent({ missionId: mission.id, type: 'assessment.stale', at: nowIso, provenance: this.provFor(mission), payload: { reason: check.reason } });
    // A13: an in-flight attempt built on the stale assessment is abandoned and the account execution lock
    // released, otherwise the mission returns to WATCHING holding a lock no later attempt can claim.
    if (attempt) {
      this.store.updateAttempt(attempt.attemptId, attempt.generation, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { reason: check.reason });
      this.store.releaseExecutionLock(mission.id, nowIso);
    }
    const fresh = this.store.getMission(mission.id)!;
    if (!TERMINAL_STATES.has(fresh.state) && !LOCKED_STATES.has(fresh.state) && fresh.state !== 'WATCHING') {
      this.store.transition(mission.id, 'WATCHING', nowIso, { reason: check.reason }, this.provFor(fresh));
    }
    // The discarded assessment included the availability sample, so the immediate re-observation must be
    // able to raise a fresh candidate (brief Section 7: UNKNOWN -> AVAILABLE creates a candidate).
    this.store.patchMission(mission.id, { nextCheckAt: nowIso, lastAvailability: 'UNKNOWN' }, nowIso);
    return false;
  }

  private reloadOrThrow(missionId: string, expectedGeneration: number): MissionRow {
    const m = this.store.getMission(missionId);
    if (!m) throw new StaleGenerationError(`mission ${missionId} disappeared`);
    if (m.generation !== expectedGeneration) throw new StaleGenerationError(`generation changed: expected ${expectedGeneration}, got ${m.generation}`);
    return m;
  }

  private abandonAttempt(attemptId: string, gen: number, missionId: string, nowIso: string, reason: string): void {
    this.store.updateAttempt(attemptId, gen, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { reason });
    this.store.releaseExecutionLock(missionId, nowIso);
    const mission = this.store.getMission(missionId)!;
    this.store.transition(missionId, 'WATCHING', nowIso, { reason }, this.provFor(mission));
  }

  private cartDigest(intent: PurchaseIntent, deliveredTotalMinor: number, checkoutSessionId: string): string {
    const payload = JSON.stringify({ productId: intent.target.retailerProductId, variantId: intent.target.variantId, qty: 1, deliveredTotalMinor, checkoutSessionId });
    return createHash('sha256').update(payload).digest('hex');
  }

  // ---------------------------------------------------------------------
  // Step 7: preparation
  // ---------------------------------------------------------------------
  private async prepare(missionId: string, obs: Observation, now: Date): Promise<void> {
    this.currentAction = 'preparing';
    let mission = this.store.getMission(missionId)!;
    if (!this.checkAssessmentCurrent(mission, obs)) return;

    let nowIso = now.toISOString();
    let attempt: Attempt;
    try {
      attempt = this.store.claimAttempt(missionId, obs.observationId, nowIso);
    } catch (err) {
      this.store.appendEvent({ missionId, type: 'attempt.claim_failed', at: nowIso, provenance: this.provFor(mission), payload: { error: err instanceof Error ? err.message : String(err) } });
      return;
    }
    const gen = attempt.generation;
    mission = this.store.transition(missionId, 'PREPARING', nowIso, { attemptId: attempt.attemptId }, this.provFor(mission));
    const executor = this.executor!;

    const readRes = await executor.readCart(mission.intent);
    mission = this.reloadOrThrow(missionId, gen);
    if (!readRes.ok) {
      this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), `cart read failed: ${readRes.error}`);
      return;
    }
    const plan = planCart(mission.intent, readRes.value.lines);
    if (plan.action === 'user_review') {
      nowIso = this.clock.now().toISOString();
      this.store.updateAttempt(attempt.attemptId, gen, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { reason: plan.reason });
      this.store.releaseExecutionLock(missionId, nowIso);
      this.store.transition(missionId, 'PAUSED', nowIso, { pauseReason: 'cart_user_review' }, this.provFor(mission));
      this.store.patchMission(missionId, { pauseReason: 'cart_user_review' }, nowIso);
      return;
    }

    let cart: CartState = readRes.value;
    if (plan.action === 'add_one') {
      const addRes = await executor.addOneToCart(mission.intent);
      mission = this.reloadOrThrow(missionId, gen);
      if (addRes.ok) {
        cart = addRes.value;
      } else if (addRes.outcomeUnclear) {
        const reread = await executor.readCart(mission.intent);
        mission = this.reloadOrThrow(missionId, gen);
        if (!reread.ok) {
          this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), 'add to cart unclear; re-read failed');
          return;
        }
        const targetQty = reread.value.lines
          .filter((l: CartLine) => l.retailerProductId === mission.intent.target.retailerProductId && l.variantId === mission.intent.target.variantId)
          .reduce((n: number, l: CartLine) => n + l.quantity, 0);
        if (targetQty < 1) {
          this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), 'add to cart unclear and target still absent');
          return;
        }
        cart = reread.value; // already at quantity one; never add again (A15)
      } else {
        this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), `add to cart failed: ${addRes.error}`);
        return;
      }
    }

    // A cart only carries a checkout session once one has been started. reviewCheckout() starts one
    // through the merchant's own control when handed an empty id, so an absent session here is the
    // normal first-preparation case, not a failure; only a session that is still absent afterwards is.
    if (cart.checkoutSessionId) {
      nowIso = this.clock.now().toISOString();
      this.store.updateAttempt(attempt.attemptId, gen, { checkoutSessionId: cart.checkoutSessionId }, nowIso);
    }

    const reviewRes = await executor.reviewCheckout(mission.intent, cart.checkoutSessionId ?? '');
    mission = this.reloadOrThrow(missionId, gen);
    if (!reviewRes.ok) {
      this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), `checkout review failed: ${reviewRes.error}`);
      return;
    }
    const reviewed = reviewRes.value;
    const checkoutSessionId = reviewed.checkoutSessionId ?? cart.checkoutSessionId;
    if (!checkoutSessionId) {
      this.abandonAttempt(attempt.attemptId, gen, missionId, this.clock.now().toISOString(), 'no checkout session after cart preparation');
      return;
    }
    nowIso = this.clock.now().toISOString();
    this.store.updateAttempt(attempt.attemptId, gen, { checkoutSessionId }, nowIso);
    const freshObs: Observation = { ...obs, capturedAt: this.clock.now().toISOString(), offer: obs.offer ? { ...obs.offer, deliveredTotalMinor: reviewed.deliveredTotalMinor } : obs.offer };
    const finalCheck = this.applyAcceptedConditionOverride(mission, freshObs, evaluateEligibility(mission.intent, freshObs, { now: this.clock.now(), maxEvidenceAgeMs: this.maxEvidenceAgeMs }));

    if (finalCheck.verdict !== 'eligible') {
      nowIso = this.clock.now().toISOString();
      this.store.appendEvent({ missionId, attemptId: attempt.attemptId, type: 'checkout.not_eligible', at: nowIso, provenance: this.provFor(mission), payload: { checks: finalCheck.checks, verdict: finalCheck.verdict } });
      this.store.updateAttempt(attempt.attemptId, gen, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { reason: 'not eligible at checkout' });
      this.store.releaseExecutionLock(missionId, nowIso);
      this.store.transition(missionId, 'WATCHING', nowIso, {}, this.provFor(mission));
      return;
    }

    const digest = this.cartDigest(mission.intent, reviewed.deliveredTotalMinor ?? 0, checkoutSessionId);
    nowIso = this.clock.now().toISOString();
    this.store.updateAttempt(attempt.attemptId, gen, { state: 'CHECKOUT_READY', approvedCartDigest: digest }, nowIso);
    mission = this.store.transition(missionId, 'CHECKOUT_READY', nowIso, { attemptId: attempt.attemptId }, this.provFor(mission));

    await this.act(missionId, attempt.attemptId, gen, this.clock.now());
  }

  // ---------------------------------------------------------------------
  // Step 8: act
  // ---------------------------------------------------------------------
  private async act(missionId: string, attemptId: string, gen: number, now: Date): Promise<void> {
    this.currentAction = 'acting';
    let mission = this.reloadOrThrow(missionId, gen);
    if (mission.state !== 'CHECKOUT_READY') return;
    if (mission.lastObservationId) {
      const obs = this.store.getObservation(mission.lastObservationId);
      if (obs && !this.checkAssessmentCurrent(mission, obs, { attemptId, generation: gen })) return;
    }
    const attempt = this.store.getAttempt(attemptId)!;

    if (mission.intent.mode === 'demo' && mission.intent.authority === 'demo_purchase' && this.executor && isDemoSubmissionExecutor(this.executor)) {
      let nowIso = now.toISOString();
      this.store.updateAttempt(attemptId, gen, { state: 'SUBMISSION_STARTED', submissionAt: nowIso }, nowIso, 'attempt.submission_started');
      mission = this.store.transition(missionId, 'SUBMISSION_STARTED', nowIso, { attemptId }, this.provFor(mission));
      const checkoutSessionId = attempt.checkoutSessionId!;
      const res = await this.executor.submitDemoOrder(mission.intent, checkoutSessionId);
      const fresh = this.store.getMission(missionId);
      if (!fresh || fresh.generation !== gen) throw new StaleGenerationError('mission changed during submission');
      nowIso = this.clock.now().toISOString();
      if (res.ok) {
        const order = res.value;
        this.store.updateAttempt(attemptId, gen, { state: 'ORDER_OBSERVED', merchantOrderRef: order.orderRef, reconciliationOutcome: order.status }, nowIso, 'order.observed', orderPayload(order));
        this.store.transition(missionId, 'ORDER_OBSERVED', nowIso, orderPayload(order), this.provFor(fresh));
        this.store.transition(missionId, 'COMPLETED', nowIso, orderPayload(order), this.provFor(fresh));
        this.store.releaseExecutionLock(missionId, nowIso);
        this.store.appendEvent({ missionId, attemptId, type: 'mission.completed', at: nowIso, provenance: this.provFor(fresh), payload: orderPayload(order) });
        return;
      }
      if (res.outcomeUnclear) {
        this.store.updateAttempt(attemptId, gen, { state: 'UNKNOWN' }, nowIso, 'attempt.unknown', { error: res.error });
        this.store.transition(missionId, 'UNKNOWN', nowIso, { error: res.error }, this.provFor(fresh));
        return;
      }
      // Definite non-submission (e.g. a 409 sold out). SUBMISSION_STARTED is a locked state whose only
      // legal exits are ORDER_OBSERVED and UNKNOWN (brief Section 9), so watching resumes through
      // UNKNOWN, with both edges recorded, rather than through an illegal direct edge.
      this.store.updateAttempt(attemptId, gen, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { error: res.error });
      this.store.releaseExecutionLock(missionId, nowIso);
      this.store.transition(missionId, 'UNKNOWN', nowIso, { error: res.error, submitted: false }, this.provFor(fresh));
      this.store.transition(missionId, 'WATCHING', nowIso, { error: res.error, reason: 'submission refused by the merchant; no order created' }, this.provFor(fresh));
      return;
    }

    // Live mode: never submit; hand off to the user before relinquishing the browser.
    const nowIso = this.clock.now().toISOString();
    this.store.updateAttempt(attemptId, gen, { state: 'HANDOFF_LOCKED', handoffAt: nowIso }, nowIso, 'handoff.locked');
    this.store.transition(missionId, 'HANDOFF_LOCKED', nowIso, { attemptId }, this.provFor(mission));
  }

  // ---------------------------------------------------------------------
  // Other WorkerApi methods
  // ---------------------------------------------------------------------
  approveIntent(missionId: string, approval: { expiresAt: string; authority: PurchaseIntent['authority'] }): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    if (mission.state !== 'DRAFT') throw new Error(`approveIntent requires DRAFT, mission is ${mission.state}`);
    if (Date.parse(approval.expiresAt) <= this.clock.now().getTime()) throw new Error('expiresAt must be in the future');
    if (mission.intent.mode === 'lazada_assist' && approval.authority === 'demo_purchase') throw new Error('lazada_assist mode cannot hold demo_purchase authority');
    const nowIso = this.clock.now().toISOString();
    const nextIntent: PurchaseIntent = { ...mission.intent, revision: mission.intent.revision + 1, expiresAt: approval.expiresAt, authority: approval.authority };
    this.store.updateIntent(missionId, nextIntent, nowIso, 'approveIntent');
    this.store.transition(missionId, 'WATCHING', nowIso, {}, 'manual_input');
    this.store.patchMission(missionId, { nextCheckAt: nowIso }, nowIso);
    return this.store.getMission(missionId)!;
  }

  pauseMission(missionId: string, reason: string): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const nowIso = this.clock.now().toISOString();
    const target = stopRequestOutcome(mission.state, 'PAUSED');
    if (target === mission.state) {
      // A16/A22: a locked or final mission is returned unchanged; the refusal itself is auditable.
      this.store.appendEvent({
        missionId,
        type: 'stop.refused',
        at: nowIso,
        provenance: 'manual_input',
        payload: { requested: 'PAUSED', state: mission.state, reason, refusedBecause: LOCKED_STATES.has(mission.state) ? 'purchase uncertainty lock held' : 'mission already final' },
      });
      return this.store.getMission(missionId)!;
    }
    this.store.transition(missionId, 'PAUSED', nowIso, { reason }, 'manual_input');
    this.store.patchMission(missionId, { pauseReason: reason }, nowIso);
    return this.store.getMission(missionId)!;
  }

  resumeMission(missionId: string): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    if (mission.state !== 'PAUSED') throw new Error(`resumeMission requires PAUSED, mission is ${mission.state}`);
    const nowIso = this.clock.now().toISOString();
    this.store.transition(missionId, 'WATCHING', nowIso, {}, 'manual_input');
    // The availability sample taken before the pause is no longer a trusted current fact, so clear it:
    // the next AVAILABLE observation must be able to raise a candidate again (brief Section 7).
    this.store.patchMission(missionId, { pauseReason: null, nextCheckAt: nowIso, lastAvailability: 'UNKNOWN' }, nowIso);
    return this.store.getMission(missionId)!;
  }

  cancelMission(missionId: string): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const nowIso = this.clock.now().toISOString();
    const target = stopRequestOutcome(mission.state, 'CANCELLED');
    if (target === mission.state) {
      // A22: a locked mission records the request and stays locked; a finished mission cannot be
      // cancelled at all. Either way the refusal is recorded and the state is unchanged.
      const locked = LOCKED_STATES.has(mission.state);
      if (locked) this.store.patchMission(missionId, { stopRequested: 'CANCELLED' }, nowIso);
      this.store.appendEvent({
        missionId,
        type: 'stop.refused',
        at: nowIso,
        provenance: 'manual_input',
        payload: { requested: 'CANCELLED', state: mission.state, refusedBecause: locked ? 'purchase uncertainty lock held' : 'mission already final' },
      });
      return this.store.getMission(missionId)!;
    }
    this.store.transition(missionId, 'CANCELLED', nowIso, {}, 'manual_input');
    return this.store.getMission(missionId)!;
  }

  completeHandoff(missionId: string, outcome: { result: 'ordered' | 'not_ordered' | 'unknown'; merchantOrderRef: string | null }): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    if (mission.state !== 'HANDOFF_LOCKED' && mission.state !== 'UNKNOWN') throw new Error(`completeHandoff requires HANDOFF_LOCKED or UNKNOWN, mission is ${mission.state}`);
    const nowIso = this.clock.now().toISOString();
    const attempt = this.store.listAttempts(missionId)[0];
    if (!attempt) throw new Error('No attempt on record for handoff completion');
    const gen = attempt.generation;

    if (outcome.result === 'ordered') {
      this.store.updateAttempt(attempt.attemptId, gen, { state: 'ORDER_OBSERVED', merchantOrderRef: outcome.merchantOrderRef }, nowIso, 'order.observed', { manual: true });
      this.store.transition(missionId, 'ORDER_OBSERVED', nowIso, {}, 'manual_input');
      this.store.transition(missionId, 'COMPLETED', nowIso, {}, 'manual_input');
      this.store.releaseExecutionLock(missionId, nowIso);
      this.store.appendEvent({ missionId, attemptId: attempt.attemptId, type: 'mission.completed', at: nowIso, provenance: 'manual_input', payload: {} });
      return this.store.getMission(missionId)!;
    }

    if (outcome.result === 'not_ordered') {
      this.store.updateAttempt(attempt.attemptId, gen, { state: 'ABANDONED' }, nowIso, 'attempt.abandoned', { reason: 'user reported not ordered' });
      this.store.releaseExecutionLock(missionId, nowIso);
      this.store.transition(missionId, 'WATCHING', nowIso, {}, 'manual_input');
      const afterWatch = this.store.getMission(missionId)!;
      if (afterWatch.stopRequested) {
        const finalTarget = stopRequestOutcome('WATCHING', afterWatch.stopRequested);
        if (finalTarget !== 'WATCHING') {
          this.store.transition(missionId, finalTarget, nowIso, {}, 'manual_input');
          this.store.patchMission(missionId, { stopRequested: null }, nowIso);
          return this.store.getMission(missionId)!;
        }
      }
      this.store.patchMission(missionId, { nextCheckAt: nowIso, stopRequested: null }, nowIso);
      return this.store.getMission(missionId)!;
    }

    return mission; // 'unknown': stay locked
  }

  acceptCondition(missionId: string, evidenceId: string): MissionRow {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const nowIso = this.clock.now().toISOString();
    const nextIntent: PurchaseIntent = { ...mission.intent, revision: mission.intent.revision + 1, allowedConditionEvidenceIds: [...mission.intent.allowedConditionEvidenceIds, evidenceId] };
    this.store.updateIntent(missionId, nextIntent, nowIso, 'acceptCondition');

    // Record *what* was accepted, not only which screenshot showed it: the offer is re-observed before
    // preparation and that observation carries a new evidence id (see applyAcceptedConditionOverride).
    const reviewed = mission.lastObservationId ? this.store.getObservation(mission.lastObservationId) : null;
    const condition = reviewed && reviewed.evidenceId === evidenceId ? (reviewed.offer?.packagingCondition ?? null) : null;
    if (condition !== null) {
      const accepted = this.acceptedPackagingConditions(missionId);
      if (!accepted.includes(condition)) this.store.setSetting(`mission.${missionId}.acceptedPackaging`, JSON.stringify([...accepted, condition]));
    }

    const fresh = this.store.getMission(missionId)!;
    if (fresh.state === 'PAUSED' && fresh.pauseReason === 'user_review_required') {
      this.store.transition(missionId, 'WATCHING', nowIso, {}, 'manual_input');
      // A09/A10: the accepted condition must let the *same* still-available offer proceed, so the
      // pre-pause availability sample is cleared and the next observation re-raises the candidate.
      this.store.patchMission(missionId, { pauseReason: null, nextCheckAt: nowIso, lastAvailability: 'UNKNOWN' }, nowIso);
    }
    return this.store.getMission(missionId)!;
  }

  importSignal(signal: { missionId: string; kind: 'restock_alert' | 'official_announcement' | 'user_note'; dedupeKey: string; evidenceId: string | null; receivedAt: string }): { queued: boolean; duplicate: boolean } {
    const ev = this.store.appendEvent({ missionId: signal.missionId, type: 'signal.imported', at: signal.receivedAt, provenance: 'manual_input', dedupeKey: signal.dedupeKey, payload: { kind: signal.kind, evidenceId: signal.evidenceId } });
    if (ev === null) return { queued: false, duplicate: true };
    const nowIso = this.clock.now().toISOString();
    this.store.patchMission(signal.missionId, { nextCheckAt: nowIso }, nowIso);
    return { queued: true, duplicate: false };
  }

  // ---------------------------------------------------------------------
  // health() / missionView()
  // ---------------------------------------------------------------------
  private clockInfo(): { kind: 'system' | 'virtual'; now: string; accelerated: boolean } {
    const isVirtual = this.clock instanceof VirtualClock;
    return { kind: isVirtual ? 'virtual' : 'system', now: this.clock.now().toISOString(), accelerated: isVirtual };
  }

  health(): HealthSnapshot {
    const heartbeatAt = this.store.getSetting('worker.heartbeatAt');
    // Section 7 requires `Expired` when the mission ends, and the last observation/attempt facts stay
    // useful afterwards; activeMission() deliberately excludes terminal missions, so fall back to the
    // most recent one.
    const mission = this.store.activeMission() ?? this.store.listMissions()[0] ?? null;
    const cadence: CadenceLabel | null = this.lastPlan?.cadence ?? null;
    const cadenceLabels = this.lastPlan?.labels ?? [];
    let health: MonitorHealth = 'Starting';
    let nextCheckAt: string | null = null;
    let lastSuccessfulObservationAt: string | null = null;
    let latestAttemptOutcome: string | null = null;

    if (mission) {
      nextCheckAt = TERMINAL_STATES.has(mission.state) ? null : mission.nextCheckAt;
      if (mission.lastSuccessfulObservationId) lastSuccessfulObservationAt = this.store.getObservation(mission.lastSuccessfulObservationId)?.capturedAt ?? null;
      const attempts = this.store.listAttempts(mission.id);
      latestAttemptOutcome = attempts[0]?.state ?? null;

      if (mission.state === 'EXPIRED') health = 'Expired';
      else if (TERMINAL_STATES.has(mission.state)) health = 'Starting'; // completed or cancelled: nothing is being monitored
      else if (mission.state === 'PAUSED') health = 'Paused';
      else if (cadence === 'disabled') health = 'Disabled';
      else if (this.forcedDegraded || mission.consecutiveFailures >= 2 || this.missedChecks > 0) health = 'Degraded';
      else health = 'Healthy';
    }

    return {
      health,
      workerHeartbeatAt: heartbeatAt,
      lastSuccessfulObservationAt,
      latestAttemptOutcome,
      nextCheckAt,
      cadence,
      cadenceLabels,
      apiReadiness: this.apiReadiness,
      browserReadiness: this.browserReadinessFn ? this.browserReadinessFn() : 'not_started',
      currentAction: this.currentAction,
      missedChecks: this.missedChecks,
      clock: this.clockInfo(),
    };
  }

  missionView(missionId: string): MissionView | null {
    const mission = this.store.getMission(missionId);
    if (!mission) return null;
    const events = this.store.listEvents(missionId, 5000);
    const attempts = this.store.listAttempts(missionId);
    const lastSuccessfulObservation = mission.lastSuccessfulObservationId ? this.store.getObservation(mission.lastSuccessfulObservationId) : null;
    const lastObservation = mission.lastObservationId ? this.store.getObservation(mission.lastObservationId) : null;

    const findAt = (pred: (e: Event) => boolean): string | null => events.find(pred)?.at ?? null;
    const latency: LatencyMarks = {
      signalReceivedAt: findAt((e) => e.type === 'signal.imported'),
      observationStartAt: findAt((e) => e.type === 'observation.started'),
      observationEndAt: findAt((e) => e.type === 'observation.completed'),
      candidateAt: findAt((e) => e.type === 'mission.transition' && e.payload.to === 'CANDIDATE'),
      validationDoneAt: findAt((e) => e.type === 'validation.completed'),
      checkoutReadyAt: findAt((e) => e.type === 'mission.transition' && e.payload.to === 'CHECKOUT_READY'),
      handoffAt: findAt((e) => e.type === 'handoff.locked'),
      submissionAt: findAt((e) => e.type === 'attempt.submission_started'),
      orderObservedAt: findAt((e) => e.type === 'order.observed'),
    };
    const lastValidation = events.find((e) => e.type === 'validation.completed');
    const eligibility = lastValidation
      ? { verdict: lastValidation.payload.verdict as 'eligible' | 'ineligible' | 'unknown', checks: lastValidation.payload.checks as { check: string; verdict: string; detail: string }[] }
      : null;

    return { mission, state: mission.state, intent: mission.intent, lastSuccessfulObservation, lastObservation, attempts, events, latency, eligibility };
  }

  // ---------------------------------------------------------------------
  // start() / stop()
  // ---------------------------------------------------------------------
  start(intervalMs: number): void {
    if (this.timer) return;
    this.store.setSetting('worker.intervalMs', String(intervalMs));
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.ticking) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.allSettled([...this.backgroundTasks]);
  }
}
