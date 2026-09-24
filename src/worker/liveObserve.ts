/**
 * One composition of the live observe-only worker, shared by every live harness
 * (scripts/lazada-live-reaction.ts, tests/live/lazada-reaction.spec.ts) so each measures the same
 * Worker + adapter + interpreter + notifier wiring instead of its own copy.
 *
 * Observe-only by construction: the intent's authority is `observe`, the policy has
 * `livePrepareEnabled: false`, and the executor refuses every call (callers assert `calls === 0`).
 * Nothing here reads or changes the file-based live gate (.env BTS_LIVE_OBSERVE_ENABLED); callers pass
 * their own throwaway Store.
 */
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { FableOfferInterpreter } from '../agent/assess.ts';
import type { FableClient } from '../agent/client.ts';
import { LazadaLiveObservationAdapter } from '../adapters/lazadaLive.ts';
import type { LazadaLivePage } from '../adapters/lazadaLive.ts';
import type { CartState, ExecutorStepResult, PreparationExecutor } from '../adapters/types.ts';
import { validateMonitorPolicy } from '../domain/policy.ts';
import { PurchaseIntentSchema } from '../domain/types.ts';
import type { MonitorPolicy, PackagingPolicy, PurchaseIntent } from '../domain/types.ts';
import type { Clock } from '../domain/time.ts';
import type { Store } from '../storage/db.ts';
import type { RestockNotifier } from './notifier.ts';
import { Worker } from './worker.ts';

/** Refuses every call; `calls` must stay 0 under observe authority (a second, independent check). */
export class BlockedPrepareExecutor implements PreparationExecutor {
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
  async close(): Promise<void> {}
}

/** Validated observe-only live policy. Throws with the validator's message when rejected. */
export function liveObservePolicy(input: { cadenceSeconds: number; maxObservationsPerOriginPerMinute: number }): MonitorPolicy {
  const res = validateMonitorPolicy({
    mode: 'lazada_assist',
    baselineIntervalSeconds: input.cadenceSeconds,
    priorityIntervalSeconds: input.cadenceSeconds,
    maxObservationsPerOriginPerMinute: input.maxObservationsPerOriginPerMinute,
    liveObserveEnabled: true,
    livePrepareEnabled: false,
    label: 'reviewed_live',
  });
  if (!res.ok) throw new Error(`MonitorPolicy rejected: ${res.error}`);
  return res.policy;
}

/**
 * Observe-authority intent for the verified target (docs/lazada-feasibility.md step 3: seller
 * "Pokemon Store Online Singapore", shop path pokemon-store-online-singapore). Product and variant ids
 * come from the URL's -i<product>-s<sku> segment.
 */
export function liveObserveIntent(input: {
  productUrl: string;
  expiresAt: string;
  description: string;
  sellerRef?: string;
  productFormat?: string;
  language?: string;
  maxDeliveredPriceMinor?: number;
  packagingPolicy?: PackagingPolicy;
}): PurchaseIntent {
  return PurchaseIntentSchema.parse({
    id: `msn_live_${randomUUID()}`,
    revision: 1,
    fulfillmentKey: `fkey_live_${randomUUID()}`,
    mode: 'lazada_assist',
    accountRef: 'unauthenticated',
    target: {
      productUrl: input.productUrl,
      retailerProductId: /-i(\d+)/.exec(input.productUrl)?.[1] ?? null,
      variantId: /-s(\d+)/.exec(input.productUrl)?.[1] ?? null,
      sellerRef: input.sellerRef ?? 'pokemon-store-online-singapore',
      sellerEvidenceId: null,
      productFormat: input.productFormat ?? 'Elite Trainer Box',
      language: input.language ?? 'English',
      description: input.description,
    },
    quantity: 1,
    currency: 'SGD',
    maxDeliveredPriceMinor: input.maxDeliveredPriceMinor ?? 20_000,
    packagingPolicy: input.packagingPolicy ?? 'ask',
    allowedConditionEvidenceIds: [],
    launchAt: null,
    launchBasis: 'unknown',
    launchEvidenceId: null,
    restockWindow: { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: false },
    expiresAt: input.expiresAt,
    authority: 'observe',
  });
}

/** Headless Chromium with the viewport/locale every live read so far used. `profileDir` null = fresh non-persistent context. */
export async function launchLiveBrowser(opts: { profileDir: string | null }): Promise<{ page: LazadaLivePage; close: () => Promise<void> }> {
  const contextOptions = { headless: true, viewport: { width: 1280, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore' };
  if (opts.profileDir) {
    const context = await chromium.launchPersistentContext(opts.profileDir, contextOptions);
    const page = context.pages()[0] ?? (await context.newPage());
    return { page, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: contextOptions.viewport, locale: contextOptions.locale, timezoneId: contextOptions.timezoneId });
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

export interface LiveObserveWorker {
  worker: Worker;
  adapter: LazadaLiveObservationAdapter;
  executor: BlockedPrepareExecutor;
}

export function createLiveObserveWorker(deps: {
  store: Store;
  clock: Clock;
  page: LazadaLivePage;
  productUrl: string;
  approvedBy: string;
  dataDir: string;
  policy: MonitorPolicy;
  /** Null runs without an interpreter: packaging stays unresolved and is listed in the alert. */
  modelClient: FableClient | null;
  notifier: RestockNotifier | null;
  /** See WorkerDeps.followUpWhileAvailableMs; null keeps the cadence after a restock. */
  followUpWhileAvailableMs?: number | null;
  log?: (line: string) => void;
}): LiveObserveWorker {
  const { store } = deps;
  const adapter = new LazadaLiveObservationAdapter({
    page: deps.page,
    productUrl: deps.productUrl,
    approvedBy: deps.approvedBy,
    dataDir: deps.dataDir,
    onEvidence: (e) => {
      try {
        store.putEvidence(e);
      } catch {
        /* best-effort provenance capture only */
      }
    },
  });
  const executor = new BlockedPrepareExecutor(adapter.origin);
  const interpreter = deps.modelClient ? new FableOfferInterpreter(deps.modelClient, { dataDir: deps.dataDir }) : null;
  const worker = new Worker({
    store,
    clock: deps.clock,
    policy: deps.policy,
    adapter,
    executor,
    interpreter,
    notifier: deps.notifier,
    followUpWhileAvailableMs: deps.followUpWhileAvailableMs ?? null,
    apiReadiness: 'live',
    log: deps.log,
  });
  return { worker, adapter, executor };
}
