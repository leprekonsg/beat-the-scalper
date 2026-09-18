/**
 * Reproducible demonstration runner (BTS_FABLE_BUILD_PLAN.md sections 7, 14, 15).
 *
 * Runs entirely in-process against an ephemeral demo store (ports 0) and a throwaway data dir
 * under data/ (gitignored, removed on exit). No fixed ports, no real retailer, no model key: the
 * mission's packagingPolicy is 'removed_allowed' so the offer interpreter is never needed, and no
 * interpreter is wired into the Worker at all.
 *
 * Five measured runs: reset the demo store, arm a mission while etb-151/en is out of stock, have a
 * "presenter" publish a restock via the demo store's admin API and record that instant as
 * `signalReceivedAt` via `worker.importSignal(...)`, then tick the real Worker (SystemClock, real
 * elapsed time) until it reaches COMPLETED or a 60s wall budget expires. One `failAddToCartOnce`
 * fault case (A12/A14) and one `delayedConfirmationMs` interruption case (A19/A20) follow, using the
 * same harness with a wrapped executor that counts add-to-cart/submit calls.
 *
 * Every line of output and every recorded event in this run is `demo` provenance; nothing here
 * calls a real retailer. Output: a table on stdout, `docs/evaluation-results.json` (machine
 * readable), and an appended section in `docs/evaluation-results.md`.
 *
 * Usage: npm run demo:run   (== tsx scripts/run-demo-flows.ts)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

import { startDemoStore, type FaultConfig } from '../demo/store/server.ts';
import { createDemoBrowser, DemoStoreAdapter, DemoStoreExecutor } from '../src/adapters/demoStore.ts';
import type { CartState, DemoSubmissionExecutor, ExecutorStepResult } from '../src/adapters/types.ts';
import { DEMO_MONITOR_POLICY, PurchaseIntentSchema, type PurchaseIntent } from '../src/domain/types.ts';
import { SystemClock, utcToLocal } from '../src/domain/time.ts';
import { Store } from '../src/storage/db.ts';
import { Worker } from '../src/worker/worker.ts';
import type { LatencyMarks } from '../src/worker/types.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');

const RUN_BUDGET_MS = 60_000;
const TICK_PAUSE_MS = 150;
/** demoStore.ts's DemoStoreExecutor waits 8s for the submit click; comfortably exceed it. */
const DELAYED_CONFIRMATION_FAULT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sgLocalString(iso: string): string {
  const { date, time } = utcToLocal(iso, 'Asia/Singapore');
  return `${date} ${time} +08:00`;
}

function readPlaywrightVersion(): string {
  try {
    const pkgPath = resolve(repoRoot, 'node_modules', 'playwright', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Intent builder: the seeded etb-151/en product, packagingPolicy removed_allowed so the offer
// interpreter is never invoked (BTS_FABLE_BUILD_PLAN.md section 10: stated_removed is eligible
// under removed_allowed without model interpretation).
// ---------------------------------------------------------------------------
function buildIntent(storeOrigin: string, label: string): PurchaseIntent {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return PurchaseIntentSchema.parse({
    id: `msn_${label}_${randomUUID()}`,
    revision: 1,
    fulfillmentKey: `fkey_${label}_${randomUUID()}`,
    mode: 'demo',
    accountRef: 'demo-run-script',
    target: {
      productUrl: `${storeOrigin}/product/etb-151?variant=en`,
      retailerProductId: 'etb-151',
      variantId: 'en',
      sellerRef: 'pokemon-store-online-sg',
      sellerEvidenceId: null,
      productFormat: 'Elite Trainer Box',
      language: 'English',
      description: 'Pokemon TCG Scarlet & Violet 151 Elite Trainer Box, English, one unit (scripted demo run)',
    },
    quantity: 1,
    currency: 'SGD',
    maxDeliveredPriceMinor: 20_000,
    packagingPolicy: 'removed_allowed',
    allowedConditionEvidenceIds: [],
    launchAt: null,
    launchBasis: 'unknown',
    launchEvidenceId: null,
    restockWindow: { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: false },
    expiresAt,
    authority: 'demo_purchase',
  });
}

// ---------------------------------------------------------------------------
// Counting executor wrapper: delegates every call to the real Playwright DemoStoreExecutor, only
// adding call counters so A12/A14/A19/A20 assertions can check exact call counts.
// ---------------------------------------------------------------------------
interface ExecutorCounts {
  readCart: number;
  addOneToCart: number;
  reviewCheckout: number;
  submitDemoOrder: number;
  findOrderForSession: number;
}

class CountingExecutor implements DemoSubmissionExecutor {
  readonly mode = 'demo' as const;
  readonly origin: string;
  readonly counts: ExecutorCounts = { readCart: 0, addOneToCart: 0, reviewCheckout: 0, submitDemoOrder: 0, findOrderForSession: 0 };

  constructor(private readonly inner: DemoStoreExecutor) {
    this.origin = inner.origin;
  }
  async readCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.counts.readCart += 1;
    return this.inner.readCart(intent);
  }
  async addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>> {
    this.counts.addOneToCart += 1;
    return this.inner.addOneToCart(intent);
  }
  async reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>> {
    this.counts.reviewCheckout += 1;
    return this.inner.reviewCheckout(intent, checkoutSessionId);
  }
  async findOrderForSession(checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number } | null>> {
    this.counts.findOrderForSession += 1;
    return this.inner.findOrderForSession(checkoutSessionId);
  }
  async submitDemoOrder(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number }>> {
    this.counts.submitDemoOrder += 1;
    return this.inner.submitDemoOrder(intent, checkoutSessionId);
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
}

// ---------------------------------------------------------------------------
// Demo store admin helpers (the agent under test never touches this origin; only the presenter/
// script does, exactly as BTS_FABLE_BUILD_PLAN.md section 4 requires).
// ---------------------------------------------------------------------------
async function adminPost(adminOrigin: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${adminOrigin}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
}

interface AdminOrder {
  orderRef: string;
  status: string;
  quantity: number;
  totalMinor: number;
  sessionId: string;
}

async function adminGetOrders(adminOrigin: string): Promise<AdminOrder[]> {
  const res = await fetch(`${adminOrigin}/admin/orders`);
  if (!res.ok) throw new Error(`admin/orders failed: HTTP ${res.status}`);
  return (await res.json()) as AdminOrder[];
}

// ---------------------------------------------------------------------------
// One measured/fault run
// ---------------------------------------------------------------------------
type RunKind = 'measured' | 'fault_add_to_cart_once' | 'fault_delayed_confirmation';

interface RunResult {
  label: string;
  kind: RunKind;
  passed: boolean;
  failures: string[];
  finalState: string;
  ordersCount: number;
  ticks: number;
  wallMs: number;
  latency: LatencyMarks;
  signalToReadyMs: number | null;
  observationToReadyMs: number | null;
  provenanceLabelsSeen: string[];
  executorCounts: ExecutorCounts;
  passedThroughUnknown: boolean;
}

interface RunOneFlowOpts {
  page: Page;
  demoStoreOrigin: string;
  demoAdminOrigin: string;
  label: string;
  kind: RunKind;
  faults: Partial<FaultConfig> | null;
  dataDir: string;
}

async function runOneFlow(opts: RunOneFlowOpts): Promise<RunResult> {
  const { page, demoStoreOrigin, demoAdminOrigin, label, kind, faults, dataDir } = opts;
  const failures: string[] = [];
  const wallStart = Date.now();

  await adminPost(demoAdminOrigin, '/admin/reset');
  if (faults) await adminPost(demoAdminOrigin, '/admin/faults', faults);

  const store = new Store(':memory:');
  const clock = new SystemClock();
  const rawExecutor = new DemoStoreExecutor({ page, storeOrigin: demoStoreOrigin });
  const executor = new CountingExecutor(rawExecutor);
  const adapter = new DemoStoreAdapter({
    page,
    storeOrigin: demoStoreOrigin,
    now: () => new Date(),
    onEvidence: (e) => {
      try {
        store.putEvidence(e);
      } catch {
        /* best-effort provenance capture only */
      }
    },
    dataDir,
  });
  const worker = new Worker({
    store,
    clock,
    policy: DEMO_MONITOR_POLICY,
    adapter,
    executor,
    interpreter: null,
    apiReadiness: 'offline_replay',
    log: (line) => console.error(`[worker:${label}] ${line}`), // surfaced so a hung/erroring tick is never silently swallowed
  });

  const intent = buildIntent(demoStoreOrigin, label);
  const mission = store.createMission(intent, clock.now().toISOString());
  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'demo_purchase' });

  // Mission armed while etb-151/en is out of stock (a fresh admin/reset seeds stock 0).
  await worker.tick();
  const armedMission = store.getMission(mission.id)!;
  if (armedMission.state !== 'WATCHING') {
    failures.push(`expected WATCHING after the pre-signal observation of an out-of-stock target, got ${armedMission.state}`);
  }

  // Presenter publishes the restock and the same instant is recorded as signalReceivedAt.
  const signalReceivedAt = clock.now().toISOString();
  await adminPost(demoAdminOrigin, '/admin/stock', { productId: 'etb-151', variantId: 'en', quantity: 5 });
  const importResult = worker.importSignal({ missionId: mission.id, kind: 'restock_alert', dedupeKey: `${label}-restock`, evidenceId: null, receivedAt: signalReceivedAt });
  if (!importResult.queued || importResult.duplicate) {
    failures.push(`importSignal did not queue a fresh observation: ${JSON.stringify(importResult)}`);
  }

  let ticks = 1;
  let finalMission = store.getMission(mission.id)!;
  while (Date.now() - wallStart < RUN_BUDGET_MS) {
    await worker.tick();
    ticks += 1;
    finalMission = store.getMission(mission.id)!;
    if (finalMission.state === 'COMPLETED') break;
    await sleep(TICK_PAUSE_MS);
  }

  const missionView = worker.missionView(mission.id);
  if (!missionView) throw new Error(`missionView(${mission.id}) returned null`);
  const latency = missionView.latency;
  const passedThroughUnknown = missionView.events.some((e) => e.type === 'mission.transition' && e.payload.to === 'UNKNOWN');
  const provenanceLabelsSeen = Array.from(new Set(missionView.events.map((e) => e.provenance))).sort();

  const orders = await adminGetOrders(demoAdminOrigin);

  if (finalMission.state !== 'COMPLETED') {
    failures.push(`expected COMPLETED, got ${finalMission.state} after ${ticks} ticks / ${Date.now() - wallStart}ms`);
  }
  if (orders.length !== 1) failures.push(`expected exactly 1 order in /admin/orders, got ${orders.length}`);
  const onlyOrder = orders.length === 1 ? orders[0] : undefined;
  if (onlyOrder && onlyOrder.quantity !== 1) failures.push(`expected order quantity 1, got ${onlyOrder.quantity}`);
  if (!latency.signalReceivedAt) failures.push('missing signalReceivedAt in latency marks');
  if (!latency.orderObservedAt) failures.push('missing orderObservedAt in latency marks');

  if (kind === 'fault_add_to_cart_once' && executor.counts.addOneToCart !== 1) {
    failures.push(`expected exactly 1 addOneToCart call (cart must never exceed quantity 1), got ${executor.counts.addOneToCart}`);
  }
  if (kind === 'fault_delayed_confirmation') {
    if (!passedThroughUnknown) failures.push('expected the mission to pass through UNKNOWN before reconciliation completed it');
    if (executor.counts.submitDemoOrder !== 1) failures.push(`expected exactly 1 submitDemoOrder call (no blind resubmission), got ${executor.counts.submitDemoOrder}`);
  }

  const signalToReadyMs = latency.orderObservedAt && latency.signalReceivedAt ? Date.parse(latency.orderObservedAt) - Date.parse(latency.signalReceivedAt) : null;
  const observationToReadyMs = latency.orderObservedAt && latency.observationStartAt ? Date.parse(latency.orderObservedAt) - Date.parse(latency.observationStartAt) : null;

  await rawExecutor.close();
  store.close();

  return {
    label,
    kind,
    passed: failures.length === 0,
    failures,
    finalState: finalMission.state,
    ordersCount: orders.length,
    ticks,
    wallMs: Date.now() - wallStart,
    latency,
    signalToReadyMs,
    observationToReadyMs,
    provenanceLabelsSeen,
    executorCounts: { ...executor.counts },
    passedThroughUnknown,
  };
}

// ---------------------------------------------------------------------------
// Reporting: stdout table, docs/evaluation-results.json, docs/evaluation-results.md
// ---------------------------------------------------------------------------
function fmtMs(ms: number | null): string {
  return ms === null ? 'n/a' : String(ms);
}

function printTable(rows: RunResult[]): void {
  const headers = ['Label', 'Kind', 'Final state', 'Orders', 'Signal->Ready(ms)', 'Obs->Ready(ms)', 'Ticks', 'Wall(ms)', 'Result'];
  const data = rows.map((r) => [r.label, r.kind, r.finalState, String(r.ordersCount), fmtMs(r.signalToReadyMs), fmtMs(r.observationToReadyMs), String(r.ticks), String(r.wallMs), r.passed ? 'PASS' : `FAIL (${r.failures.length})`]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const printRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(`\n${printRow(headers)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) console.log(printRow(row));
  const failedRows = rows.filter((r) => !r.passed);
  if (failedRows.length > 0) {
    console.log('\nFailures:');
    for (const r of failedRows) console.log(`  ${r.label}: ${r.failures.join('; ')}`);
  }
}

interface Environment {
  node: string;
  playwright: string;
  modelPath: string;
  timestampUtc: string;
  timestampSingapore: string;
}

function writeJsonReport(runs: RunResult[], faultCases: RunResult[], environment: Environment): string {
  const jsonPath = resolve(repoRoot, 'docs', 'evaluation-results.json');
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ runs, faultCases, environment }, null, 2)}\n`);
  return jsonPath;
}

function appendMarkdownReport(runs: RunResult[], faultCases: RunResult[], environment: Environment): string {
  const mdPath = resolve(repoRoot, 'docs', 'evaluation-results.md');
  const existing = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
  const isoDate = new Date().toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`## Measured demo runs (${isoDate})`);
  lines.push('');
  lines.push('All rows below are `demo` provenance: an owned, ephemeral demo storefront (ports 0), a real Playwright browser, and the real Worker/Store, timed with the system wall clock. Nothing here calls a real retailer.');
  lines.push('');
  lines.push(`Environment: node ${environment.node}, playwright ${environment.playwright}, model path: ${environment.modelPath}. Captured ${environment.timestampUtc} UTC / ${environment.timestampSingapore} Asia/Singapore.`);
  lines.push('');
  lines.push('| Run | Kind | Final state | Orders | Signal->ready (ms) | Observation->ready (ms) | Ticks | Wall (ms) | Result |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of [...runs, ...faultCases]) {
    lines.push(`| ${r.label} | ${r.kind} | ${r.finalState} | ${r.ordersCount} | ${fmtMs(r.signalToReadyMs)} | ${fmtMs(r.observationToReadyMs)} | ${r.ticks} | ${r.wallMs} | ${r.passed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('Fault case notes:');
  const faultA = faultCases.find((r) => r.kind === 'fault_add_to_cart_once');
  const faultB = faultCases.find((r) => r.kind === 'fault_delayed_confirmation');
  if (faultA) lines.push(`- \`failAddToCartOnce\` (A12/A14): addOneToCart called ${faultA.executorCounts.addOneToCart} time(s); the completed order's quantity stayed at 1.`);
  if (faultB) lines.push(`- \`delayedConfirmationMs\` (A19/A20): mission passed through UNKNOWN before reconciliation (${faultB.passedThroughUnknown ? 'yes' : 'no'}); submitDemoOrder called ${faultB.executorCounts.submitDemoOrder} time(s) (no blind resubmission).`);
  lines.push('');
  lines.push('Full machine-readable detail (per-run latency marks, provenance labels, executor call counts): `docs/evaluation-results.json`.');
  lines.push('');

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(mdPath, `${existing}${separator}\n${lines.join('\n')}\n`);
  return mdPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const dataRoot = resolve(repoRoot, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const runDir = mkdtempSync(join(dataRoot, 'run-demo-flows-'));
  const dbPath = join(runDir, 'demo-store.sqlite');

  console.log(`[run-demo-flows] ephemeral data dir: ${runDir}`);
  const demoStore = await startDemoStore({ storePort: 0, adminPort: 0, dbPath });
  console.log(`[run-demo-flows] demo store: storefront=${demoStore.storeOrigin} admin=${demoStore.adminOrigin} (agent-reachable origin is the storefront only)`);

  const browser = await createDemoBrowser({
    storeOrigin: demoStore.storeOrigin,
    headless: true,
    dataDir: runDir,
    onIncident: (incident) => console.warn(`[run-demo-flows] browser incident: ${incident.type} ${incident.detail}`),
  });

  const runs: RunResult[] = [];
  const faultCases: RunResult[] = [];
  let overallOk = true;

  try {
    for (let i = 1; i <= 5; i++) {
      console.log(`\n[run-demo-flows] measured run ${i}/5 ...`);
      const r = await runOneFlow({
        page: browser.page,
        demoStoreOrigin: demoStore.storeOrigin,
        demoAdminOrigin: demoStore.adminOrigin,
        label: `run-${i}`,
        kind: 'measured',
        faults: null,
        dataDir: runDir,
      });
      runs.push(r);
      if (!r.passed) overallOk = false;
      console.log(`[run-demo-flows] run ${i}: ${r.finalState}, orders=${r.ordersCount}, signal->ready=${fmtMs(r.signalToReadyMs)}ms, obs->ready=${fmtMs(r.observationToReadyMs)}ms, ${r.passed ? 'PASS' : `FAIL: ${r.failures.join('; ')}`}`);
    }

    console.log('\n[run-demo-flows] fault case: failAddToCartOnce (A12/A14) ...');
    const faultA = await runOneFlow({
      page: browser.page,
      demoStoreOrigin: demoStore.storeOrigin,
      demoAdminOrigin: demoStore.adminOrigin,
      label: 'fault-add-to-cart-once',
      kind: 'fault_add_to_cart_once',
      faults: { failAddToCartOnce: true },
      dataDir: runDir,
    });
    faultCases.push(faultA);
    if (!faultA.passed) overallOk = false;
    console.log(`[run-demo-flows] fault A: ${faultA.finalState}, orders=${faultA.ordersCount}, addToCartCalls=${faultA.executorCounts.addOneToCart}, ${faultA.passed ? 'PASS' : `FAIL: ${faultA.failures.join('; ')}`}`);

    console.log('\n[run-demo-flows] interruption case: delayedConfirmationMs (A19/A20) ...');
    const faultB = await runOneFlow({
      page: browser.page,
      demoStoreOrigin: demoStore.storeOrigin,
      demoAdminOrigin: demoStore.adminOrigin,
      label: 'fault-delayed-confirmation',
      kind: 'fault_delayed_confirmation',
      faults: { delayedConfirmationMs: DELAYED_CONFIRMATION_FAULT_MS },
      dataDir: runDir,
    });
    faultCases.push(faultB);
    if (!faultB.passed) overallOk = false;
    console.log(
      `[run-demo-flows] fault B: ${faultB.finalState}, orders=${faultB.ordersCount}, submitCalls=${faultB.executorCounts.submitDemoOrder}, passedThroughUnknown=${faultB.passedThroughUnknown}, ${faultB.passed ? 'PASS' : `FAIL: ${faultB.failures.join('; ')}`}`,
    );
  } finally {
    await browser.close();
    await demoStore.close();
    rmSync(runDir, { recursive: true, force: true });
  }

  const nowIso = new Date().toISOString();
  const environment: Environment = {
    node: process.version,
    playwright: readPlaywrightVersion(),
    modelPath: 'not used',
    timestampUtc: nowIso,
    timestampSingapore: sgLocalString(nowIso),
  };

  printTable([...runs, ...faultCases]);

  const jsonPath = writeJsonReport(runs, faultCases, environment);
  console.log(`\n[run-demo-flows] wrote ${jsonPath}`);
  const mdPath = appendMarkdownReport(runs, faultCases, environment);
  console.log(`[run-demo-flows] appended section to ${mdPath}`);

  if (!overallOk) {
    console.error('\n[run-demo-flows] FAILED: one or more runs did not meet acceptance criteria (see failures above)');
    process.exitCode = 1;
  } else {
    console.log('\n[run-demo-flows] All measured runs and fault cases passed.');
  }
}

main().catch((err: unknown) => {
  console.error('[run-demo-flows] fatal error:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
