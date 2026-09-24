/**
 * Alert timing drill: measures the two catch-rate inputs that no BTS read can measure.
 *
 *  - Delivery: send -> webhook accepted (`WebhookNotifier`, the exact path a real alert takes, same
 *    urgent priority, titled as a drill), and for an ntfy topic send -> received by a subscriber on
 *    this machine (the server fan-out every phone push starts from).
 *  - With --manual: send -> you press Enter when the phone shows it (delivery to your hand), then,
 *    with --click-url, alert -> you press Enter on Lazada's payment page (time to buy; do not pay).
 *
 * BTS itself never loads a retailer page here. With --click-url your phone opens that listing when
 * you tap the alert; that visit is yours.
 *
 * Usage:
 *   npm run alert:drill -- [--count=<1..10, default 3>] [--gap-seconds=<int, default 15>] [--manual]
 *     [--click-url=<listing you will open on your phone>] [--pipeline-ms=<int, default 6300 (Run 7 p95)>]
 *
 * Needs BTS_ALERT_WEBHOOK_URL in .env (e.g. https://ntfy.sh/<your-topic>). Writes
 * data/feasibility/alert-drill-<stamp>.json and appends docs/evaluation-results.jsonl.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { catchProbability, p50, p95, summarizeTimings } from '../src/eval/reactionStats.ts';
import { WebhookNotifier } from '../src/worker/notifier.ts';

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1]!.startsWith('--')) return argv[idx + 1];
  return undefined;
}
function usageAndExit(message: string): never {
  console.error(message);
  console.error('Usage: tsx scripts/alert-drill.ts [--count=<1..10>] [--gap-seconds=<int>] [--manual] [--click-url=<url>] [--pipeline-ms=<int>]');
  process.exit(2);
}
function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(name);
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) usageAndExit(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}

const count = intArg('count', 3, 1, 10);
const gapSeconds = intArg('gap-seconds', 15, 5, 600);
const pipelineMs = intArg('pipeline-ms', 6300, 0, 120_000);
const manual = argv.includes('--manual');
const clickUrl = argValue('click-url') ?? null;
if (clickUrl !== null) {
  try {
    new URL(clickUrl);
  } catch {
    usageAndExit(`Invalid --click-url "${clickUrl}"`);
  }
}

const config = loadConfig();
if (!config.alertWebhookUrl) {
  usageAndExit('BTS_ALERT_WEBHOOK_URL is not set. Add it to .env, e.g. BTS_ALERT_WEBHOOK_URL=https://ntfy.sh/<a long random topic>, and subscribe to that topic in the ntfy phone app.');
}
const webhookUrl = config.alertWebhookUrl;

/** ntfy publishes to https://host/<topic>; its JSON stream is https://host/<topic>/json. */
function ntfyStreamUrl(url: string): string | null {
  const u = new URL(url);
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length !== 1 || u.search !== '') return null;
  return `${u.origin}/${segments[0]}/json`;
}

/** Subscribes before the first send; `waitFor(nonce)` resolves with the receive instant, or null on timeout. */
async function openSubscriber(streamUrl: string): Promise<{ waitFor: (nonce: string, timeoutMs: number) => Promise<number | null>; close: () => void } | null> {
  const controller = new AbortController();
  const seen = new Map<string, number>();
  const waiters = new Map<string, (t: number) => void>();
  let res: Response;
  try {
    res = await fetch(streamUrl, { signal: controller.signal });
  } catch (err) {
    console.error(`Subscriber not opened (${err instanceof Error ? err.message : String(err)}); fan-out will be n/a.`);
    return null;
  }
  if (!res.ok || !res.body) {
    console.error(`Subscriber not opened (HTTP ${res.status}); fan-out will be n/a.`);
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const at = performance.now();
          try {
            const msg = JSON.parse(line) as { event?: string; message?: string };
            if (msg.event !== 'message' || typeof msg.message !== 'string') continue;
            const nonce = /drill-([0-9a-f]{8})/.exec(msg.message)?.[1];
            if (!nonce) continue;
            seen.set(nonce, at);
            waiters.get(nonce)?.(at);
          } catch {
            /* keepalive or partial line */
          }
        }
      }
    } catch {
      /* aborted on close */
    }
  })();
  return {
    waitFor: (nonce, timeoutMs) =>
      new Promise((done) => {
        const already = seen.get(nonce);
        if (already !== undefined) return done(already);
        const timer = setTimeout(() => done(null), timeoutMs);
        waiters.set(nonce, (t) => {
          clearTimeout(timer);
          done(t);
        });
      }),
    close: () => controller.abort(),
  };
}

interface DrillRecord {
  index: number;
  sentAt: string;
  acceptedMs: number | null;
  fanoutMs: number | null;
  phoneMs: number | null;
  /** Phone shows the alert -> you reach the payment page. */
  buyMs: number | null;
  error: string | null;
}

async function main(): Promise<void> {
  const notifier = new WebhookNotifier(webhookUrl, fetch, 15_000);
  const streamUrl = ntfyStreamUrl(webhookUrl);
  const subscriber = streamUrl ? await openSubscriber(streamUrl) : null;
  const rl = manual ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const records: DrillRecord[] = [];

  if (manual) {
    console.log('Keep your phone in hand, screen off. After each alert: press Enter the moment the phone shows it.');
    if (clickUrl) console.log('Then tap the alert, go to Lazada checkout as if buying, and press Enter on the payment page. Do not pay.');
  }

  try {
    for (let i = 1; i <= count; i++) {
      const nonce = randomUUID().slice(0, 8);
      const sentAt = new Date().toISOString();
      const t0 = performance.now();
      const fanoutPromise = subscriber ? subscriber.waitFor(nonce, 30_000) : Promise.resolve(null);
      const rec: DrillRecord = { index: i, sentAt, acceptedMs: null, fanoutMs: null, phoneMs: null, buyMs: null, error: null };
      try {
        await notifier.notify({
          kind: 'go',
          drill: true,
          missionId: 'drill',
          headline: `Drill ${i}/${count}: test alert, not a restock (drill-${nonce})`,
          details: clickUrl ? ['Tap, go to the payment page, do not pay'] : [],
          productUrl: clickUrl,
          at: sentAt,
        });
        rec.acceptedMs = Math.round(performance.now() - t0);
      } catch (err) {
        rec.error = err instanceof Error ? err.message : String(err);
      }
      if (rl && rec.error === null) {
        await rl.question(`[${i}/${count}] sent. Enter when the phone shows it: `);
        rec.phoneMs = Math.round(performance.now() - t0);
        if (clickUrl) {
          const shown = performance.now();
          await rl.question(`[${i}/${count}] Enter on the payment page (do not pay): `);
          rec.buyMs = Math.round(performance.now() - shown);
        }
      }
      const fanoutAt = await fanoutPromise;
      rec.fanoutMs = fanoutAt === null ? null : Math.round(fanoutAt - t0);
      records.push(rec);
      console.log(`[${i}/${count}] accepted=${rec.acceptedMs ?? 'n/a'}ms fanout=${rec.fanoutMs ?? 'n/a'}ms phone=${rec.phoneMs ?? 'n/a'}ms buy=${rec.buyMs ?? 'n/a'}ms${rec.error ? ` error=${rec.error}` : ''}`);
      if (i < count) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
    }
  } finally {
    rl?.close();
    subscriber?.close();
  }

  const nums = (xs: (number | null)[]): number[] => xs.filter((v): v is number => v !== null);
  const phone = nums(records.map((r) => r.phoneMs));
  const buy = nums(records.map((r) => r.buyMs));
  // Delivery after the alert fires, then the buy itself, both at p95: the catch table below uses them.
  const deliveryP95 = p95(phone) ?? p95(nums(records.map((r) => r.fanoutMs))) ?? p95(nums(records.map((r) => r.acceptedMs)));
  const buyP95 = p95(buy);
  const catchTable =
    deliveryP95 === null || buyP95 === null
      ? null
      : [30, 45, 60].flatMap((selloutSeconds) =>
          [60, 120].map((cadenceSeconds) => ({
            selloutSeconds,
            cadenceSeconds,
            catch: catchProbability({ cadenceSeconds, selloutSeconds, pipelineMs: pipelineMs + deliveryP95, humanActionSeconds: buyP95 / 1000 }),
          })),
        );

  const summary = {
    acceptedMs: summarizeTimings(nums(records.map((r) => r.acceptedMs))),
    fanoutMs: summarizeTimings(nums(records.map((r) => r.fanoutMs))),
    phoneMs: summarizeTimings(phone),
    buyMs: summarizeTimings(buy),
    buyP50Ms: p50(buy),
    catchTable,
    catchAssumptions: { alertPipelineMs: pipelineMs, deliveryP95Ms: deliveryP95, buyP95Ms: buyP95, note: 'Polling alone; sell-out values are assumptions until restock.ended episodes are recorded.' },
    failures: records.filter((r) => r.error !== null).length,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(resolve(process.cwd(), 'data', 'feasibility'), { recursive: true });
  const jsonPath = resolve(process.cwd(), 'data', 'feasibility', `alert-drill-${stamp}.json`);
  const webhookHost = new URL(webhookUrl).host; // the topic is a secret-by-obscurity; never recorded
  writeFileSync(jsonPath, JSON.stringify({ script: 'alert-drill', webhookHost, manual, clickUrlSet: clickUrl !== null, count, gapSeconds, records, summary }, null, 2));
  appendFileSync(resolve(process.cwd(), 'docs', 'evaluation-results.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), script: 'alert-drill', path: 'live', webhookHost, manual, count, summary })}\n`);

  console.log(`\nSummary: ${JSON.stringify(summary, null, 2)}`);
  console.log(`Wrote ${jsonPath}`);
  process.exitCode = summary.failures > 0 ? 3 : 0;
}

main().catch((err: unknown) => {
  console.error('[alert-drill] fatal error:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
