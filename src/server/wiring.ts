/**
 * Confines integration with concurrently-developed modules (worker/worker.ts, adapters/demoStore.ts,
 * agent/client.ts, agent/extract.ts, agent/assess.ts) to one file. Every dynamic import is wrapped so a
 * missing or mismatched module degrades a reported capability instead of crashing the server
 * (BTS_FABLE_BUILD_PLAN.md Section 12: "reversible local development ... must not stop the independent
 * demo and test work").
 *
 * ASSUMPTIONS about concurrent modules' exports (see the build report for the full list):
 *  - `worker/worker.ts` exports `Worker`, constructed as
 *    `new Worker({ store, clock, policy, adapter, executor, interpreter, apiReadiness, browserReadiness })`
 *    and implements `WorkerApi` from `./types.ts`.
 *  - `adapters/demoStore.ts` exports `createDemoBrowser({ storeOrigin, headless, profileDir, dataDir })
 *    -> Promise<{ page, close }>`, `DemoStoreAdapter`, and `DemoStoreExecutor`, both constructed as
 *    `new X({ page, storeOrigin, now, onEvidence, dataDir })`.
 *  - `agent/client.ts` exports `createFableClient({ apiKey, model, effort, maxToolCalls, maxSeconds,
 *    showModelUpdates })`.
 *  - `agent/extract.ts` exports an async `extractAnnouncement(args)` returning `{ extraction, usage }`
 *    (or the extraction object directly; both shapes are accepted defensively below).
 *  - `agent/assess.ts` exports a `FableOfferInterpreter` class constructed as `new FableOfferInterpreter({
 *    client })`.
 * None of these modules existed at the time this file was written. If their actual shape differs, the
 * corresponding capability is reported `missing` and the server still starts.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnnouncementExtraction, Evidence, Provenance } from '../domain/types.ts';
import { launchFromExtraction } from '../domain/announcement.ts';
import { evaluateEligibility } from '../domain/policy.ts';
import type { Clock } from '../domain/time.ts';
import { minutes } from '../domain/time.ts';
import type { AppConfig } from '../config.ts';
import type { MissionRow, Store } from '../storage/db.ts';
import type { HealthSnapshot, MissionView, WorkerApi } from '../worker/types.ts';
import type { ObservationAdapter, PreparationExecutor } from '../adapters/types.ts';
import { LazadaObservationAdapter } from '../adapters/lazada.ts';

// Real signature (src/agent/extract.ts): extractAnnouncement(client, input) -> Promise<TaskResult<AnnouncementExtraction>>.
type ExtractAnnouncementFn = (
  client: unknown,
  input: { evidenceId: string; text?: string; imagePng?: Buffer; sourceUrl?: string | null; userExpectedTimeLocal?: string | null },
) => Promise<
  | { ok: true; output: AnnouncementExtraction; usage: unknown; provenance: Provenance }
  | { ok: false; reason: string; detail: string; usage: unknown; provenance: Provenance }
>;

export type CapabilityStatus = 'ready' | 'missing';

export interface Capabilities {
  extraction: CapabilityStatus;
  interpreter: CapabilityStatus;
  demoBrowser: CapabilityStatus;
}

export type ImportAnnouncementFn = (input: {
  text?: string;
  imagePngBase64?: string;
  sourceUrl?: string | null;
  userExpectedTimeLocal?: string | null;
}) => Promise<{
  evidenceId: string;
  extraction: unknown;
  provenance: string;
  label: string;
  launchPlan: unknown;
  missingFacts: string[];
  usage: unknown;
}>;

export interface WiringResult {
  worker: WorkerApi;
  importAnnouncement: ImportAnnouncementFn;
  capabilities: Capabilities;
  /** Human-readable degradation notes; printed at startup and never thrown. */
  warnings: string[];
  shutdown: () => Promise<void>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dynamic import via a computed specifier. TypeScript only statically resolves *literal* dynamic-import
 * specifiers against `moduleResolution`; routing the path through a variable keeps a not-yet-written
 * concurrent module (worker/worker.ts, adapters/demoStore.ts, agent/extract.ts, agent/assess.ts at the
 * time this file was written) from failing `tsc --noEmit`. It still fails softly at runtime -- every call
 * site below is wrapped in try/catch.
 */
async function dynamicImport<T = unknown>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

function isVirtualClock(clock: Clock): boolean {
  return typeof (clock as unknown as { advanceMs?: unknown }).advanceMs === 'function' && typeof (clock as unknown as { set?: unknown }).set === 'function';
}

function fact(reason: string): { value: null; evidenceId: null; span: null; reason: string } {
  return { value: null, evidenceId: null, span: null, reason };
}

/** A fully-null extraction that never claims model interpretation it did not perform. */
export function emptyExtraction(reason: string): AnnouncementExtraction {
  return {
    productFormat: fact(reason),
    productName: fact(reason),
    language: fact(reason),
    market: fact(reason),
    releaseDateLocal: fact(reason),
    releaseTimeLocal: fact(reason),
    timezone: fact(reason),
    sellerOrChannel: fact(reason),
    purchaseLimit: fact(reason),
    statedConditions: [],
    packagingCondition: fact(reason) as unknown as AnnouncementExtraction['packagingCondition'],
    relativeAge: fact(reason),
    dateBasis: 'unknown',
    missingFactsForActionableIntent: ['release date', 'release time', 'seller/channel', 'product format', 'packaging condition'],
    notes: reason,
  };
}

function saveEvidenceImage(dataDir: string, evidenceId: string, base64PngOrDataUrl: string): string {
  const dir = join(dataDir, 'evidence');
  mkdirSync(dir, { recursive: true });
  const commaIdx = base64PngOrDataUrl.indexOf(',');
  const raw = base64PngOrDataUrl.startsWith('data:') && commaIdx >= 0 ? base64PngOrDataUrl.slice(commaIdx + 1) : base64PngOrDataUrl;
  writeFileSync(join(dir, `${evidenceId}.png`), Buffer.from(raw, 'base64'));
  return `${evidenceId}.png`;
}

/**
 * Fallback WorkerApi used whenever `worker/worker.ts` cannot be loaded or constructed. Read paths are
 * served directly from the store (best-effort eligibility via the pure domain policy module); mutating
 * paths that require scheduling/attempt machinery fail loudly rather than fake success.
 */
class StubWorker implements WorkerApi {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly reason: string,
  ) {}

  async tick(): Promise<void> {
    /* no scheduler available */
  }
  start(_intervalMs: number): void {
    /* no scheduler available */
  }
  async stop(): Promise<void> {
    /* nothing to stop */
  }

  health(): HealthSnapshot {
    const virtual = isVirtualClock(this.clock);
    return {
      health: 'Disabled',
      workerHeartbeatAt: null,
      lastSuccessfulObservationAt: null,
      latestAttemptOutcome: null,
      nextCheckAt: null,
      cadence: null,
      cadenceLabels: [this.reason],
      apiReadiness: 'blocked',
      browserReadiness: 'not_started',
      currentAction: this.reason,
      missedChecks: 0,
      clock: { kind: virtual ? 'virtual' : 'system', now: this.clock.now().toISOString(), accelerated: virtual },
    };
  }

  missionView(missionId: string): MissionView | null {
    const m = this.store.getMission(missionId);
    if (!m) return null;
    const lastObservation = m.lastObservationId ? this.store.getObservation(m.lastObservationId) : null;
    const lastSuccessfulObservation = m.lastSuccessfulObservationId ? this.store.getObservation(m.lastSuccessfulObservationId) : null;
    let eligibility: MissionView['eligibility'] = null;
    if (lastObservation) {
      const r = evaluateEligibility(m.intent, lastObservation, { now: this.clock.now(), maxEvidenceAgeMs: minutes(5) });
      eligibility = { verdict: r.verdict, checks: r.checks };
    }
    return {
      mission: m,
      state: m.state,
      intent: m.intent,
      lastSuccessfulObservation,
      lastObservation,
      attempts: this.store.listAttempts(missionId),
      events: this.store.listEvents(missionId, 200),
      latency: {
        signalReceivedAt: null,
        observationStartAt: null,
        observationEndAt: null,
        candidateAt: null,
        validationDoneAt: null,
        checkoutReadyAt: null,
        handoffAt: null,
        submissionAt: null,
        orderObservedAt: null,
      },
      eligibility,
    };
  }

  approveIntent(): MissionRow {
    throw new Error(`Worker unavailable (${this.reason}); cannot approve intent`);
  }
  pauseMission(missionId: string, reason: string): MissionRow {
    return this.store.transition(missionId, 'PAUSED', this.clock.now().toISOString(), { reason }, 'manual_input');
  }
  resumeMission(missionId: string): MissionRow {
    return this.store.transition(missionId, 'WATCHING', this.clock.now().toISOString(), {}, 'manual_input');
  }
  cancelMission(missionId: string): MissionRow {
    return this.store.transition(missionId, 'CANCELLED', this.clock.now().toISOString(), {}, 'manual_input');
  }
  completeHandoff(): MissionRow {
    throw new Error(`Worker unavailable (${this.reason}); cannot complete handoff`);
  }
  acceptCondition(): MissionRow {
    throw new Error(`Worker unavailable (${this.reason}); cannot accept condition`);
  }
  importSignal(): { queued: boolean; duplicate: boolean } {
    throw new Error(`Worker unavailable (${this.reason}); cannot import signal`);
  }
}

function buildImportAnnouncement(deps: {
  store: Store;
  clock: Clock;
  config: AppConfig;
  capabilities: Capabilities;
  extractAnnouncementFn: ExtractAnnouncementFn | null;
  fableClient: unknown;
}): ImportAnnouncementFn {
  return async (input) => {
    const now = deps.clock.now().toISOString();
    const evidenceId = `evd_${randomUUID()}`;
    let extraction: AnnouncementExtraction;
    let provenance: Provenance = 'manual_input';
    let label: string;
    let usage: unknown = null;

    if (deps.capabilities.extraction === 'ready' && deps.extractAnnouncementFn && deps.fableClient) {
      try {
        const dataUrlComma = input.imagePngBase64?.indexOf(',') ?? -1;
        const imagePng = input.imagePngBase64
          ? Buffer.from(input.imagePngBase64.startsWith('data:') && dataUrlComma >= 0 ? input.imagePngBase64.slice(dataUrlComma + 1) : input.imagePngBase64, 'base64')
          : undefined;
        const result = await deps.extractAnnouncementFn(deps.fableClient, {
          evidenceId,
          text: input.text,
          imagePng,
          sourceUrl: input.sourceUrl ?? null,
          userExpectedTimeLocal: input.userExpectedTimeLocal ?? null,
        });
        usage = result.usage;
        provenance = result.provenance;
        if (result.ok) {
          extraction = result.output;
          label = provenance === 'offline_replay' ? 'Offline replay' : 'Manual input via live Fable';
        } else {
          extraction = emptyExtraction(`Fable extraction failed (${result.reason}): ${result.detail}`);
          label = `Manual input (extraction ${result.reason}: ${result.detail})`;
        }
      } catch (err) {
        extraction = emptyExtraction(`Fable extraction failed: ${errMsg(err)}`);
        label = 'Manual input (extraction failed; see notes)';
      }
    } else {
      extraction = emptyExtraction('Fable extraction module is not available in this build (src/agent/extract.ts)');
      label = 'Manual input (extraction unavailable in this build)';
    }

    const launchPlan = launchFromExtraction(extraction, input.userExpectedTimeLocal ?? null);

    const evidence: Evidence = {
      evidenceId,
      sourceKind: 'user_import',
      provenance,
      sourceUrl: input.sourceUrl ?? null,
      sourceMessageId: null,
      capturedAt: null,
      sourcePublishedAt: null,
      receivedAt: now,
      targetRef: null,
      variantRef: null,
      pageRevision: null,
      observedFields: { extraction: extraction as unknown as Record<string, unknown> },
      snapshotRef: input.imagePngBase64 ? saveEvidenceImage(deps.config.dataDir, evidenceId, input.imagePngBase64) : null,
      contentHash: null,
    };
    deps.store.putEvidence(evidence);

    return { evidenceId, extraction, provenance, label, launchPlan, missingFacts: extraction.missingFactsForActionableIntent, usage };
  };
}

export async function buildWiring(opts: { store: Store; clock: Clock; config: AppConfig }): Promise<WiringResult> {
  const { store, clock, config } = opts;
  const warnings: string[] = [];
  const capabilities: Capabilities = { extraction: 'missing', interpreter: 'missing', demoBrowser: 'missing' };

  let fableClient: unknown = null;
  try {
    const mod = await dynamicImport<{ createFableClient?: (args: unknown) => unknown }>('../agent/client.ts');
    if (typeof mod.createFableClient === 'function') {
      fableClient = mod.createFableClient({
        apiKey: config.apiKey,
        model: config.model,
        effort: config.effort,
        maxToolCalls: config.agentMaxToolCalls,
        maxSeconds: config.agentMaxSeconds,
        showModelUpdates: config.showModelUpdates,
      });
    } else {
      warnings.push('agent/client.ts loaded but does not export createFableClient');
    }
  } catch (err) {
    warnings.push(`agent/client.ts unavailable: ${errMsg(err)}`);
  }

  let extractAnnouncementFn: ExtractAnnouncementFn | null = null;
  try {
    const mod = await dynamicImport<{ extractAnnouncement?: ExtractAnnouncementFn }>('../agent/extract.ts');
    if (typeof mod.extractAnnouncement === 'function') {
      extractAnnouncementFn = mod.extractAnnouncement;
      capabilities.extraction = 'ready';
    } else {
      warnings.push('agent/extract.ts loaded but does not export extractAnnouncement');
    }
  } catch (err) {
    warnings.push(`agent/extract.ts unavailable: ${errMsg(err)}`);
  }

  let interpreter: unknown = null;
  try {
    const mod = await dynamicImport<{ FableOfferInterpreter?: new (client: unknown, opts: { dataDir: string }) => unknown }>('../agent/assess.ts');
    if (mod.FableOfferInterpreter && fableClient) {
      // Actual signature: constructor(client: FableClient, opts: { dataDir; browserExecutor? }) -- two
      // positional args, not a single options object.
      interpreter = new mod.FableOfferInterpreter(fableClient, { dataDir: config.dataDir });
      capabilities.interpreter = 'ready';
    } else if (!mod.FableOfferInterpreter) {
      warnings.push('agent/assess.ts loaded but does not export FableOfferInterpreter');
    } else {
      warnings.push('agent/assess.ts available but no Fable client (offline replay); interpreter marked missing');
    }
  } catch (err) {
    warnings.push(`agent/assess.ts unavailable: ${errMsg(err)}`);
  }

  let adapter: ObservationAdapter | null = null;
  let executor: PreparationExecutor | null = null;
  let demoBrowserClose: (() => Promise<void>) | null = null;

  if (config.mode === 'demo') {
    try {
      const mod = await dynamicImport<{
        createDemoBrowser: (args: { storeOrigin: string; headless: boolean; profileDir: string; dataDir: string }) => Promise<{ page: unknown; close: () => Promise<void> }>;
        DemoStoreAdapter: new (args: unknown) => ObservationAdapter;
        DemoStoreExecutor: new (args: unknown) => PreparationExecutor;
      }>('../adapters/demoStore.ts');
      const browser = await mod.createDemoBrowser({
        storeOrigin: config.demoStoreOrigin,
        headless: true,
        profileDir: join(config.dataDir, 'demo-profile'),
        dataDir: config.dataDir,
      });
      demoBrowserClose = browser.close;
      const onEvidence = (e: unknown): void => {
        try {
          store.putEvidence(e as Evidence);
        } catch (err) {
          warnings.push(`demo browser produced an evidence record that failed validation: ${errMsg(err)}`);
        }
      };
      const sharedArgs = { page: browser.page, storeOrigin: config.demoStoreOrigin, now: () => clock.now(), onEvidence, dataDir: config.dataDir };
      adapter = new mod.DemoStoreAdapter(sharedArgs);
      executor = new mod.DemoStoreExecutor(sharedArgs);
      capabilities.demoBrowser = 'ready';
    } catch (err) {
      warnings.push(`adapters/demoStore.ts unavailable: ${errMsg(err)}`);
    }
  } else {
    adapter = new LazadaObservationAdapter({ store, liveObserveEnabled: config.liveObserveEnabled });
    executor = null;
  }

  let worker: WorkerApi;
  try {
    const mod = await dynamicImport<{ Worker: new (args: unknown) => WorkerApi }>('../worker/worker.ts');
    worker = new mod.Worker({
      store,
      clock,
      policy: config.monitorPolicy,
      adapter,
      executor,
      interpreter,
      apiReadiness: config.modelPath,
      // worker/worker.ts takes a *function* here (`browserReadiness?: () => 'ready' | 'not_started' | 'failed'`),
      // not a static value, so browser readiness can change after construction (e.g. if the demo browser dies).
      browserReadiness: () => (config.mode === 'demo' ? (capabilities.demoBrowser === 'ready' ? 'ready' : 'failed') : 'not_started'),
    });
  } catch (err) {
    warnings.push(`worker/worker.ts unavailable: ${errMsg(err)}`);
    worker = new StubWorker(store, clock, 'worker/worker.ts failed to load');
  }

  const importAnnouncement = buildImportAnnouncement({ store, clock, config, capabilities, extractAnnouncementFn, fableClient });

  return {
    worker,
    importAnnouncement,
    capabilities,
    warnings,
    shutdown: async () => {
      if (demoBrowserClose) await demoBrowserClose();
    },
  };
}
