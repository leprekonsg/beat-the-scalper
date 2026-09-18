/**
 * Phase 0 account smoke test (BTS_FABLE_BUILD_PLAN.md sections 5, 8, 13): a minimal
 * text request and a structured extraction of a synthetic dated announcement, run
 * against whatever model/effort src/config.ts resolves from the environment.
 *
 * With no ANTHROPIC_API_KEY this exits 2 before touching the network -- it never
 * silently substitutes an offline replay result for a live smoke test.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFableClient } from '../src/agent/client.ts';
import { extractAnnouncement } from '../src/agent/extract.ts';
import { loadConfig } from '../src/config.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');
const evalLogPath = resolve(repoRoot, 'docs', 'evaluation-results.jsonl');

function appendResult(entry: Record<string, unknown>): void {
  mkdirSync(dirname(evalLogPath), { recursive: true });
  appendFileSync(evalLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const cfg = loadConfig();

if (!cfg.apiKey) {
  console.error('BLOCKED: ANTHROPIC_API_KEY not set; offline replay only');
  process.exit(2);
}

const sdkPackage = JSON.parse(readFileSync(resolve(repoRoot, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8')) as { version: string };

const client = createFableClient({
  apiKey: cfg.apiKey,
  model: cfg.model,
  effort: cfg.effort,
  maxToolCalls: cfg.agentMaxToolCalls,
  maxSeconds: cfg.agentMaxSeconds,
  showModelUpdates: cfg.showModelUpdates,
});

console.log(`Fable client path: ${client.path}`);
console.log(`@anthropic-ai/sdk version: ${sdkPackage.version}`);
console.log(`Configured model: ${cfg.model}  Effort: ${cfg.effort}`);

let failures = 0;

// (a) minimal text request
const textResult = await client.runTask({
  name: 'smoke-minimal-text',
  system: 'You are being smoke-tested by the BTS build. Reply with exactly one word and nothing else.',
  messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
});

console.log('\n--- (a) minimal text request ---');
appendResult({ script: 'smoke-fable', task: 'smoke-minimal-text', sdkVersion: sdkPackage.version, effort: cfg.effort, path: client.path, result: textResult });

if (!textResult.ok) {
  console.error(`FAILED: ${textResult.reason} - ${textResult.detail}`);
  failures += 1;
} else {
  console.log(`Model id from response: ${textResult.model}`);
  console.log(`stop_reason: ${textResult.stopReason}`);
  console.log(`Response text: ${textResult.text.trim()}`);
  console.log(`usage: ${JSON.stringify(textResult.usage)}`);
}

// (b) structured extraction of a synthetic dated announcement
const extraction = await extractAnnouncement(client, {
  evidenceId: 'evd_smoke_synthetic_announcement',
  text: 'Pokemon TCG: Scarlet & Violet-151 Elite Trainer Box launches 25 September 2026, live from 10:00am Singapore time, exclusively on our official Lazada store. Limit one per customer.',
});

console.log('\n--- (b) structured extraction ---');
appendResult({ script: 'smoke-fable', task: 'extract-announcement', sdkVersion: sdkPackage.version, effort: cfg.effort, path: client.path, result: extraction });

if (!extraction.ok) {
  console.error(`FAILED: ${extraction.reason} - ${extraction.detail}`);
  failures += 1;
} else {
  console.log(`Model id from response: ${extraction.model}`);
  console.log(`stop_reason: ${extraction.stopReason}`);
  console.log(`dateBasis: ${extraction.output.dateBasis}  releaseDateLocal: ${extraction.output.releaseDateLocal.value}`);
  console.log(`usage: ${JSON.stringify(extraction.usage)}`);
}

console.log(`\nSmoke test ${failures === 0 ? 'complete' : 'completed with failures'}. Logged to ${evalLogPath}`);
if (failures > 0) process.exit(1);
