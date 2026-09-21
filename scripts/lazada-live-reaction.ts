/**
 * Supervised live reaction-speed measurement (docs/lazada-feasibility.md 4b): how fast the REAL
 * Worker and REAL scheduler (worker.start(1000), SystemClock) detect and react to a Lazada product
 * page, end to end, with no demo store involved. Observe-only: mission authority is 'observe', the
 * preparation executor always refuses, and the file-based live gate (BTS_LIVE_OBSERVE_ENABLED /
 * BTS_LIVE_PREPARE_ENABLED in .env, checked by src/config.ts) is untouched -- this script sets the
 * `feasibility.observe` store setting in its own throwaway in-memory Store only, which is exactly
 * what this run exists to test.
 *
 * Refuses (exit 2, no network) on any invalid/missing argument, and refuses a live model provider
 * with no key: a reaction measurement built on offline replay timings would be meaningless and is
 * never recorded.
 *
 * Usage:
 *   npm run lazada:live-reaction -- --url=<lazada url> --approved "<note>" \
 *     --cadence-seconds=<int, min 60> --reads=<int 1..30> [--signal-at-read=<n>] \
 *     [--max-per-minute=<int 1..6, default floor(60/cadence)>]  *     [--provider=gemini|anthropic|none] [--thinking=low|medium|high] [--profile=<name>]
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createModelClient } from '../src/agent/modelClient.ts';
import { FableOfferInterpreter } from '../src/agent/assess.ts';
import type { FableClient } from '../src/agent/client.ts';
import { LazadaLiveObservationAdapter } from '../src/adapters/lazadaLive.ts';
import type { CartState, ExecutorStepResult, PreparationExecutor } from '../src/adapters/types.ts';
import { validateMonitorPolicy } from '../src/domain/policy.ts';
import { PurchaseIntentSchema, type PackagingCondition, type Provenance, type PurchaseIntent } from '../src/domain/types.ts';
import { SystemClock } from '../src/domain/time.ts';
import { Store } from '../src/storage/db.ts';
import type { Event } from '../src/domain/types.ts';
import { Worker, type OfferInterpreter } from '../src/worker/worker.ts';
import { p95, summarizeTimings, reactionFloorMs, missionStateAtOrBefore, type TimingStats } from '../src/eval/reactionStats.ts';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function usageAndExit(message: string): never {
  console.error(message);
  console.error(
    'Usage: tsx scripts/lazada-live-reaction.ts --url=<lazada url> --approved "<note>" --cadence-seconds=<int,min60> --reads=<int 1..30> ' +
      '[--signal-at-read=<n>] [--max-per-minute=<int 1..6>] [--provider=gemini|anthropic|none] [--thinking=low|medium|high] [--profile=<name>]',
  );
  console.error('This script performs live retailer access. It refuses to run without an explicit approval note and a valid configuration.');
  process.exit(2);
}

const urlArg = argValue('url');
const approvedBy = argValue('approved');
const cadenceArg = argValue('cadence-seconds');
const readsArg = argValue('reads');
const signalAtReadArg = argValue('signal-at-read');
const maxPerMinuteArg = argValue('max-per-minute');
const providerArg = argValue('provider') ?? 'none';
const thinkingArg = argValue('thinking');
const profileArg = argValue('profile') ?? 'lazada-reaction';

if (!urlArg) usageAndExit('Missing --url');
if (!approvedBy || approvedBy.trim().length === 0) usageAndExit('Missing --approved "<who granted permission and when>"');

let target: URL;
try {
  target = new URL(urlArg);
} catch {
  usageAndExit(`Invalid --url "${urlArg}"`);
}
if (!/(^|\.)lazada\.sg$/.test(target.hostname)) usageAndExit(`Refusing: host ${target.hostname} is not a lazada.sg host`);

const cadenceSeconds = cadenceArg !== undefined ? Number.parseInt(cadenceArg, 10) : NaN;
if (!Number.isInteger(cadenceSeconds) || cadenceSeconds < 60) usageAndExit('--cadence-seconds must be an integer >= 60');

const reads = readsArg !== undefined ? Number.parseInt(readsArg, 10) : NaN;
if (!Number.isInteger(reads) || reads < 1 || reads > 30) usageAndExit('--reads must be an integer between 1 and 30');

let signalAtRead: number | null = null;
if (signalAtReadArg !== undefined) {
  signalAtRead = Number.parseInt(signalAtReadArg, 10);
  // Strictly below --reads: the signal read is the one AFTER read n, so n == reads would send the
  // signal and stop in the same iteration, never measuring it.
  if (!Number.isInteger(signalAtRead) || signalAtRead < 1 || signalAtRead >= reads) usageAndExit('--signal-at-read must be an integer between 1 and --reads minus 1');
}

if (providerArg !== 'gemini' && providerArg !== 'anthropic' && providerArg !== 'none') usageAndExit('--provider must be gemini, anthropic, or none');
const provider = providerArg as 'gemini' | 'anthropic' | 'none';

if (thinkingArg !== undefined && thinkingArg !== 'low' && thinkingArg !== 'medium' && thinkingArg !== 'high') usageAndExit('--thinking must be low, medium, or high');

// ---------------------------------------------------------------------------
// Config / model client. loadConfig() first populates process.env from .env (never overwrites an
// already-set var); the second, overridden call re-derives the selected provider's fields, exactly
// as scripts/lazada-gemini-observe.ts and scripts/eval-fable.ts do.
// ---------------------------------------------------------------------------
loadConfig();

let modelClient: FableClient | null = null;
let modelId: string | null = null;
if (provider !== 'none') {
  const overrides: NodeJS.ProcessEnv = { ...process.env, BTS_MODEL_PROVIDER: provider };
  if (thinkingArg && provider === 'gemini') overrides.BTS_GEMINI_THINKING_LEVEL = thinkingArg;
  if (thinkingArg && provider === 'anthropic') overrides.BTS_AGENT_EFFORT = thinkingArg;
  const modelCfg = loadConfig(overrides);
  const key = provider === 'gemini' ? modelCfg.geminiApiKey : modelCfg.apiKey;
  if (!key) {
    console.error(`BLOCKED: --provider=${provider} selected but its API key is not set; there is no offline replay for a reaction measurement (a replayed model timing is meaningless and must not be recorded)`);
    process.exit(2);
  }
  modelClient = createModelClient(modelCfg);
  modelId = modelCfg.model;
}

// ---------------------------------------------------------------------------
// Policy. Judgement call: the brief's suggested label 'supervised_reaction_test' is not a member of
// MonitorPolicySchema's `label` enum (only 'demo_defaults' | 'reviewed_live' | 'disabled'), so this
// uses 'reviewed_live' -- the semantically closest existing label for an explicitly reviewed live
// cadence -- rather than a value that would always fail validateMonitorPolicy's schema check.
// ---------------------------------------------------------------------------
// --max-per-minute raises the origin limiter above the cadence-derived floor so an imported alert can be
// read before the next scheduled tick (the limiter, not the cadence, bounded alert lag in the first run).
const maxObservationsPerOriginPerMinute = maxPerMinuteArg === undefined ? Math.max(1, Math.floor(60 / cadenceSeconds)) : Number.parseInt(maxPerMinuteArg, 10);
if (!Number.isInteger(maxObservationsPerOriginPerMinute) || maxObservationsPerOriginPerMinute < 1 || maxObservationsPerOriginPerMinute > 6) {
  usageAndExit('--max-per-minute must be an integer between 1 and 6');
}
const policyResult = validateMonitorPolicy({
  mode: 'lazada_assist',
  baselineIntervalSeconds: cadenceSeconds,
  priorityIntervalSeconds: cadenceSeconds,
  maxObservationsPerOriginPerMinute,
  liveObserveEnabled: true,
  livePrepareEnabled: false,
  label: 'reviewed_live',
});
if (!policyResult.ok) usageAndExit(`MonitorPolicy rejected: ${policyResult.error}`);
const policy = policyResult.policy;

// ---------------------------------------------------------------------------
// Preparation executor stub: every call refuses. Mission authority is 'observe', so the worker's
// `canPrepare` gate can never be true regardless of this executor -- `calls` is asserted to stay 0
// as a second, independent check that no preparation was ever attempted.
// ---------------------------------------------------------------------------
class BlockedPrepareExecutor implements PreparationExecutor {
  readonly mode = 'lazada_prepare' as const;
  calls = 0;
  constructor(readonly origin: string) {}
  private refuse<T>(): ExecutorStepResult<T> {
    this.calls += 1;
    return { ok: false, error: 'live preparation not enabled', outcomeUnclear: false };
  }
  async readCart(): Promise<ExecutorStepResult<CartState>> {
    return this.refuse<CartState>();
  }
  async addOneToCart(): Promise<ExecutorStepResult<CartState>> {
    return this.refuse<CartState>();
  }
  async reviewCheckout(): Promise<ExecutorStepResult<CartState>> {
    return this.refuse<CartState>();
  }
  async findOrderForSession(): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number } | null>> {
    return this.refuse();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Interpreter timing wrapper: records wall time and the interpreted packaging condition per
// observationId, keyed off the observation the interpreter was actually handed (never guessed from
// wall-clock stitching against the event log).
// ---------------------------------------------------------------------------
interface InterpretationRecord {
  ms: number;
  provenance: Provenance;
  ok: boolean;
  packagingConditionAfter: PackagingCondition | null;
  /** `worker`: called from VALIDATING (item was a CANDIDATE). `out_of_band`: the script made the same
   *  call on a clean observation because the item was not in stock, so the worker never validated. */
  source: 'worker' | 'out_of_band';
}

class TimingInterpreter implements OfferInterpreter {
  readonly records = new Map<string, InterpretationRecord>();
  constructor(private readonly inner: OfferInterpreter) {}
  async assess(input: Parameters<OfferInterpreter['assess']>[0]): ReturnType<OfferInterpreter['assess']> {
    return this.timed(input, 'worker');
  }

  /** The same call the worker would make in VALIDATING, made by the script when the item is out of stock. */
  async assessOutOfBand(input: Parameters<OfferInterpreter['assess']>[0]): ReturnType<OfferInterpreter['assess']> {
    return this.timed(input, 'out_of_band');
  }

  private async timed(input: Parameters<OfferInterpreter['assess']>[0], source: InterpretationRecord['source']): ReturnType<OfferInterpreter['assess']> {
    const start = performance.now();
    const result = await this.inner.assess(input);
    const ms = performance.now() - start;
    // A worker-path record wins over an out-of-band one for the same observation.
    const existing = this.records.get(input.observation.observationId);
    if (!existing || source === 'worker') {
      this.records.set(input.observation.observationId, {
        ms,
        provenance: result.provenance,
        ok: result.ok,
        packagingConditionAfter: result.ok ? result.assessment.packagingCondition : null,
        source,
      });
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Output record shape
// ---------------------------------------------------------------------------
interface ObservationRecordOut {
  index: number;
  observationId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  schedulerSlackMs: number | null;
  observeMs: number | null;
  loadMs: number | null;
  parseMs: number | null;
  /** Evidence.observedFields from the bounded buy-box readiness wait that replaced the old fixed 4 s
   *  settle sleep (see docs/lazada-feasibility.md, 2026-09-21 note). Null on any evidence that predates
   *  it or lacks the field for another reason -- never guessed. */
  readiness: 'decisive' | 'timeout' | null;
  readinessMs: number | null;
  buyBoxSelector: string | null;
  soldOutTextOutsideBuyBox: boolean | null;
  validationMs: number | null;
  interpretationMs: number | null;
  interpretationProvenance: Provenance | null;
  interpretationSource: 'worker' | 'out_of_band' | null;
  stateAfter: string | null;
  availability: string | null;
  accessControl: string | null;
  packagingConditionBefore: string | null;
  packagingConditionAfter: string | null;
  /** ms from the imported signal to the observation that read it. A `deferredCount > 0` (see below) means
   *  the origin rate limiter denied one or more attempts in between, which is expected under a tight
   *  origin limit -- the worker honours the limiter's own window rather than losing the signal to a full
   *  cadence wait (see OriginRateLimiter.nextAllowedAt / Worker.observeAndTransition). */
  signalToObservationMs: number | null;
  /** Number of `observation.deferred` (origin_rate_limit) events between the signal and the read that
   *  observed it; always 0 when `signalToObservationMs` is null. */
  deferredCount: number;
}

function fmt(v: number | string | null): string {
  return v === null ? 'n/a' : String(v);
}

function markdownTable(records: ObservationRecordOut[]): string {
  const headers = ['#', 'sched->start(ms)', 'observe(ms)', 'load(ms)', 'readiness', 'readiness(ms)', 'parse(ms)', 'validate(ms)', 'interpret(ms)', 'interpret src', 'availability', 'accessControl', 'state'];
  const rows = records.map((r) =>
    [r.index, r.schedulerSlackMs, r.observeMs, r.loadMs, r.readiness, r.readinessMs, r.parseMs, r.validationMs, r.interpretationMs, r.interpretationSource, r.availability, r.accessControl, r.stateAfter].map((v) =>
      fmt(v as number | string | null),
    ),
  );
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalUrl = target.toString();
  const dataDir = resolve(process.cwd(), 'data', 'feasibility', `reaction-${stamp}`);
  mkdirSync(dataDir, { recursive: true });
  const profileDir = resolve(process.cwd(), 'data', '.browser-profiles', profileArg);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const store = new Store(':memory:');
  // This IS the 4b test: the store setting is set in-process only, in a throwaway in-memory
  // database. The file-based gate (.env BTS_LIVE_OBSERVE_ENABLED / BTS_LIVE_PREPARE_ENABLED, read
  // by src/config.ts) is never touched and stays false for every other process on this machine.
  store.setSetting('feasibility.observe', 'passed');

  const adapter = new LazadaLiveObservationAdapter({
    page,
    productUrl: finalUrl,
    approvedBy: approvedBy!,
    dataDir,
    onEvidence: (e) => {
      try {
        store.putEvidence(e);
      } catch {
        /* best-effort provenance capture only */
      }
    },
  });
  const executor = new BlockedPrepareExecutor(adapter.origin);
  const timingInterpreter = modelClient ? new TimingInterpreter(new FableOfferInterpreter(modelClient, { dataDir })) : null;

  const retailerProductId = /-i(\d+)/.exec(finalUrl)?.[1] ?? null;
  const variantId = /-s(\d+)/.exec(finalUrl)?.[1] ?? null;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const intent: PurchaseIntent = PurchaseIntentSchema.parse({
    id: `msn_reaction_${randomUUID()}`,
    revision: 1,
    fulfillmentKey: `fkey_reaction_${randomUUID()}`,
    mode: 'lazada_assist',
    accountRef: 'unauthenticated',
    target: {
      productUrl: finalUrl,
      retailerProductId,
      variantId,
      sellerRef: 'pokemon-store-online-singapore',
      sellerEvidenceId: null,
      productFormat: 'Elite Trainer Box',
      language: 'English',
      description: 'Supervised live reaction-speed measurement target (approved run only; observe authority)',
    },
    quantity: 1,
    currency: 'SGD',
    maxDeliveredPriceMinor: 20_000,
    packagingPolicy: 'ask',
    allowedConditionEvidenceIds: [],
    launchAt: null,
    launchBasis: 'unknown',
    launchEvidenceId: null,
    restockWindow: { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: false },
    expiresAt,
    authority: 'observe',
  });

  const clock = new SystemClock();
  const worker = new Worker({
    store,
    clock,
    policy,
    adapter,
    executor,
    interpreter: timingInterpreter,
    apiReadiness: 'live',
    log: (line) => console.error(`[worker] ${line}`),
  });

  const mission = store.createMission(intent, clock.now().toISOString());
  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'observe' });

  let stoppedReason: 'reads_reached' | 'access_control' | 'observation_error' | 'timeout' = 'timeout';
  let signalSent = false;
  let signalReceivedAt: string | null = null;
  let loggedReads = 0;
  const schedSamples: { at: number; nextCheckAt: string | null }[] = [];
  const outOfBandInFlight = new Set<string>();
  const wallStart = Date.now();
  const wallBudgetMs = (reads + 1) * cadenceSeconds * 1000 + 60_000;
  const POLL_MS = 200;

  worker.start(1000);
  try {
    for (;;) {
      const m = store.getMission(mission.id);
      if (!m) break;
      schedSamples.push({ at: Date.now(), nextCheckAt: m.nextCheckAt });

      const events = store.listEvents(mission.id, 5000);
      const completedEvents = events.filter((e) => e.type === 'observation.completed');
      const completedCount = completedEvents.length;

      if (signalAtRead !== null && !signalSent && completedCount >= signalAtRead) {
        signalReceivedAt = clock.now().toISOString();
        worker.importSignal({ missionId: mission.id, kind: 'restock_alert', dedupeKey: `reaction-test-${stamp}`, evidenceId: null, receivedAt: signalReceivedAt });
        signalSent = true;
      }

      const lastCompleted = completedEvents[0]; // listEvents is DESC by `at`
      if (lastCompleted) {
        const accessControl = lastCompleted.payload.accessControl as string;
        const error = lastCompleted.payload.error as string | null;
        if (completedCount > loggedReads) {
          // One progress line per read on stderr so a supervisor can watch the run without the store.
          loggedReads = completedCount;
          const obsNow = store.getObservation(lastCompleted.payload.observationId as string);
          const evidenceNow = obsNow ? store.getEvidence(obsNow.evidenceId) : null;
          const readinessNow = (evidenceNow?.observedFields.readiness as string | undefined) ?? 'n/a';
          const readinessMsNow = (evidenceNow?.observedFields.readinessMs as number | undefined) ?? 'n/a';
          console.error(
            `[read ${completedCount}/${reads}] ${lastCompleted.at} availability=${obsNow?.availability ?? 'n/a'} accessControl=${accessControl} error=${error ?? 'none'} state=${m.state} readiness=${readinessNow} readinessMs=${readinessMsNow}`,
          );
        }
        if (accessControl !== 'none') {
          stoppedReason = 'access_control';
          break;
        }
        if (error) {
          stoppedReason = 'observation_error';
          break;
        }
        // Out-of-band model timing: the worker only validates a CANDIDATE, so an out-of-stock item
        // never exercises the interpreter. Make the identical assess call once per clean observation
        // so the run still measures the live model on the real screenshot. No navigation involved.
        const obsId = lastCompleted.payload.observationId as string | undefined;
        if (timingInterpreter && obsId && !timingInterpreter.records.has(obsId) && !outOfBandInFlight.has(obsId)) {
          outOfBandInFlight.add(obsId);
          const obs = store.getObservation(obsId);
          const cur = store.getMission(mission.id);
          if (obs && cur && obs.availability !== 'AVAILABLE') {
            await timingInterpreter.assessOutOfBand({ intent: cur.intent, observation: obs, evidence: store.getEvidence(obs.evidenceId) });
          }
        }
      }
      if (completedCount >= reads) {
        stoppedReason = 'reads_reached';
        break;
      }
      if (Date.now() - wallStart > wallBudgetMs) {
        stoppedReason = 'timeout';
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await worker.stop();
    await context.close();
  }

  if (executor.calls > 0) {
    throw new Error(`PreparationExecutor was called ${executor.calls} time(s) despite observe-only mission authority; this must never happen`);
  }

  // ---------------------------------------------------------------------
  // Post-processing: pair each observation.started with its observation.completed and any
  // validation.completed inside that window, in chronological order.
  // ---------------------------------------------------------------------
  const chronological = store.listEvents(mission.id, 5000).slice().reverse();
  interface ObsWindow {
    started: Event;
    completed: Event | null;
    validation: Event | null;
  }
  const windows: ObsWindow[] = [];
  let current: ObsWindow | null = null;
  for (const e of chronological) {
    if (e.type === 'observation.started') {
      current = { started: e, completed: null, validation: null };
      windows.push(current);
    } else if (e.type === 'observation.completed' && current && !current.completed) {
      current.completed = e;
    } else if (e.type === 'validation.completed' && current && current.completed && !current.validation) {
      current.validation = e;
    }
  }

  function nextCheckAtBefore(iso: string): string | null {
    const t = Date.parse(iso);
    let best: string | null = null;
    for (const s of schedSamples) {
      if (s.at <= t) best = s.nextCheckAt;
      else break;
    }
    return best;
  }

  // The mission state in effect *at* `completedAt`, i.e. as of the latest mission.transition on or
  // before that instant (falling back to the mission's initial DRAFT state). Not windowed to
  // [completedAt, nextStartedAt): the store's very first transition (DRAFT -> WATCHING, from
  // worker.approveIntent() before the read loop starts) happens before any observation completes, so a
  // window starting at completedAt would always miss it and every record would show `stateAfter: null`.
  const missionTransitions = chronological.filter((e) => e.type === 'mission.transition').map((e) => ({ at: e.at, to: e.payload.to as string }));
  function missionStateAfter(completedAtIso: string): string {
    return missionStateAtOrBefore(missionTransitions, completedAtIso, 'DRAFT');
  }

  function deferredCountBetween(lowerIso: string, upperIso: string): number {
    const lower = Date.parse(lowerIso);
    const upper = Date.parse(upperIso);
    return chronological.filter((e) => e.type === 'observation.deferred' && Date.parse(e.at) >= lower && Date.parse(e.at) <= upper).length;
  }

  const records: ObservationRecordOut[] = windows.map((w, i) => {
    const observationId = (w.completed?.payload.observationId as string | undefined) ?? null;
    const obs = observationId ? store.getObservation(observationId) : null;
    const evidence = obs ? store.getEvidence(obs.evidenceId) : null;
    const startedAt = w.started.at;
    const isSignalRead = signalAtRead !== null && i === signalAtRead && signalReceivedAt !== null;
    // importSignal sets nextCheckAt = now synchronously and the worker can start the read before the next
    // 200 ms poll sample, so for the signal read the import instant is the plan; a sample would be stale.
    const scheduledAt = isSignalRead ? signalReceivedAt : nextCheckAtBefore(startedAt);
    const completedAt = w.completed?.at ?? null;
    const schedulerSlackMs = scheduledAt ? Date.parse(startedAt) - Date.parse(scheduledAt) : null;
    const observeMs = completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null;
    const validationMs = w.validation && completedAt ? Date.parse(w.validation.at) - Date.parse(completedAt) : null;
    const interp = observationId ? (timingInterpreter?.records.get(observationId) ?? null) : null;
    const signalToObservationMs = isSignalRead ? Date.parse(startedAt) - Date.parse(signalReceivedAt!) : null;
    const deferredCount = isSignalRead ? deferredCountBetween(signalReceivedAt!, startedAt) : 0;
    return {
      index: i + 1,
      observationId,
      scheduledAt,
      startedAt,
      completedAt,
      schedulerSlackMs,
      observeMs,
      loadMs: (evidence?.observedFields.loadMs as number | undefined) ?? null,
      parseMs: (evidence?.observedFields.parseMs as number | undefined) ?? null,
      readiness: (evidence?.observedFields.readiness as 'decisive' | 'timeout' | undefined) ?? null,
      readinessMs: (evidence?.observedFields.readinessMs as number | undefined) ?? null,
      buyBoxSelector: (evidence?.observedFields.buyBoxSelector as string | undefined) ?? null,
      soldOutTextOutsideBuyBox: (evidence?.observedFields.soldOutTextOutsideBuyBox as boolean | undefined) ?? null,
      validationMs,
      interpretationMs: interp?.ms ?? null,
      interpretationProvenance: interp?.provenance ?? null,
      interpretationSource: interp?.source ?? null,
      stateAfter: completedAt ? missionStateAfter(completedAt) : null,
      availability: obs?.availability ?? null,
      accessControl: obs?.accessControl ?? null,
      packagingConditionBefore: obs?.offer?.packagingCondition ?? null,
      packagingConditionAfter: interp?.packagingConditionAfter ?? (obs?.offer?.packagingCondition ?? null),
      signalToObservationMs,
      deferredCount,
    };
  });

  const schedulerSlacks = records.map((r) => r.schedulerSlackMs).filter((v): v is number => v !== null);
  const observeMss = records.map((r) => r.observeMs).filter((v): v is number => v !== null);
  const interpretationMss = records.map((r) => r.interpretationMs).filter((v): v is number => v !== null);
  const validationMss = records.map((r) => r.validationMs).filter((v): v is number => v !== null);
  const readinessMss = records.map((r) => r.readinessMs).filter((v): v is number => v !== null);

  const summary = {
    schedulerSlackMs: summarizeTimings(schedulerSlacks) satisfies TimingStats,
    observeMs: summarizeTimings(observeMss) satisfies TimingStats,
    interpretationMs: summarizeTimings(interpretationMss) satisfies TimingStats,
    validationMs: summarizeTimings(validationMss) satisfies TimingStats,
    readinessMs: summarizeTimings(readinessMss) satisfies TimingStats,
    reactionFloorMs: reactionFloorMs({
      cadenceSeconds,
      observeMsP95: p95(observeMss),
      interpretationMsP95: p95(interpretationMss),
      validationMsP95: p95(validationMss),
    }),
    reactionFloorNote:
      'cadence/2 is the mean detection delay for an unannounced restock under fixed-interval polling (a uniformly random arrival within the interval is missed by half the interval on average); ' +
      (records.some((r) => r.availability === 'AVAILABLE')
        ? 'CANDIDATE (and possibly CHECKOUT_READY) were reached because the item was observed AVAILABLE at least once during this run.'
        : 'CANDIDATE/CHECKOUT_READY were not reachable because the item was not observed in stock during this run.'),
  };

  const completedReads = records.filter((r) => r.completedAt !== null).length;
  const fullDetail = {
    script: 'lazada-live-reaction',
    approvedBy,
    requestedUrl: finalUrl,
    provider,
    model: modelId,
    cadenceSeconds,
    maxObservationsPerOriginPerMinute,
    reads,
    completedReads,
    signalAtRead,
    stoppedReason,
    records,
    summary,
    startedAt: new Date(wallStart).toISOString(),
    finishedAt: new Date().toISOString(),
    executorNeverCalled: executor.calls === 0,
  };

  const jsonPath = resolve(process.cwd(), 'data', 'feasibility', `lazada-live-reaction-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(fullDetail, null, 2));

  const jsonlPath = resolve(process.cwd(), 'docs', 'evaluation-results.jsonl');
  mkdirSync(resolve(process.cwd(), 'docs'), { recursive: true });
  appendFileSync(
    jsonlPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      script: 'lazada-live-reaction',
      provider,
      path: 'live',
      model: modelId,
      cadenceSeconds,
      maxObservationsPerOriginPerMinute,
      reads,
      completedReads,
      signalAtRead,
      stoppedReason,
      summary,
      approvedBy,
    })}\n`,
  );

  console.log(`\n${markdownTable(records)}\n`);
  console.log(`Summary: ${JSON.stringify(summary, null, 2)}`);
  console.log(`Stopped: ${stoppedReason} (completed ${completedReads}/${reads} reads)`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Appended ${jsonlPath}`);

  process.exitCode = stoppedReason === 'reads_reached' ? 0 : 3;
}

main().catch((err: unknown) => {
  console.error('[lazada-live-reaction] fatal error:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
