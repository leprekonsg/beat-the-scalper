/**
 * Small Fable evaluation (BTS_FABLE_BUILD_PLAN.md sections 8, 14): runs the
 * announcement extraction on the synthetic dated text and on the user-supplied
 * reference restock-alert screenshot at each requested effort level, asserting:
 *
 *  - A06: the screenshot extraction never invents an absolute restock time
 *    (releaseDateLocal stays null) while preserving the verbatim relative-age text.
 *  - A09: the stated wrapping-removal notice is surfaced as packagingCondition
 *    "stated_removed".
 *
 * Usage: tsx scripts/eval-fable.ts [--effort high,medium,low] [--model <id>]
 * Without ANTHROPIC_API_KEY, every run uses the offline replay path and every
 * appended result line is labelled "offline_replay".
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFableClient, type TaskResult } from '../src/agent/client.ts';
import { extractAnnouncement } from '../src/agent/extract.ts';
import { loadConfig } from '../src/config.ts';
import type { AnnouncementExtraction } from '../src/domain/types.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');
const evalLogPath = resolve(repoRoot, 'docs', 'evaluation-results.jsonl');

function argValue(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function appendResult(entry: Record<string, unknown>): void {
  mkdirSync(dirname(evalLogPath), { recursive: true });
  appendFileSync(evalLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function logAndRecord(task: string, effort: string, path: 'live' | 'offline_replay', result: TaskResult<AnnouncementExtraction>, elapsedMsWall: number): void {
  if (result.ok) {
    console.log(
      `${task} [${effort}]: ok tokens(in=${result.usage.inputTokens},out=${result.usage.outputTokens}) ` +
        `elapsedMs(client)=${result.usage.elapsedMs} elapsedMs(wall)=${elapsedMsWall} ` +
        `cost=${result.usage.estimatedCostUsd ?? 'unknown (upper-bound estimate not available for this model)'} provenance=${result.provenance}`,
    );
  } else {
    console.log(`${task} [${effort}]: FAILED reason=${result.reason} detail=${result.detail}`);
  }
  appendResult({ script: 'eval-fable', task, effort, path, elapsedMsWall, result });
}

const cfg = loadConfig();
const argv = process.argv.slice(2);
const effortArg = argValue(argv, 'effort') ?? 'high';
const efforts = effortArg.split(',').map((s) => s.trim());
for (const e of efforts) {
  if (e !== 'low' && e !== 'medium' && e !== 'high') {
    console.error(`--effort must be a comma-separated list of low|medium|high, got "${e}"`);
    process.exit(2);
  }
}
const resolvedModel = argValue(argv, 'model') ?? cfg.model;

const SYNTHETIC_TEXT =
  'Pokemon TCG: Scarlet & Violet-151 Elite Trainer Box launches 25 September 2026, live from 10:00am Singapore time, exclusively on our official Lazada store. Limit one per customer.';
const screenshotPng = readFileSync(resolve(repoRoot, 'fixtures', 'reference-restock-alerts.png'));

let failures = 0;

for (const effort of efforts as ('low' | 'medium' | 'high')[]) {
  const client = createFableClient({
    apiKey: cfg.apiKey,
    model: resolvedModel,
    effort,
    maxToolCalls: cfg.agentMaxToolCalls,
    maxSeconds: cfg.agentMaxSeconds,
    showModelUpdates: false,
  });

  console.log(`\n=== effort=${effort} path=${client.path} model=${resolvedModel} ===`);

  const textStart = Date.now();
  const textResult = await extractAnnouncement(client, { evidenceId: 'evd_eval_synthetic_announcement', text: SYNTHETIC_TEXT });
  logAndRecord('extract-announcement-text', effort, client.path, textResult, Date.now() - textStart);

  const imgStart = Date.now();
  const imgResult = await extractAnnouncement(client, { evidenceId: 'evd_eval_reference_restock_alerts', imagePng: screenshotPng });
  logAndRecord('extract-announcement-screenshot', effort, client.path, imgResult, Date.now() - imgStart);

  if (imgResult.ok) {
    const relativeAgePreserved = typeof imgResult.output.relativeAge.value === 'string' && imgResult.output.relativeAge.value.trim().length > 0;
    const a06 = imgResult.output.releaseDateLocal.value === null && relativeAgePreserved;
    const a09 = imgResult.output.packagingCondition.value === 'stated_removed';
    console.log(`A06 (no invented absolute restock time; relative age preserved): ${a06 ? 'PASS' : 'FAIL'}`);
    console.log(`A09 (packaging removal notice surfaced as stated_removed): ${a09 ? 'PASS' : 'FAIL'}`);
    if (!a06 || !a09) failures += 1;
    appendResult({ script: 'eval-fable', task: 'A06_A09_assertions', effort, path: client.path, model: resolvedModel, a06, a09 });
  } else {
    console.log(`A06/A09 cannot be asserted for effort=${effort}: screenshot extraction did not succeed (${imgResult.reason}).`);
    failures += 1;
  }
}

console.log(`\nEvaluation complete: ${failures} failing effort run(s) out of ${efforts.length}. Logged to ${evalLogPath}`);
if (failures > 0) process.exit(1);
