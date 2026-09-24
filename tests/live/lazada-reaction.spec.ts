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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loadConfig } from '../../src/config.ts';
import { createModelClient } from '../../src/agent/modelClient.ts';
import { SystemClock } from '../../src/domain/time.ts';
import { Store } from '../../src/storage/db.ts';
import { createLiveObserveWorker, launchLiveBrowser, liveObserveIntent, liveObservePolicy } from '../../src/worker/liveObserve.ts';
import { ConsoleNotifier } from '../../src/worker/notifier.ts';

loadConfig(); // populates process.env from .env (never overwrites an already-set var) before reading it below

const LAZADA_URL = process.env.BTS_LIVE_LAZADA_URL;
const APPROVED_BY = process.env.BTS_LIVE_LAZADA_APPROVED;
const PROVIDER = (process.env.BTS_MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'gemini') as 'gemini' | 'anthropic';
const modelCfg = loadConfig({ ...process.env, BTS_MODEL_PROVIDER: PROVIDER });
const PROVIDER_KEY = PROVIDER === 'gemini' ? modelCfg.geminiApiKey : modelCfg.apiKey;
const PROVIDER_KEY_NAME = PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';

const missingVar = !LAZADA_URL ? 'BTS_LIVE_LAZADA_URL' : !APPROVED_BY ? 'BTS_LIVE_LAZADA_APPROVED' : !PROVIDER_KEY ? PROVIDER_KEY_NAME : null;

test('live Lazada single observation under the real Worker/scheduler (observe-only authority)', async ({}, testInfo) => {
  test.skip(missingVar !== null, `Set ${missingVar} (see .env.example) to run this live test`);

  const url = new URL(LAZADA_URL!);
  expect(url.hostname.endsWith('lazada.sg'), `host ${url.hostname} is not a lazada.sg host`).toBe(true);

  const browser = await launchLiveBrowser({ profileDir: null });
  const dataDir = mkdtempSync(join(tmpdir(), 'bts-lazada-reaction-live-'));
  const store = new Store(':memory:');
  // This test IS a feasibility-gate exercise: the setting is set in-process only, in a throwaway
  // in-memory database. The file-based gate (.env BTS_LIVE_OBSERVE_ENABLED, read by src/config.ts)
  // is never touched.
  store.setSetting('feasibility.observe', 'passed');

  const finalUrl = url.toString();
  const clock = new SystemClock();
  const { worker, executor } = createLiveObserveWorker({
    store,
    clock,
    page: browser.page,
    productUrl: finalUrl,
    approvedBy: APPROVED_BY!,
    dataDir,
    policy: liveObservePolicy({ cadenceSeconds: 300, maxObservationsPerOriginPerMinute: 1 }),
    modelClient: createModelClient(modelCfg),
    notifier: new ConsoleNotifier(),
  });

  const intent = liveObserveIntent({ productUrl: finalUrl, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), description: 'Live reaction spec target (approved run only; observe authority)' });
  const mission = store.createMission(intent, clock.now().toISOString());
  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'observe' });

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
    await worker.stop(); // waits for the background packaging read started by an out-of-stock observation
  }
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

  const schedulerSlackMs = Date.parse(started!.at) - Date.parse(started!.payload.plannedAt as string);
  const observeMs = Date.parse(completed!.at) - Date.parse(started!.at);
  // Model time from the worker's own events: validation (item in stock) or the background artwork read (out of stock).
  const interpEvent = chronological.find((e) => (e.type === 'interpretation.completed' || e.type.startsWith('packaging.cache_refresh')) && e.payload.observationId === observationId) ?? null;
  const interp = interpEvent ? { ms: interpEvent.payload.durationMs as number, provenance: interpEvent.provenance } : null;
  // readiness/readinessMs/buyBoxSelector/soldOutTextOutsideBuyBox: added when the fixed 4 s
  // settle sleep was replaced by a bounded buy-box readiness wait (docs/lazada-feasibility.md, 2026-09-21
  // note). Printed, not asserted on, until a live run confirms the buy-box selectors actually match.
  const readiness = evidence?.observedFields.readiness ?? 'n/a';
  const readinessMs = evidence?.observedFields.readinessMs ?? 'n/a';
  const buyBoxSelector = evidence?.observedFields.buyBoxSelector ?? 'n/a';
  const soldOutTextOutsideBuyBox = evidence?.observedFields.soldOutTextOutsideBuyBox ?? 'n/a';

  testInfo.annotations.push({
    type: 'timing',
    description: `schedulerSlackMs=${schedulerSlackMs} observeMs=${observeMs} interpretationMs=${interp?.ms ?? 'n/a'} availability=${obs.availability} accessControl=${obs.accessControl} readiness=${readiness} readinessMs=${readinessMs} buyBoxSelector=${buyBoxSelector} soldOutTextOutsideBuyBox=${soldOutTextOutsideBuyBox}`,
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
