/**
 * Gated live suite: never runs under `npm run test:e2e` (different testDir/config -- see
 * playwright.live.config.ts). Run explicitly with `npm run test:live:lazada` (shares that config
 * with tests/live/lazada-gemini-computer-use.spec.ts).
 *
 * Drives the REAL Worker/scheduler (worker.start(1000), SystemClock) with the REAL
 * LazadaLiveObservationAdapter against one user-supplied Lazada URL, for exactly one observation,
 * on a fresh non-persistent browser context. Skips itself (rather than failing) when the required
 * env vars are absent: BTS_LIVE_LAZADA_URL, BTS_LIVE_LAZADA_APPROVED, and the API key for whichever
 * provider BTS_MODEL_PROVIDER selects (gemini by default). The interpreter is wired in because the
 * known packaging notice on this listing is artwork-only text the deterministic parser cannot read
 * (see src/adapters/lazadaLive.ts), so a candidate almost always needs it.
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loadConfig } from '../../src/config.ts';
import { createModelClient } from '../../src/agent/modelClient.ts';
import { FableOfferInterpreter } from '../../src/agent/assess.ts';
import { LazadaLiveObservationAdapter } from '../../src/adapters/lazadaLive.ts';
import type { CartState, ExecutorStepResult, PreparationExecutor } from '../../src/adapters/types.ts';
import { validateMonitorPolicy } from '../../src/domain/policy.ts';
import { PurchaseIntentSchema, type Provenance, type PurchaseIntent } from '../../src/domain/types.ts';
import { SystemClock } from '../../src/domain/time.ts';
import { Store } from '../../src/storage/db.ts';
import { Worker, type OfferInterpreter } from '../../src/worker/worker.ts';

loadConfig(); // populates process.env from .env (never overwrites an already-set var) before reading it below

const LAZADA_URL = process.env.BTS_LIVE_LAZADA_URL;
const APPROVED_BY = process.env.BTS_LIVE_LAZADA_APPROVED;
const PROVIDER = (process.env.BTS_MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'gemini') as 'gemini' | 'anthropic';
const modelCfg = loadConfig({ ...process.env, BTS_MODEL_PROVIDER: PROVIDER });
const PROVIDER_KEY = PROVIDER === 'gemini' ? modelCfg.geminiApiKey : modelCfg.apiKey;
const PROVIDER_KEY_NAME = PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';

const missingVar = !LAZADA_URL ? 'BTS_LIVE_LAZADA_URL' : !APPROVED_BY ? 'BTS_LIVE_LAZADA_APPROVED' : !PROVIDER_KEY ? PROVIDER_KEY_NAME : null;

/** Mission authority is 'observe', so the worker's canPrepare gate is never true regardless of this
 * executor; `calls` is asserted to stay 0 as a second, independent check. */
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

interface InterpretationRecord {
  ms: number;
  provenance: Provenance;
  ok: boolean;
}

/** Wraps the real interpreter to measure wall time per observationId without touching worker.ts. */
class TimingInterpreter implements OfferInterpreter {
  readonly records = new Map<string, InterpretationRecord>();
  constructor(private readonly inner: OfferInterpreter) {}
  async assess(input: Parameters<OfferInterpreter['assess']>[0]): ReturnType<OfferInterpreter['assess']> {
    const start = performance.now();
    const result = await this.inner.assess(input);
    this.records.set(input.observation.observationId, { ms: performance.now() - start, provenance: result.provenance, ok: result.ok });
    return result;
  }
}

test('live Lazada single observation under the real Worker/scheduler (observe-only authority)', async ({}, testInfo) => {
  test.skip(missingVar !== null, `Set ${missingVar} (see .env.example) to run this live test`);

  const url = new URL(LAZADA_URL!);
  expect(url.hostname.endsWith('lazada.sg'), `host ${url.hostname} is not a lazada.sg host`).toBe(true);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore' });
  const page = await context.newPage();

  const dataDir = mkdtempSync(join(tmpdir(), 'bts-lazada-reaction-live-'));
  const store = new Store(':memory:');
  // This test IS a feasibility-gate exercise: the setting is set in-process only, in a throwaway
  // in-memory database. The file-based gate (.env BTS_LIVE_OBSERVE_ENABLED, read by src/config.ts)
  // is never touched.
  store.setSetting('feasibility.observe', 'passed');

  const adapter = new LazadaLiveObservationAdapter({
    page,
    productUrl: url.toString(),
    approvedBy: APPROVED_BY!,
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
  const timingInterpreter = new TimingInterpreter(new FableOfferInterpreter(createModelClient(modelCfg), { dataDir }));

  const policyResult = validateMonitorPolicy({
    mode: 'lazada_assist',
    baselineIntervalSeconds: 300,
    priorityIntervalSeconds: 300,
    maxObservationsPerOriginPerMinute: 1,
    liveObserveEnabled: true,
    livePrepareEnabled: false,
    label: 'reviewed_live',
  });
  if (!policyResult.ok) throw new Error(`MonitorPolicy rejected: ${policyResult.error}`);

  const finalUrl = url.toString();
  const retailerProductId = /-i(\d+)/.exec(finalUrl)?.[1] ?? null;
  const variantId = /-s(\d+)/.exec(finalUrl)?.[1] ?? null;
  const intent: PurchaseIntent = PurchaseIntentSchema.parse({
    id: `msn_reaction_live_${Date.now()}`,
    revision: 1,
    fulfillmentKey: `fkey_reaction_live_${Date.now()}`,
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
      description: 'Live reaction spec target (approved run only; observe authority)',
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
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    authority: 'observe',
  });

  const clock = new SystemClock();
  const worker = new Worker({
    store,
    clock,
    policy: policyResult.policy,
    adapter,
    executor,
    interpreter: timingInterpreter,
    apiReadiness: 'live',
  });

  const mission = store.createMission(intent, clock.now().toISOString());
  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'observe' });
  const scheduledAt = store.getMission(mission.id)!.nextCheckAt!;

  const wallStart = Date.now();
  const BUDGET_MS = 120_000;
  worker.start(1000);
  try {
    for (;;) {
      const events = store.listEvents(mission.id, 50);
      if (events.some((e) => e.type === 'observation.completed')) break;
      if (Date.now() - wallStart > BUDGET_MS) throw new Error(`Timed out waiting for the first observation to complete after ${BUDGET_MS}ms`);
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    await worker.stop();
  }
  await context.close();
  await browser.close();

  expect(executor.calls, 'the preparation executor must never be called under observe-only authority').toBe(0);

  const chronological = store.listEvents(mission.id, 50).slice().reverse();
  const started = chronological.find((e) => e.type === 'observation.started');
  const completed = chronological.find((e) => e.type === 'observation.completed');
  expect(started, 'expected an observation.started event').toBeTruthy();
  expect(completed, 'expected an observation.completed event').toBeTruthy();

  const observationId = completed!.payload.observationId as string;
  const obs = store.getObservation(observationId)!;
  const evidence = store.getEvidence(obs.evidenceId);
  const finalUrlHost = evidence?.observedFields.finalUrl ? new URL(String(evidence.observedFields.finalUrl)).hostname : url.hostname;

  const schedulerSlackMs = Date.parse(started!.at) - Date.parse(scheduledAt);
  const observeMs = Date.parse(completed!.at) - Date.parse(started!.at);
  const interp = timingInterpreter.records.get(observationId) ?? null;

  testInfo.annotations.push({
    type: 'timing',
    description: `schedulerSlackMs=${schedulerSlackMs} observeMs=${observeMs} interpretationMs=${interp?.ms ?? 'n/a'} availability=${obs.availability} accessControl=${obs.accessControl}`,
  });

  expect(obs.provenance).toBe('live_verified');
  expect(obs.accessControl).toBe('none');
  expect(finalUrlHost.endsWith('lazada.sg'), `final host ${finalUrlHost} left lazada.sg`).toBe(true);
  expect(obs.offer?.title ?? '').toMatch(/elite trainer box/i);
  expect(obs.offer?.sellerLabel ?? '').toMatch(/pok[eé]mon store online singapore/i);
  expect(obs.availability).not.toBe('UNKNOWN');
  expect(schedulerSlackMs).toBeLessThanOrEqual(2000);
  expect(observeMs).toBeLessThan(30_000);
  if (interp) {
    expect(interp.ms).toBeLessThan(60_000);
    // Both FableClient and GeminiClient label a successful live model call 'manual_input' (see
    // src/agent/client.ts / src/agent/geminiClient.ts): a model proposal, not yet a verified fact.
    expect(interp.provenance).toBe('manual_input');
  }
});
