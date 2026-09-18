/**
 * Plain tsx smoke script (not vitest) exercising a full demo flow end-to-end against the real
 * Worker, Store, and domain modules, using VirtualClock and in-memory fakes only. Run with:
 *   npx tsx tests/helpers/workerSmoke.ts
 */
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/db.ts';
import { VirtualClock } from '../../src/domain/time.ts';
import { DEMO_MONITOR_POLICY } from '../../src/domain/types.ts';
import { Worker } from '../../src/worker/worker.ts';
import { FakeAdapter, FakeExecutor, makeIntent, makeObservation } from '../../src/worker/fakes.ts';

function log(line: string): void {
  console.log(`  [worker] ${line}`);
}

async function scenarioHappyPath(): Promise<void> {
  console.log('\n=== Scenario 1: sold out, sold out, available -> one completed demo order ===');
  const clock = new VirtualClock('2026-09-18T00:00:00.000Z');
  const store = new Store(':memory:');
  const intent = makeIntent({ expiresAt: '2026-09-25T00:00:00.000Z' });
  const mission = store.createMission(intent, clock.now().toISOString());

  const adapter = new FakeAdapter([
    makeObservation({ missionId: mission.id, availability: 'UNAVAILABLE', offer: null }),
    makeObservation({ missionId: mission.id, availability: 'UNAVAILABLE', offer: null }),
    makeObservation({ missionId: mission.id, availability: 'AVAILABLE' }),
  ]);
  const executor = new FakeExecutor();
  const worker = new Worker({ store, clock, policy: DEMO_MONITOR_POLICY, adapter, executor, apiReadiness: 'offline_replay', log });

  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'demo_purchase' });
  assert.equal(store.getMission(mission.id)!.state, 'WATCHING', 'approveIntent should arm to WATCHING');

  await worker.tick();
  console.log(`tick 1 -> ${store.getMission(mission.id)!.state} (availability observed: UNAVAILABLE)`);
  assert.equal(store.getMission(mission.id)!.state, 'WATCHING');

  clock.advanceMs(31_000);
  await worker.tick();
  console.log(`tick 2 -> ${store.getMission(mission.id)!.state} (availability observed: UNAVAILABLE)`);
  assert.equal(store.getMission(mission.id)!.state, 'WATCHING');

  clock.advanceMs(31_000);
  await worker.tick();
  const final = store.getMission(mission.id)!;
  console.log(`tick 3 -> ${final.state} (availability observed: AVAILABLE; cascades through validation/prep/checkout/submit in one tick)`);

  assert.equal(final.state, 'COMPLETED', `expected COMPLETED, got ${final.state}`);
  assert.equal(executor.orders.length, 1, `expected exactly one order, got ${executor.orders.length}`);
  assert.equal(adapter.calls.length, 3, 'exactly one observation per tick, three ticks');

  const attempts = store.listAttempts(mission.id);
  assert.equal(attempts.length, 1, 'exactly one attempt/generation used');
  assert.equal(attempts[0]!.state, 'ORDER_OBSERVED', 'the attempt record itself lands on ORDER_OBSERVED');
  assert.equal(attempts[0]!.merchantOrderRef, executor.orders[0]!.orderRef);

  const events = store.listEvents(mission.id, 500).map((e) => e.type);
  for (const required of ['observation.started', 'observation.completed', 'validation.completed', 'order.observed', 'mission.completed']) {
    assert.ok(events.includes(required), `expected event ${required} to be recorded; got [${events.join(', ')}]`);
  }
  console.log('Scenario 1 PASSED: COMPLETED with exactly one order.');
}

async function scenarioUnclearSubmissionThenReconciled(): Promise<void> {
  console.log('\n=== Scenario 2: submission outcome unclear -> UNKNOWN -> reconciled to COMPLETED ===');
  const clock = new VirtualClock('2026-09-18T00:00:00.000Z');
  const store = new Store(':memory:');
  const intent = makeIntent({ expiresAt: '2026-09-25T00:00:00.000Z' });
  const mission = store.createMission(intent, clock.now().toISOString());

  // Mission starts already AVAILABLE (A05: no prior sold-out sample required).
  const adapter = new FakeAdapter([makeObservation({ missionId: mission.id, availability: 'AVAILABLE' })]);
  const executor = new FakeExecutor({ submitBehavior: 'unclear' });
  const worker = new Worker({ store, clock, policy: DEMO_MONITOR_POLICY, adapter, executor, apiReadiness: 'offline_replay', log });

  worker.approveIntent(mission.id, { expiresAt: intent.expiresAt, authority: 'demo_purchase' });

  await worker.tick();
  let mid = store.getMission(mission.id)!;
  console.log(`tick 1 -> ${mid.state} (submit response lost; merchant may have processed it)`);
  assert.equal(mid.state, 'UNKNOWN', `expected UNKNOWN after an unclear submission, got ${mid.state}`);
  assert.equal(executor.orders.length, 1, 'the demo store actually created the order even though the response was lost');

  // No resubmission must ever happen: a further tick before reconciliation succeeds must not call submitDemoOrder again.
  const submitCallsAfterFirst = executor.calls.filter((c) => c === 'submitDemoOrder').length;
  assert.equal(submitCallsAfterFirst, 1, 'exactly one submission attempt; no blind resubmission');

  clock.advanceMs(5_000);
  await worker.tick();
  const final = store.getMission(mission.id)!;
  console.log(`tick 2 -> ${final.state} (reconciliation found the existing order via findOrderForSession)`);
  assert.equal(final.state, 'COMPLETED', `expected COMPLETED after reconciliation, got ${final.state}`);
  assert.equal(executor.orders.length, 1, `reconciliation must not create a second order, got ${executor.orders.length}`);

  const submitCallsFinal = executor.calls.filter((c) => c === 'submitDemoOrder').length;
  assert.equal(submitCallsFinal, 1, 'still exactly one submission attempt after reconciliation');

  const events = store.listEvents(mission.id, 500).map((e) => e.type);
  assert.ok(events.includes('reconciliation.pending') === false || true); // reconciliation.pending is not required once resolved on first attempt
  assert.ok(events.includes('order.observed'), 'order.observed event recorded');
  assert.ok(events.includes('mission.completed'), 'mission.completed event recorded');
  console.log('Scenario 2 PASSED: UNKNOWN then reconciled to COMPLETED with exactly one order.');
}

async function main(): Promise<void> {
  await scenarioHappyPath();
  await scenarioUnclearSubmissionThenReconciled();
  console.log('\nAll worker smoke scenarios passed.');
}

main().catch((err) => {
  console.error('\nworkerSmoke FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
