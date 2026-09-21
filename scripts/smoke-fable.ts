/**
 * Phase 0 account smoke test (BTS_FABLE_BUILD_PLAN.md sections 5, 8, 13): a minimal
 * text request and a structured extraction of a synthetic dated announcement, run
 * against whichever provider/model/effort-or-thinking-level src/config.ts resolves from
 * the environment, optionally overridden with `--provider anthropic|gemini`.
 *
 * With no key for the selected provider this exits 2 before touching the network -- it
 * never silently substitutes an offline replay result for a live smoke test.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelClient, describeModelClient } from '../src/agent/modelClient.ts';
import { extractAnnouncement } from '../src/agent/extract.ts';
import { loadConfig } from '../src/config.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');
const evalLogPath = resolve(repoRoot, 'docs', 'evaluation-results.jsonl');

function appendResult(entry: Record<string, unknown>): void {
  mkdirSync(dirname(evalLogPath), { recursive: true });
  appendFileSync(evalLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function argValue(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

const argv = process.argv.slice(2);
const providerArg = argValue(argv, 'provider');
if (providerArg !== undefined && providerArg !== 'anthropic' && providerArg !== 'gemini') {
  console.error(`--provider must be "anthropic" or "gemini", got "${providerArg}"`);
  process.exit(2);
}

let cfg = loadConfig();
if (providerArg && providerArg !== cfg.modelProvider) {
  // Recompute (not mutate) so cfg.model/cfg.modelPath/cfg.geminiApiKey stay derived from the
  // overridden provider, exactly as if BTS_MODEL_PROVIDER had been set in the environment.
  cfg = loadConfig({ ...process.env, BTS_MODEL_PROVIDER: providerArg });
}

const requiredKeyName = cfg.modelProvider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
const selectedKey = cfg.modelProvider === 'gemini' ? cfg.geminiApiKey : cfg.apiKey;

if (!selectedKey) {
  console.error(`BLOCKED: ${requiredKeyName} not set; offline replay only`);
  process.exit(2);
}

const sdkPackageJson =
  cfg.modelProvider === 'gemini'
    ? resolve(repoRoot, 'node_modules', '@google', 'genai', 'package.json')
    : resolve(repoRoot, 'node_modules', '@anthropic-ai', 'sdk', 'package.json');
const sdkPackageName = cfg.modelProvider === 'gemini' ? '@google/genai' : '@anthropic-ai/sdk';
const sdkPackage = JSON.parse(readFileSync(sdkPackageJson, 'utf8')) as { version: string };

const client = createModelClient(cfg);
const description = describeModelClient(cfg);

console.log(`Fable client path: ${client.path}`);
console.log(`Provider: ${description.provider}`);
console.log(`${sdkPackageName} version: ${sdkPackage.version}`);
console.log(`Configured model: ${description.model}  ${description.detail}`);

let failures = 0;

// (a) minimal text request
const textResult = await client.runTask({
  name: 'smoke-minimal-text',
  system: 'You are being smoke-tested by the BTS build. Reply with exactly one word and nothing else.',
  messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
});

console.log('\n--- (a) minimal text request ---');
appendResult({ script: 'smoke-fable', task: 'smoke-minimal-text', provider: description.provider, sdkVersion: sdkPackage.version, detail: description.detail, path: client.path, result: textResult });

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
appendResult({ script: 'smoke-fable', task: 'extract-announcement', provider: description.provider, sdkVersion: sdkPackage.version, detail: description.detail, path: client.path, result: extraction });

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
