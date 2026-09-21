/**
 * Supervised, observe-only Gemini computer-use session on a single user-supplied Lazada
 * product URL (src/agent/geminiComputerUse.ts). Gemini may only scroll/move/wait/screenshot
 * a real Chromium page; it never clicks, types, logs in, adds to cart, or buys -- every
 * function_call the model emits is re-checked against that surface in code (A17 parity),
 * same philosophy as the Anthropic-only RestrictedBrowserExecutor's lazada_observe mode.
 *
 * Requires explicit per-run permission (--approved "<who/when>") exactly like
 * scripts/lazada-probe.ts, and refuses to run without GEMINI_API_KEY: unlike the rest of the
 * Gemini path, there is no offline replay for a live computer-use session driving a real page.
 *
 * Usage: tsx scripts/lazada-gemini-observe.ts --url=<lazada url> --approved "<note>"
 *          [--thinking low|medium|high] [--max-turns N]
 */
import { chromium } from 'playwright';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runGeminiComputerUseObservation } from '../src/agent/geminiComputerUse.ts';

const evalLogPath = resolve(process.cwd(), 'docs', 'evaluation-results.jsonl');

function argValue(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function appendEvalResult(entry: Record<string, unknown>): void {
  mkdirSync(resolve(process.cwd(), 'docs'), { recursive: true });
  appendFileSync(evalLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const argv = process.argv.slice(2);
const urlArg = argv.find((a) => a.startsWith('--url='))?.slice(6);
const approvedIdx = argv.indexOf('--approved');
const approvedBy = approvedIdx >= 0 ? argv[approvedIdx + 1] : null;

if (!urlArg || !approvedBy) {
  console.error('Usage: tsx scripts/lazada-gemini-observe.ts --url=<lazada url> --approved "<who granted permission and when>" [--thinking low|medium|high] [--max-turns N]');
  console.error('This script performs live retailer access via a Gemini-driven browser session. It refuses to run without an explicit approval note.');
  process.exit(2);
}

const target = new URL(urlArg);
if (!/(^|\.)lazada\.sg$/.test(target.hostname)) {
  console.error(`Refusing: host ${target.hostname} is not a lazada.sg host`);
  process.exit(2);
}

const thinkingArg = argValue(argv, 'thinking');
if (thinkingArg !== undefined && thinkingArg !== 'low' && thinkingArg !== 'medium' && thinkingArg !== 'high') {
  console.error(`--thinking must be "low", "medium", or "high", got "${thinkingArg}"`);
  process.exit(2);
}
const maxTurnsArg = argValue(argv, 'max-turns');
let maxTurns: number | undefined;
if (maxTurnsArg !== undefined) {
  maxTurns = Number.parseInt(maxTurnsArg, 10);
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    console.error(`--max-turns must be a positive integer, got "${maxTurnsArg}"`);
    process.exit(2);
  }
}

// The first loadConfig() call populates process.env from .env (config.ts's dotenv loader never
// overwrites an already-set variable); the second call re-derives model/apiKey fields for the
// gemini provider from that now-populated environment, exactly as if BTS_MODEL_PROVIDER=gemini
// had been set (see scripts/eval-fable.ts for the same pattern).
loadConfig();
const cfg = loadConfig({ ...process.env, BTS_MODEL_PROVIDER: 'gemini' });

if (!cfg.geminiApiKey) {
  console.error('BLOCKED: GEMINI_API_KEY not set; this script has no offline replay because it drives a live page');
  process.exit(2);
}

const thinkingLevel = thinkingArg ?? cfg.geminiThinkingLevel;

const outDir = resolve(process.cwd(), 'data', 'feasibility');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profileDir = resolve(process.cwd(), 'data', '.browser-profiles', 'lazada-probe');

const GOAL =
  'Observe this Lazada product page. Scroll as needed to see the product title, seller name and any seller badges, the price, whether Add to Cart and Buy Now controls are visible, any purchase limit text, and any packaging or outer-wrap notice printed on the product artwork or images. Do not click, type, log in, or navigate anywhere. When you are done, report your findings in the required JSON format only.';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1280, height: 900 },
  locale: 'en-SG',
  timezoneId: 'Asia/Singapore',
});
const page = context.pages()[0] ?? (await context.newPage());

const record: Record<string, unknown> = {
  script: 'lazada-gemini-observe',
  approvedBy,
  requestedUrl: target.toString(),
  model: cfg.geminiModel,
  thinkingLevel,
  startedAt: new Date().toISOString(),
};

let exitCode = 0;

try {
  await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000); // allow client rendering; no reloads

  const result = await runGeminiComputerUseObservation({
    apiKey: cfg.geminiApiKey,
    model: cfg.geminiModel,
    thinkingLevel,
    page,
    goal: GOAL,
    allowedHosts: ['lazada.sg'],
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    screenshotSink: (turn, png) => {
      writeFileSync(resolve(outDir, `lazada-gemini-observe-${stamp}-turn${turn}.png`), png);
    },
    onIncident: (kind, detail) => {
      console.log(`[incident] ${kind}: ${detail}`);
    },
    onTurn: (info) => {
      console.log(`[turn ${info.turn}] actions=${info.actions.join(',') || '(none)'} url=${info.url}`);
    },
  });

  Object.assign(record, {
    ok: result.ok,
    finalUrl: result.finalUrl,
    turns: result.turns,
    actions: result.actions,
    incidents: result.incidents,
    usage: result.usage,
    ...(result.ok ? { report: result.report } : { reason: result.reason, detail: result.detail }),
    finishedAt: new Date().toISOString(),
  });

  console.log(`\nObservation ${result.ok ? 'completed' : 'FAILED'} in ${result.turns} turn(s).`);
  console.log(`Final URL: ${result.finalUrl}`);
  console.log(`Incidents: ${result.incidents.length === 0 ? 'none' : result.incidents.map((i) => i.kind).join(', ')}`);
  console.log(`Usage: ${JSON.stringify(result.usage)}`);
  if (result.ok) {
    console.log(`Report: ${JSON.stringify(result.report, null, 2)}`);
  } else {
    console.error(`FAILED: reason=${result.reason} detail=${result.detail}`);
    exitCode = 1;
  }

  appendEvalResult({
    script: 'lazada-gemini-observe',
    provider: 'gemini',
    path: 'live',
    model: cfg.geminiModel,
    thinkingLevel,
    turns: result.turns,
    ok: result.ok,
    ...(result.ok ? { report: result.report } : { reason: result.reason }),
    actions: result.actions,
    incidents: result.incidents,
    usage: result.usage,
    approvedBy,
  });
} catch (err) {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`FAILED: unhandled error - ${detail}`);
  Object.assign(record, { ok: false, error: detail, finishedAt: new Date().toISOString() });
  appendEvalResult({ script: 'lazada-gemini-observe', provider: 'gemini', path: 'live', model: cfg.geminiModel, thinkingLevel, ok: false, reason: 'api_error', approvedBy });
  exitCode = 1;
} finally {
  await context.close();
}

const jsonPath = resolve(outDir, `lazada-gemini-observe-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(record, null, 2));
console.log(`Saved ${jsonPath}`);

process.exit(exitCode);
