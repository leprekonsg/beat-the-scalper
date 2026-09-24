/**
 * Supervised live reaction-speed measurement (docs/lazada-feasibility.md 4b): how fast the REAL
 * Worker and REAL scheduler (worker.start(1000), SystemClock) detect a Lazada restock and alert the
 * user, end to end, with no demo store involved. Observe-only: mission authority is 'observe', the
 * preparation executor always refuses, and the file-based live gate (BTS_LIVE_OBSERVE_ENABLED /
 * BTS_LIVE_PREPARE_ENABLED in .env, checked by src/config.ts) is untouched -- this script sets the
 * `feasibility.observe` store setting in its own throwaway in-memory Store only, which is exactly
 * what this run exists to test.
 *
 * Composition comes from src/worker/liveObserve.ts (shared with tests/live/lazada-reaction.spec.ts).
 * Every timing comes from the worker's own event log: slack from `observation.started.plannedAt`,
 * the alert from `restock_alert.sent`/`.delivered`, model time from `packaging.cache_refreshed` (the
 * background artwork read while out of stock) and `interpretation.completed` (validation).
 *
 * Restocks typically sell out within a minute, so the summary reports the share of restocks that
 * would alert the user with `--human-seconds` still left (`catchProbability`), not only a mean.
 *
 * Refuses (exit 2, no network) on any invalid/missing argument, and refuses a live model provider
 * with no key: a reaction measurement built on offline replay timings would be meaningless and is
 * never recorded.
 *
 * Usage:
 *   npm run lazada:live-reaction -- --url=<lazada url> --approved "<note>" \
 *     --cadence-seconds=<int, min 60> --reads=<int 1..30> [--signal-at-read=<n>] \
 *     [--max-per-minute=<int 1..6, default floor(60/cadence)>] [--provider=gemini|anthropic|none] \
 *     [--thinking=low|medium|high] [--profile=<name>] [--sellout-seconds=<int, default 60>] \
 *     [--human-seconds=<int, default 20>] [--follow-up-seconds=<int, min 60/max-per-minute>] \
 *     [--seller=<shop path>] [--format=<text>] [--language=<text>]
 *
 * --follow-up-seconds: while the item is in stock, read again at this interval instead of the
 * cadence, so the sell-out is timed (`restock.ended` bounds). Every follow-up counts toward --reads.
 * --seller/--format/--language: match the intent to a different listing (an in-stock probe of
 * another product), so the alert path is exercised instead of suppressed as a mismatch.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createModelClient } from '../src/agent/modelClient.ts';
import type { FableClient } from '../src/agent/client.ts';
import { SystemClock } from '../src/domain/time.ts';
import { Store } from '../src/storage/db.ts';
import type { Event } from '../src/domain/types.ts';
import { createLiveObserveWorker, launchLiveBrowser, liveObserveIntent, liveObservePolicy } from '../src/worker/liveObserve.ts';
import { createNotifier } from '../src/worker/notifier.ts';
import { alertPipelineMs, catchProbability, missionStateAtOrBefore, p50, p95, reactionEstimate, summarizeTimings, type TimingStats } from '../src/eval/reactionStats.ts';

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
      '[--signal-at-read=<n>] [--max-per-minute=<int 1..6>] [--provider=gemini|anthropic|none] [--thinking=low|medium|high] [--profile=<name>] ' +
      '[--sellout-seconds=<int>] [--human-seconds=<int>] [--follow-up-seconds=<int>] [--seller=<shop path>] [--format=<text>] [--language=<text>]',
  );
  console.error('This script performs live retailer access. It refuses to run without an explicit approval note and a valid configuration.');
  process.exit(2);
}

function positiveIntArg(name: string, fallback: number): number {
  const raw = argValue(name);
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) usageAndExit(`--${name} must be a positive integer`);
  return n;
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
const selloutSeconds = positiveIntArg('sellout-seconds', 60);
const humanSeconds = positiveIntArg('human-seconds', 20);
const followUpArg = argValue('follow-up-seconds');
const sellerArg = argValue('seller');
const formatArg = argValue('format');
const languageArg = argValue('language');

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

// --max-per-minute raises the origin limiter above the cadence-derived floor so an imported alert can be
// read before the next scheduled tick (the limiter, not the cadence, bounded alert lag in the first run).
const maxObservationsPerOriginPerMinute = maxPerMinuteArg === undefined ? Math.max(1, Math.floor(60 / cadenceSeconds)) : Number.parseInt(maxPerMinuteArg, 10);
if (!Number.isInteger(maxObservationsPerOriginPerMinute) || maxObservationsPerOriginPerMinute < 1 || maxObservationsPerOriginPerMinute > 6) {
  usageAndExit('--max-per-minute must be an integer between 1 and 6');
}

// A follow-up faster than the origin limiter allows would only be deferred, so refuse it up front.
let followUpSeconds: number | null = null;
if (followUpArg !== undefined) {
  followUpSeconds = Number.parseInt(followUpArg, 10);
  const floor = Math.ceil(60 / maxObservationsPerOriginPerMinute);
  if (!Number.isInteger(followUpSeconds) || followUpSeconds < floor || followUpSeconds >= cadenceSeconds) {
    usageAndExit(`--follow-up-seconds must be an integer from ${floor} (60 / --max-per-minute) to below --cadence-seconds`);
  }
}

// ---------------------------------------------------------------------------
// Config / model client. loadConfig() first populates process.env from .env (never overwrites an
// already-set var); the second, overridden call re-derives the selected provider's fields.
// ---------------------------------------------------------------------------
const baseConfig = loadConfig();

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

let policy: ReturnType<typeof liveObservePolicy>;
try {
  policy = liveObservePolicy({ cadenceSeconds, maxObservationsPerOriginPerMinute });
} catch (err) {
  usageAndExit(err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Output record shape
// ---------------------------------------------------------------------------
interface ObservationRecordOut {
  index: number;
  observationId: string | null;
  /** `observation.started.payload.plannedAt`: the instant that made the read due. */
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  schedulerSlackMs: number | null;
  observeMs: number | null;
  loadMs: number | null;
  parseMs: number | null;
  readiness: 'decisive' | 'timeout' | null;
  readinessMs: number | null;
  /** Outcome of the purchase-button confirm wait (lazadaLive.ts); 'sold_out_appeared' is a false restock averted. */
  purchaseConfirm: string | null;
  purchaseConfirmMs: number | null;
  /** Evidence screenshot, listed for AVAILABLE reads so each can be checked by eye. */
  snapshotRef: string | null;
  /** 'sent' or 'suppressed' when this read raised a candidate; blockers when suppressed. */
  alertDecision: 'sent' | 'suppressed' | null;
  alertBlockers: string[];
  buyBoxSelector: string | null;
  soldOutTextOutsideBuyBox: boolean | null;
  artworkRef: string | null;
  validationMs: number | null;
  /** Set only when this read raised a candidate and the alert fired. */
  alertAt: string | null;
  alertAfterObserveMs: number | null;
  alertDeliveredMs: number | null;
  /** Model time spent on this read: validation-time interpretation, or the background packaging refresh. */
  interpretationMs: number | null;
  interpretationSource: 'validation' | 'background_refresh' | null;
  packagingCacheApplied: boolean;
  stateAfter: string | null;
  availability: string | null;
  accessControl: string | null;
  packagingConditionPage: string | null;
  /** ms from the imported signal to the observation that read it; deferredCount counts limiter denials between. */
  signalToObservationMs: number | null;
  deferredCount: number;
}

function fmt(v: number | string | boolean | null): string {
  return v === null ? 'n/a' : String(v);
}

function markdownTable(records: ObservationRecordOut[]): string {
  const headers = ['#', 'sched->start(ms)', 'observe(ms)', 'readiness', 'readiness(ms)', 'confirm', 'parse(ms)', 'alert', 'alert after observe(ms)', 'model(ms)', 'model src', 'cache hit', 'availability', 'accessControl', 'state'];
  const rows = records.map((r) =>
    [r.index, r.schedulerSlackMs, r.observeMs, r.readiness, r.readinessMs, r.purchaseConfirm, r.parseMs, r.alertDecision, r.alertAfterObserveMs, r.interpretationMs, r.interpretationSource, r.packagingCacheApplied, r.availability, r.accessControl, r.stateAfter].map((v) => fmt(v)),
  );
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
  return lines.join('\n');
}

const numbers = (xs: (number | null)[]): number[] => xs.filter((v): v is number => v !== null);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalUrl = target.toString();
  const dataDir = resolve(process.cwd(), 'data', 'feasibility', `reaction-${stamp}`);
  mkdirSync(dataDir, { recursive: true });
  const browser = await launchLiveBrowser({ profileDir: resolve(process.cwd(), 'data', '.browser-profiles', profileArg) });

  const store = new Store(':memory:');
  // This IS the 4b test: the store setting is set in-process only, in a throwaway in-memory
  // database. The file-based gate (.env BTS_LIVE_OBSERVE_ENABLED / BTS_LIVE_PREPARE_ENABLED, read
  // by src/config.ts) is never touched and stays false for every other process on this machine.
  store.setSetting('feasibility.observe', 'passed');

  const clock = new SystemClock();
  // A real restock during a supervised run alerts the operator like the product would (terminal bell,
  // plus BTS_ALERT_WEBHOOK_URL when set).
  const notifier = createNotifier({ webhookUrl: baseConfig.alertWebhookUrl });
  const { worker, executor } = createLiveObserveWorker({
    store,
    clock,
    page: browser.page,
    productUrl: finalUrl,
    approvedBy: approvedBy!,
    dataDir,
    policy,
    modelClient,
    notifier,
    followUpWhileAvailableMs: followUpSeconds === null ? null : followUpSeconds * 1000,
    log: (line) => console.error(`[worker] ${line}`),
  });

  const intent = liveObserveIntent({
    productUrl: finalUrl,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    description: 'Supervised live reaction-speed measurement target (approved run only; observe authority)',
    sellerRef: sellerArg,
    productFormat: formatArg,
    language: languageArg,
  });
  const mission = store.createMission(intent, clock.now().toISOString());
  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'observe' });

  let stoppedReason: 'reads_reached' | 'access_control' | 'observation_error' | 'timeout' = 'timeout';
  let signalSent = false;
  let signalReceivedAt: string | null = null;
  let loggedReads = 0;
  const wallStart = Date.now();
  const wallBudgetMs = (reads + 1) * cadenceSeconds * 1000 + 60_000;
  const POLL_MS = 200;

  worker.start(1000);
  try {
    for (;;) {
      const m = store.getMission(mission.id);
      if (!m) break;

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
          console.error(
            `[read ${completedCount}/${reads}] ${lastCompleted.at} availability=${obsNow?.availability ?? 'n/a'} accessControl=${accessControl} error=${error ?? 'none'} state=${m.state} readiness=${String(evidenceNow?.observedFields.readiness ?? 'n/a')} readinessMs=${String(evidenceNow?.observedFields.readinessMs ?? 'n/a')}`,
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
    await worker.stop(); // also waits for a background packaging refresh or alert delivery in flight
    await browser.close();
  }

  if (executor.calls > 0) {
    throw new Error(`PreparationExecutor was called ${executor.calls} time(s) despite observe-only mission authority; this must never happen`);
  }

  // ---------------------------------------------------------------------
  // Post-processing, from the event log only: pair each observation.started with its completion and
  // with the alert/validation/model events that name the same observation.
  // ---------------------------------------------------------------------
  const chronological = store.listEvents(mission.id, 5000).slice().reverse();
  const byObservation = (type: string, observationId: string | null): Event | null =>
    observationId === null ? null : (chronological.find((e) => e.type === type && e.payload.observationId === observationId) ?? null);

  interface ObsWindow {
    started: Event;
    completed: Event | null;
    validation: Event | null;
    cacheApplied: boolean;
  }
  const windows: ObsWindow[] = [];
  let current: ObsWindow | null = null;
  for (const e of chronological) {
    if (e.type === 'observation.started') {
      current = { started: e, completed: null, validation: null, cacheApplied: false };
      windows.push(current);
    } else if (e.type === 'observation.completed' && current && !current.completed) {
      current.completed = e;
    } else if (e.type === 'validation.completed' && current && current.completed && !current.validation) {
      current.validation = e;
    } else if (e.type === 'packaging.cache_applied' && current && current.completed) {
      current.cacheApplied = true;
    }
  }

  const missionTransitions = chronological.filter((e) => e.type === 'mission.transition').map((e) => ({ at: e.at, to: e.payload.to as string }));
  const deferredCountBetween = (lowerIso: string, upperIso: string): number =>
    chronological.filter((e) => e.type === 'observation.deferred' && Date.parse(e.at) >= Date.parse(lowerIso) && Date.parse(e.at) <= Date.parse(upperIso)).length;

  const records: ObservationRecordOut[] = windows.map((w, i) => {
    const observationId = (w.completed?.payload.observationId as string | undefined) ?? null;
    const obs = observationId ? store.getObservation(observationId) : null;
    const evidence = obs ? store.getEvidence(obs.evidenceId) : null;
    const startedAt = w.started.at;
    const scheduledAt = (w.started.payload.plannedAt as string | null | undefined) ?? null;
    const completedAt = w.completed?.at ?? null;
    const alert = byObservation('restock_alert.sent', observationId);
    const suppressed = byObservation('restock_alert.suppressed', observationId);
    const delivered = alert ? (chronological.find((e) => e.type === 'restock_alert.delivered' && e.payload.kind === 'go' && Date.parse(e.at) >= Date.parse(alert.at)) ?? null) : null;
    const validationInterp = byObservation('interpretation.completed', observationId);
    const refresh = byObservation('packaging.cache_refreshed', observationId) ?? byObservation('packaging.cache_refresh_failed', observationId);
    const interp = validationInterp ?? refresh;
    const isSignalRead = signalAtRead !== null && i === signalAtRead && signalReceivedAt !== null;
    return {
      index: i + 1,
      observationId,
      scheduledAt,
      startedAt,
      completedAt,
      schedulerSlackMs: scheduledAt ? Date.parse(startedAt) - Date.parse(scheduledAt) : null,
      observeMs: completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null,
      loadMs: (evidence?.observedFields.loadMs as number | undefined) ?? null,
      parseMs: (evidence?.observedFields.parseMs as number | undefined) ?? null,
      readiness: (evidence?.observedFields.readiness as 'decisive' | 'timeout' | undefined) ?? null,
      readinessMs: (evidence?.observedFields.readinessMs as number | undefined) ?? null,
      purchaseConfirm: (evidence?.observedFields.purchaseConfirm as string | undefined) ?? null,
      purchaseConfirmMs: (evidence?.observedFields.purchaseConfirmMs as number | undefined) ?? null,
      snapshotRef: evidence?.snapshotRef ?? null,
      alertDecision: alert ? 'sent' : suppressed ? 'suppressed' : null,
      alertBlockers: (suppressed?.payload.blockers as string[] | undefined) ?? [],
      buyBoxSelector: (evidence?.observedFields.buyBoxSelector as string | undefined) ?? null,
      soldOutTextOutsideBuyBox: (evidence?.observedFields.soldOutTextOutsideBuyBox as boolean | undefined) ?? null,
      artworkRef: (evidence?.observedFields.artworkRef as string | null | undefined) ?? null,
      validationMs: w.validation && completedAt ? Date.parse(w.validation.at) - Date.parse(completedAt) : null,
      alertAt: alert?.at ?? null,
      alertAfterObserveMs: alert && completedAt ? Date.parse(alert.at) - Date.parse(completedAt) : null,
      alertDeliveredMs: (delivered?.payload.durationMs as number | undefined) ?? null,
      interpretationMs: (interp?.payload.durationMs as number | undefined) ?? null,
      interpretationSource: validationInterp ? 'validation' : refresh ? 'background_refresh' : null,
      packagingCacheApplied: w.cacheApplied,
      stateAfter: completedAt ? missionStateAtOrBefore(missionTransitions, completedAt, 'DRAFT') : null,
      availability: obs?.availability ?? null,
      accessControl: obs?.accessControl ?? null,
      packagingConditionPage: obs?.offer?.packagingCondition ?? null,
      signalToObservationMs: isSignalRead ? Date.parse(startedAt) - Date.parse(signalReceivedAt!) : null,
      deferredCount: isSignalRead ? deferredCountBetween(signalReceivedAt!, startedAt) : 0,
    };
  });

  // Alert pipeline per read: the alert fires milliseconds after the observation completes (before any
  // model call), so reads without a restock still measure it up to the missing few ms.
  const pipelines = numbers(records.map((r) => alertPipelineMs(r)));
  const pipelineP95 = p95(pipelines);
  const reaction = reactionEstimate({ cadenceSeconds, pipelineMsP50: p50(pipelines), pipelineMsP95: pipelineP95 });
  const catchAtCadence = catchProbability({ cadenceSeconds, selloutSeconds, pipelineMs: pipelineP95 ?? 0, humanActionSeconds: humanSeconds });
  const signalRead = records.find((r) => r.signalToObservationMs !== null) ?? null;

  const summary = {
    schedulerSlackMs: summarizeTimings(numbers(records.map((r) => r.schedulerSlackMs))) satisfies TimingStats,
    observeMs: summarizeTimings(numbers(records.map((r) => r.observeMs))) satisfies TimingStats,
    readinessMs: summarizeTimings(numbers(records.map((r) => r.readinessMs))) satisfies TimingStats,
    alertPipelineMs: summarizeTimings(pipelines) satisfies TimingStats,
    alertAfterObserveMs: summarizeTimings(numbers(records.map((r) => r.alertAfterObserveMs))) satisfies TimingStats,
    backgroundModelMs: summarizeTimings(numbers(records.filter((r) => r.interpretationSource === 'background_refresh').map((r) => r.interpretationMs))) satisfies TimingStats,
    validationModelMs: summarizeTimings(numbers(records.filter((r) => r.interpretationSource === 'validation').map((r) => r.interpretationMs))) satisfies TimingStats,
    pollingReactionMs: reaction,
    catchProbability: {
      value: catchAtCadence,
      assumptions: { cadenceSeconds, selloutSeconds, humanActionSeconds: humanSeconds, pipelineMs: pipelineP95 },
      note: 'Share of unannounced restocks that alert with humanActionSeconds still left before sell-out, polling alone (p95 pipeline). Alert-driven reads bypass the cadence wait.',
    },
    alertDriven:
      signalRead === null
        ? null
        : { signalToObservationMs: signalRead.signalToObservationMs, observeMs: signalRead.observeMs, deferredCount: signalRead.deferredCount, note: 'Reaction to an imported alert: signal -> read start + observe; the alert then fires within ms.' },
    restockSeen: records.some((r) => r.availability === 'AVAILABLE'),
    alertsSent: records.filter((r) => r.alertAt !== null).length,
    // Each restock's in-stock duration bounds (worker `restock.ended`): the sell-out input to catchProbability.
    restockEpisodes: chronological.filter((e) => e.type === 'restock.ended').map((e) => e.payload),
    // Every AVAILABLE read with its screenshot, to confirm by eye that none is a false restock.
    availableReadsToVerify: records
      .filter((r) => r.availability === 'AVAILABLE')
      .map((r) => ({ index: r.index, purchaseConfirm: r.purchaseConfirm, alertDecision: r.alertDecision, alertBlockers: r.alertBlockers, snapshotRef: r.snapshotRef })),
    purchaseConfirmCounts: records.reduce<Record<string, number>>((acc, r) => {
      if (r.purchaseConfirm) acc[r.purchaseConfirm] = (acc[r.purchaseConfirm] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const completedReads = records.filter((r) => r.completedAt !== null).length;
  const fullDetail = {
    script: 'lazada-live-reaction',
    approvedBy,
    requestedUrl: finalUrl,
    provider,
    model: modelId,
    notifier: notifier.name,
    cadenceSeconds,
    maxObservationsPerOriginPerMinute,
    followUpSeconds,
    intentOverrides: { seller: sellerArg ?? null, format: formatArg ?? null, language: languageArg ?? null },
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
    `${JSON.stringify({ at: new Date().toISOString(), script: 'lazada-live-reaction', provider, path: 'live', model: modelId, cadenceSeconds, maxObservationsPerOriginPerMinute, reads, completedReads, signalAtRead, stoppedReason, summary, approvedBy })}\n`,
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
