/**
 * GeminiClient: a bounded, single-task alternative to the Anthropic FableClient
 * (./client.ts) for `gemini-3.8-flash`, selected by `BTS_MODEL_PROVIDER=gemini`. It
 * implements the same `FableClient` contract so `extractAnnouncement` (agent/extract.ts)
 * and `FableOfferInterpreter` (agent/assess.ts) work unchanged. Like the Anthropic
 * client, every call to `runTask()` is a fresh, bounded request built from
 * `task.messages` -- it never continues a prior task's history (BTS_FABLE_BUILD_PLAN.md
 * section 8).
 *
 * Why the Interactions API, not legacy `generateContent`: `@google/genai` 2.x is
 * Interactions-first -- `client.interactions.create()` is the current, actively
 * documented request/response surface for Gemini 3.x models. `models.generateContent`
 * is the legacy content-generation API kept for older model families; this client never
 * calls it.
 *
 * Why `store: false` on every call: interactions are stored server-side by default. BTS
 * evidence -- pasted announcement text and uploaded screenshots -- must never be
 * retained by the provider, so `store: false` is sent explicitly on every request.
 *
 * Why no `previous_interaction_id` / `background`: each task here is a fresh, bounded
 * conversation built from validated database state and never continues a prior task's
 * history, live or offline (see ./client.ts's header comment). `previous_interaction_id`
 * would splice a previous call's server-side state into a new one; `background` is for
 * long-running async work this codebase never does.
 *
 * Unsupported task shapes, all rejected before any network call:
 *  - Any `assistant` message in `task.messages` (see `toGeminiInput`).
 *  - A `tool_result` content block, or an image block whose source is not base64.
 *  - `task.tools` or `task.browserExecutor`: the restricted browser toolset
 *    (BrowserToolset20260801) is an Anthropic-specific integration used only behind the
 *    gated `lazada_observe` path. Tool-using tasks must use `BTS_MODEL_PROVIDER=anthropic`.
 */
import { GoogleGenAI } from '@google/genai';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import type { Clock } from '../domain/time.ts';
import { SystemClock } from '../domain/time.ts';
import type { FableClient, TaskResult, TaskSpec, TaskUsage } from './client.ts';
import { defaultReplayDir, describeError, runOfflineReplay, zeroUsage } from './replay.ts';

/**
 * Verified first-party pricing (USD per 1M tokens). Introductory pricing applies through
 * 2026-12-31; standard pricing from 2027-01-01 is $1.50 input / $7.50 output. This table
 * intentionally lists only `gemini-3.8-flash` -- never invent a price for another Gemini
 * model; `estimateGeminiCostUsd` returns null instead, matching the Anthropic client's
 * behaviour for a model absent from its own pricing table.
 */
const GEMINI_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
};

/** Exported so `geminiComputerUse.ts` prices computer-use runs with the same verified table instead of inventing its own. */
export function estimateGeminiCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = GEMINI_PRICING_PER_MILLION[model];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export interface GeminiClientConfig {
  apiKey: string | null;
  model: string;
  /** 3.8 Flash rejects 'minimal'; 'low' is the speed-oriented default (see src/config.ts). */
  thinkingLevel: 'low' | 'medium' | 'high';
  maxSeconds: number;
  clock?: Clock;
  /** Overrides the default `fixtures/replay` directory; primarily for tests. */
  replayDir?: string;
  /** Injectable for tests; defaults to `new GoogleGenAI({ apiKey }).interactions`. */
  interactions?: { create: (params: unknown) => Promise<unknown> };
}

/**
 * Zod schema -> JSON Schema accepted by `response_format.schema`. Gemini's structured
 * output supports minimum/maximum, enum, anyOf, additionalProperties, and $ref (unlike
 * the Anthropic endpoint), so the only keyword stripped is the meta-schema pointer
 * itself, which Gemini does not expect to see inside the schema body. Do not reuse the
 * Anthropic `toStructuredOutputSchema` keyword stripper here -- it removes keywords
 * Gemini actually supports.
 */
export function toGeminiOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = json;
  return rest;
}

export type GeminiContentPart = { type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string };

export type GeminiInputResult = { ok: true; input: GeminiContentPart[] } | { ok: false; detail: string };

/**
 * Pure converter from the Anthropic-shaped `MessageParam[]` wire format (shared with the
 * Anthropic client) to the flat Content-part array the Interactions API accepts as
 * `input`. Never performs I/O. Only `user` messages, string/text content, and
 * base64-sourced images are supported; anything else is reported as `ok: false` so the
 * caller can return a `blocked` result before any network call. Exported for tests.
 */
export function toGeminiInput(messages: MessageParam[]): GeminiInputResult {
  const parts: GeminiContentPart[] = [];
  for (const message of messages) {
    if (message.role !== 'user') {
      return {
        ok: false,
        detail: `Gemini provider only supports single-turn user messages; received a "${message.role}" message (the Gemini path never continues a prior task's history)`,
      };
    }
    if (typeof message.content === 'string') {
      parts.push({ type: 'text', text: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        if (block.source.type !== 'base64') {
          return { ok: false, detail: `Gemini provider only supports base64-encoded images; received a "${block.source.type}" image source` };
        }
        parts.push({ type: 'image', data: block.source.data, mime_type: block.source.media_type });
      } else {
        return { ok: false, detail: `Gemini provider does not support "${block.type}" content blocks` };
      }
    }
  }
  return { ok: true, input: parts };
}

/**
 * Up to 2 retries on 429/5xx and on any connection-level throw. The SDK throws error
 * subclasses (e.g. `BadRequestError`) that are NOT `instanceof` the exported `ApiError`, so
 * this duck-types a numeric `status` off the thrown value instead of relying on `instanceof`:
 * when a numeric status is present, only 429/5xx are retryable (never other 4xx statuses);
 * when absent, the throw is treated as connection-level (@google/genai 2.22.0 does not export
 * ConnectionError/RequestTimeoutError) and retried.
 */
function isRetryableGeminiError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true;
}

interface GeminiStatus {
  message?: string;
  code?: number;
}

interface GeminiContentBlock {
  type: string;
  text?: string;
}

interface GeminiModelOutputStep {
  type: 'model_output';
  content?: GeminiContentBlock[];
  error?: GeminiStatus;
}

interface GeminiStep {
  type: string;
  content?: GeminiContentBlock[];
  error?: GeminiStatus;
}

interface GeminiUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
  total_tokens?: number;
}

interface GeminiInteractionResponse {
  id: string;
  status: string;
  model?: string;
  steps?: GeminiStep[];
  output_text?: string;
  usage?: GeminiUsage;
}

function findLastModelOutputStep(steps: GeminiStep[]): GeminiModelOutputStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.type === 'model_output') return step as GeminiModelOutputStep;
  }
  return undefined;
}

function extractText(response: GeminiInteractionResponse, lastModelOutput: GeminiModelOutputStep | undefined): string {
  if (response.output_text) return response.output_text;
  if (!lastModelOutput?.content) return '';
  return lastModelOutput.content
    .filter((c): c is GeminiContentBlock & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** Interactions API errors present a description as {message, code}; format defensively since the shape is loosely typed on our injected boundary. */
function describeStatus(status: GeminiStatus): string {
  return status.message ?? JSON.stringify(status);
}

function defaultInteractions(apiKey: string): { create: (params: unknown) => Promise<unknown> } {
  const client = new GoogleGenAI({ apiKey });
  // The real SDK method's parameter type is narrower than `unknown`; this boundary cast is
  // intentional so tests can inject a fake `{ create }` without depending on SDK request types.
  return client.interactions as unknown as { create: (params: unknown) => Promise<unknown> };
}

/** Never call the API without a key: offline replay is a fully separate code path that cannot reach `interactions.create`. */
export function createGeminiClient(cfg: GeminiClientConfig): FableClient {
  const path: 'live' | 'offline_replay' = cfg.apiKey ? 'live' : 'offline_replay';
  const replayDir = cfg.replayDir ?? defaultReplayDir();

  if (path === 'offline_replay') {
    return {
      path,
      runTask<T>(task: TaskSpec<T>): Promise<TaskResult<T>> {
        return runOfflineReplay(task, replayDir);
      },
    };
  }

  const clock = cfg.clock ?? new SystemClock();
  const interactions = cfg.interactions ?? defaultInteractions(cfg.apiKey!);
  return {
    path,
    runTask<T>(task: TaskSpec<T>): Promise<TaskResult<T>> {
      return runLiveGeminiTask(interactions, cfg, clock, task);
    },
  };
}

async function runLiveGeminiTask<T>(
  interactions: { create: (params: unknown) => Promise<unknown> },
  cfg: GeminiClientConfig,
  clock: Clock,
  task: TaskSpec<T>,
): Promise<TaskResult<T>> {
  const usage = zeroUsage();
  const startMono = clock.monotonicMs();
  let retries = 0;

  const elapsedSeconds = (): number => (clock.monotonicMs() - startMono) / 1000;
  const finalizeUsage = (): TaskUsage => {
    usage.elapsedMs = clock.monotonicMs() - startMono;
    usage.estimatedCostUsd = estimateGeminiCostUsd(cfg.model, usage.inputTokens, usage.outputTokens);
    return usage;
  };
  const blocked = (detail: string): TaskResult<T> => ({ ok: false, reason: 'api_error', detail, usage: finalizeUsage(), provenance: 'blocked' });

  // The browser toolset is Anthropic-specific and only used behind the gated
  // lazada_observe path; refuse before any network call rather than silently dropping tools.
  if (task.tools || task.browserExecutor) {
    return blocked('Gemini provider does not run the browser toolset; set BTS_MODEL_PROVIDER=anthropic for tool-using tasks');
  }

  const converted = toGeminiInput(task.messages);
  if (!converted.ok) {
    return blocked(converted.detail);
  }

  const params: Record<string, unknown> = {
    model: cfg.model,
    input: converted.input,
    system_instruction: task.system,
    generation_config: { thinking_level: cfg.thinkingLevel, max_output_tokens: 16000 },
    store: false,
    ...(task.outputSchema
      ? { response_format: { type: 'text', mime_type: 'application/json', schema: toGeminiOutputSchema(task.wire?.schema ?? task.outputSchema) } }
      : {}),
  };

  for (;;) {
    if (elapsedSeconds() > cfg.maxSeconds) {
      return {
        ok: false,
        reason: 'limit_exceeded',
        detail: `Elapsed ${elapsedSeconds().toFixed(1)}s exceeds maxSeconds=${cfg.maxSeconds}`,
        usage: finalizeUsage(),
        provenance: 'blocked',
      };
    }

    let response: GeminiInteractionResponse;
    try {
      response = (await interactions.create(params)) as GeminiInteractionResponse;
    } catch (err) {
      if (isRetryableGeminiError(err) && retries < 2) {
        retries += 1;
        continue;
      }
      return blocked(describeError(err));
    }

    const u = response.usage;
    if (u) {
      usage.inputTokens += u.total_input_tokens ?? 0;
      // `total_output_tokens` excludes thought tokens: a live probe (2026-09-19) returned
      // total_tokens 705 = input 14 + output 54 + thought 637. Thoughts are billed as
      // output, so add them here; this is not a double-count.
      usage.outputTokens += (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
      usage.cacheReadInputTokens += u.total_cached_tokens ?? 0;
    }

    const steps = response.steps ?? [];
    const lastModelOutput = findLastModelOutputStep(steps);

    if (lastModelOutput?.error) {
      return blocked(`model_output step reported an error: ${describeStatus(lastModelOutput.error)}`);
    }
    if (response.status === 'failed' || response.status === 'cancelled') {
      return blocked(`Interaction ended with status "${response.status}"`);
    }
    if (response.status === 'incomplete' || response.status === 'budget_exceeded') {
      return {
        ok: false,
        reason: 'truncated',
        detail: `Interaction ended with status "${response.status}" before completion; truncated output is never parsed as a result`,
        usage: finalizeUsage(),
        provenance: 'blocked',
      };
    }
    if (response.status === 'requires_action') {
      return blocked('model requested a tool; none are offered on this path');
    }
    if (response.status !== 'completed') {
      return blocked(`Unexpected interaction status "${response.status}"`);
    }

    // status === 'completed'.
    const text = extractText(response, lastModelOutput);
    if (!text) {
      return {
        ok: false,
        reason: 'refusal',
        detail: lastModelOutput
          ? `Model returned an empty model_output step with no text content (Gemini blocks arrive as empty output, not a labelled refusal)`
          : 'Model completed with no model_output step and no output_text (Gemini blocks arrive as empty output, not a labelled refusal)',
        usage: finalizeUsage(),
        provenance: 'blocked',
      };
    }

    if (!task.outputSchema) {
      return { ok: true, output: text as unknown as T, text, usage: finalizeUsage(), provenance: 'manual_input', stopReason: 'end_turn', model: response.model ?? cfg.model };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_output', detail: 'Final output_text was not valid JSON', usage: finalizeUsage(), provenance: 'blocked' };
    }
    let domainJson: unknown = parsedJson;
    if (task.wire) {
      const wireParsed = task.wire.schema.safeParse(parsedJson);
      if (!wireParsed.success) {
        return { ok: false, reason: 'invalid_output', detail: `Wire schema validation failed: ${wireParsed.error.message}`, usage: finalizeUsage(), provenance: 'blocked' };
      }
      try {
        domainJson = task.wire.toDomain(wireParsed.data);
      } catch (err) {
        return { ok: false, reason: 'invalid_output', detail: `Wire conversion failed: ${err instanceof Error ? err.message : String(err)}`, usage: finalizeUsage(), provenance: 'blocked' };
      }
    }
    const validated = task.outputSchema.safeParse(domainJson);
    if (!validated.success) {
      return { ok: false, reason: 'invalid_output', detail: `Schema validation failed: ${validated.error.message}`, usage: finalizeUsage(), provenance: 'blocked' };
    }
    return { ok: true, output: validated.data, text, usage: finalizeUsage(), provenance: 'manual_input', stopReason: 'end_turn', model: response.model ?? cfg.model };
  }
}
