/**
 * Offline replay: shared between every FableClient implementation (Anthropic, Gemini, ...) so the
 * fixture format, labels, and failure wording stay identical no matter which live provider a task
 * would otherwise use. This module never reaches the network -- it is the entire code path taken
 * when a provider's API key is absent (BTS_FABLE_BUILD_PLAN.md section 8, acceptance case A24).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskResult, TaskSpec, TaskUsage } from './client.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function zeroUsage(): TaskUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCalls: 0,
    elapsedMs: 0,
    estimatedCostUsd: null,
  };
}

/** Generic, provider-agnostic error description: `${err.name}: ${err.message}` or `String(err)`. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function defaultReplayDir(): string {
  return resolve(moduleDir, '../../fixtures/replay');
}

export async function runOfflineReplay<T>(task: TaskSpec<T>, replayDir: string): Promise<TaskResult<T>> {
  const usage = zeroUsage();
  const file = resolve(replayDir, `${task.name}.json`);
  if (!existsSync(file)) {
    return { ok: false, reason: 'api_error', detail: `No offline replay fixture for task "${task.name}" at ${file}`, usage, provenance: 'offline_replay' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'api_error', detail: `Offline replay fixture ${file} is not valid JSON: ${describeError(err)}`, usage, provenance: 'offline_replay' };
  }
  const fixture = parsed as { label?: string; output?: unknown; usage?: Partial<TaskUsage> };
  const label = fixture.label ?? 'Offline replay fixture - not a live Fable run';
  if (fixture.usage) Object.assign(usage, fixture.usage);
  const payload = fixture.output ?? parsed;

  if (task.outputSchema) {
    const result = task.outputSchema.safeParse(payload);
    if (!result.success) {
      return {
        ok: false,
        reason: 'invalid_output',
        detail: `Offline replay fixture ${file} failed schema validation: ${result.error.message}`,
        usage,
        provenance: 'offline_replay',
      };
    }
    return { ok: true, output: result.data, text: JSON.stringify(result.data), usage, provenance: 'offline_replay', stopReason: 'end_turn', model: null, label };
  }
  return { ok: true, output: payload as T, text: JSON.stringify(payload), usage, provenance: 'offline_replay', stopReason: 'end_turn', model: null, label };
}
