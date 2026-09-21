/**
 * FableClient: a bounded, single-task wrapper around the Anthropic Messages API for
 * `claude-fable-5-1` (BTS_FABLE_BUILD_PLAN.md section 8). Each call to `runTask()` is
 * a fresh, bounded conversation built from `task.messages` -- it never continues a
 * prior task's history. Never splice thinking/signed content blocks from one
 * conversation's `messages` array into a different one; each task must build its own
 * array from validated database state (announcement/evidence/intent), never from a
 * previous task's in-memory array.
 *
 * Verified API facts for claude-fable-5-1 (do not rely on model memory for these):
 *  - Thinking is always on: never send `thinking` unless requesting progress updates.
 *  - Never send temperature/top_p/top_k, assistant prefill, or a forced tool_choice.
 *  - Effort via `output_config.effort`; structured output via `output_config.format`.
 *  - stop_reason 'refusal'|'max_tokens' must never be parsed as a usable result.
 *  - Browser toolset members arrive with `toolset_name: 'browser'`.
 *  - Do not enable server-side refusal fallbacks (they can silently switch models).
 */
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  StopReason,
  TextBlock,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUnion,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../domain/time.ts';
import { SystemClock } from '../domain/time.ts';
import type { Provenance } from '../domain/types.ts';
import type { RestrictedBrowserExecutor } from './browserExecutor.ts';
import { defaultReplayDir, describeError, runOfflineReplay, zeroUsage } from './replay.ts';

const MAX_TOKENS = 16000;

/**
 * JSON Schema keywords the structured-output endpoint rejects (verified live 2026-09-18: "For 'integer' type,
 * properties maximum, minimum are not supported"). Zod still validates the parsed output client-side, so
 * stripping them here loses nothing.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$schema',
]);

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYWORDS.has(k)) continue;
      out[k] = stripUnsupportedKeywords(v);
    }
    return out;
  }
  return node;
}

/** Zod schema -> JSON Schema accepted by `output_config.format`. Exported for tests. */
export function toStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  return stripUnsupportedKeywords(z.toJSONSchema(schema)) as Record<string, unknown>;
}
const PROGRESS_BETA = 'thinking-display-updates-2026-08-18';

/**
 * Verified first-party pricing (USD per 1M tokens) as of the brief's date. Never
 * invent a price for a model not listed here; `estimateCostUsd` returns null instead.
 */
const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10.0, output: 50.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
};

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolCalls: number;
  elapsedMs: number;
  /**
   * Upper-bound estimate computed from base input/output tokens and the verified
   * pricing table only. Cache-read/creation pricing is treated as unknown and is
   * never added, so this is reported as an estimate, not a reconciled invoice line.
   * Null when the model is not in the pricing table.
   */
  estimatedCostUsd: number | null;
}

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = PRICING_PER_MILLION[model];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export type TaskFailureReason = 'refusal' | 'truncated' | 'no_key' | 'limit_exceeded' | 'api_error' | 'invalid_output';

export type TaskResult<T = unknown> =
  | {
      ok: true;
      output: T;
      text: string;
      usage: TaskUsage;
      provenance: Provenance;
      stopReason: StopReason | null;
      /** The model that actually answered, read from the response; null for offline replay (no live model ran). */
      model: string | null;
      label?: string;
    }
  | { ok: false; reason: TaskFailureReason; detail: string; usage: TaskUsage; provenance: Provenance };

export interface TaskSpec<T = unknown> {
  name: string;
  system: string;
  messages: MessageParam[];
  tools?: ToolUnion[];
  outputSchema?: z.ZodType<T>;
  /**
   * Optional union-free schema sent to the live endpoint instead of `outputSchema`, with a converter back to
   * the domain shape. The live endpoint caps union-typed (nullable) fields at 16; domain schemas may exceed
   * that. Offline replay fixtures are domain-shaped and ignore this.
   */
  wire?: { schema: z.ZodType; toDomain: (wire: unknown) => T };
  toolExecutor?: (toolUse: ToolUseBlock) => Promise<ToolResultBlockParam>;
  browserExecutor?: RestrictedBrowserExecutor;
  onUpdate?: (text: string) => void;
}

export interface FableClient {
  readonly path: 'live' | 'offline_replay';
  runTask<T = unknown>(task: TaskSpec<T>): Promise<TaskResult<T>>;
}

export interface FableClientConfig {
  apiKey: string | null;
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxToolCalls: number;
  maxSeconds: number;
  showModelUpdates: boolean;
  clock?: Clock;
  /** Overrides the default `fixtures/replay` directory; primarily for tests. */
  replayDir?: string;
}

export class HistoryRewriteError extends Error {
  constructor(message = 'assistant history prefix was modified; refusing to continue this conversation') {
    super(message);
    this.name = 'HistoryRewriteError';
  }
}

function hashAssistantContent(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * A25: recompute the hash of every assistant message currently in `messages` and
 * compare against the hashes recorded when each was appended, in order. Exported so
 * tests can exercise tamper detection without a live/offline model run.
 */
export function verifyHistoryPrefix(messages: MessageParam[], hashes: string[]): boolean {
  const assistantContents = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  if (assistantContents.length < hashes.length) return false;
  for (let i = 0; i < hashes.length; i++) {
    if (hashAssistantContent(assistantContents[i]) !== hashes[i]) return false;
  }
  return true;
}

function systemBlocks(system: string): TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/** Puts a cache breakpoint on the last tool entry (the toolset definition, when present). */
function toolsWithCache(tools: ToolUnion[] | undefined): ToolUnion[] | undefined {
  if (!tools || tools.length === 0) return tools;
  const cloned = tools.map((t) => ({ ...t })) as ToolUnion[];
  const last = cloned[cloned.length - 1] as ToolUnion & { cache_control?: unknown };
  last.cache_control = { type: 'ephemeral' };
  return cloned;
}

function isTextBlock(block: Message['content'][number]): block is TextBlock {
  return block.type === 'text';
}

function isToolUseBlock(block: { type: string }): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function describeRefusal(response: Message): string {
  const details = response.stop_details;
  if (!details) return 'Model refused without further detail';
  return `Refusal (${details.category ?? 'uncategorized'}): ${details.explanation ?? 'no explanation provided'}`;
}

function isRetryableApiError(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = (err as { status?: number }).status;
    if (status === undefined) return true; // connection-level failure
    return status === 429 || status >= 500;
  }
  return false;
}

function forwardThinkingUpdates(response: Message, onUpdate: (text: string) => void): void {
  for (const block of response.content) {
    if (block.type === 'thinking') {
      const text = (block as { thinking?: string }).thinking;
      if (text && text.trim().length > 0) onUpdate(text);
    }
  }
}

/**
 * Never call the API without a key: offline replay is a fully separate code path that
 * cannot reach `createMessage`.
 */
export function createFableClient(cfg: FableClientConfig): FableClient {
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
  const anthropic = new Anthropic({ apiKey: cfg.apiKey! });
  return {
    path,
    runTask<T>(task: TaskSpec<T>): Promise<TaskResult<T>> {
      return runLiveTask(anthropic, cfg, clock, task);
    },
  };
}

async function dispatchToolUses(blocks: ToolUseBlock[], task: TaskSpec<unknown>): Promise<ToolResultBlockParam[]> {
  const browserBlocks = blocks.filter((b) => b.toolset_name === 'browser');
  const otherBlocks = blocks.filter((b) => b.toolset_name !== 'browser');
  const byId = new Map<string, ToolResultBlockParam>();

  if (browserBlocks.length > 0) {
    if (!task.browserExecutor) throw new Error('Received a browser tool_use but no browserExecutor was configured for this task');
    const results = await task.browserExecutor.executeBatch(browserBlocks);
    browserBlocks.forEach((b, i) => byId.set(b.id, results[i]!));
  }
  for (const b of otherBlocks) {
    if (!task.toolExecutor) throw new Error(`Received tool_use for "${b.name}" but no toolExecutor was configured for this task`);
    byId.set(b.id, await task.toolExecutor(b));
  }
  return blocks.map((b) => byId.get(b.id)!);
}

async function createMessage(client: Anthropic, cfg: FableClientConfig, task: TaskSpec<unknown>, messages: MessageParam[]): Promise<Message> {
  const tools = toolsWithCache(task.tools);
  const outputConfig = {
    effort: cfg.effort,
    ...(task.outputSchema ? { format: { type: 'json_schema' as const, schema: toStructuredOutputSchema(task.wire?.schema ?? task.outputSchema) } } : {}),
  };
  const base = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(task.system),
    messages,
    output_config: outputConfig,
    ...(tools ? { tools } : {}),
  };

  if (!cfg.showModelUpdates) {
    return client.messages.create(base);
  }

  // Progress updates require the beta thinking-display-updates header and
  // `thinking: {type:'adaptive', display:'updates'}`. The installed SDK typings
  // (messages.d.ts) only know `display: 'summarized' | 'omitted'` and do not include
  // this beta string, so this call is cast at the boundary; the wire contract is
  // documented in BTS_FABLE_BUILD_PLAN.md section 8. Updates are commentary only,
  // never evidence, and are forwarded to `task.onUpdate` only when nonempty.
  const betaParams = {
    ...base,
    betas: [PROGRESS_BETA],
    thinking: { type: 'adaptive', display: 'updates' },
  };
  const response = await (client.beta.messages.create as unknown as (params: unknown) => Promise<Message>)(betaParams);
  return response;
}

async function runLiveTask<T>(client: Anthropic, cfg: FableClientConfig, clock: Clock, task: TaskSpec<T>): Promise<TaskResult<T>> {
  const messages: MessageParam[] = [...task.messages];
  const assistantHashes: string[] = [];
  const usage = zeroUsage();
  const startMono = clock.monotonicMs();
  let retries = 0;

  const elapsedSeconds = (): number => (clock.monotonicMs() - startMono) / 1000;
  const finalizeUsage = (): TaskUsage => {
    usage.elapsedMs = clock.monotonicMs() - startMono;
    usage.estimatedCostUsd = estimateCostUsd(cfg.model, usage.inputTokens, usage.outputTokens);
    return usage;
  };

  for (;;) {
    if (!verifyHistoryPrefix(messages, assistantHashes)) {
      throw new HistoryRewriteError();
    }
    if (elapsedSeconds() > cfg.maxSeconds) {
      return {
        ok: false,
        reason: 'limit_exceeded',
        detail: `Elapsed ${elapsedSeconds().toFixed(1)}s exceeds maxSeconds=${cfg.maxSeconds}`,
        usage: finalizeUsage(),
        provenance: 'blocked',
      };
    }

    let response: Message;
    try {
      response = await createMessage(client, cfg, task, messages);
    } catch (err) {
      if (isRetryableApiError(err) && retries < 2) {
        retries += 1;
        continue;
      }
      return { ok: false, reason: 'api_error', detail: describeError(err), usage: finalizeUsage(), provenance: 'blocked' };
    }

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (task.onUpdate) forwardThinkingUpdates(response, task.onUpdate);

    if (response.stop_reason === 'refusal') {
      return { ok: false, reason: 'refusal', detail: describeRefusal(response), usage: finalizeUsage(), provenance: 'blocked' };
    }
    if (response.stop_reason === 'max_tokens') {
      return {
        ok: false,
        reason: 'truncated',
        detail: 'Response hit max_tokens; truncated output is never parsed as a result',
        usage: finalizeUsage(),
        provenance: 'blocked',
      };
    }

    if (response.stop_reason === 'tool_use') {
      // Append the assistant message INTACT: the full response.content array,
      // including thinking/signature blocks, unchanged.
      messages.push({ role: 'assistant', content: response.content });
      assistantHashes.push(hashAssistantContent(response.content));

      const toolUseBlocks = response.content.filter(isToolUseBlock);
      usage.toolCalls += toolUseBlocks.length;
      if (usage.toolCalls > cfg.maxToolCalls) {
        return {
          ok: false,
          reason: 'limit_exceeded',
          detail: `Tool call count ${usage.toolCalls} exceeds maxToolCalls=${cfg.maxToolCalls}`,
          usage: finalizeUsage(),
          provenance: 'blocked',
        };
      }
      if (elapsedSeconds() > cfg.maxSeconds) {
        return {
          ok: false,
          reason: 'limit_exceeded',
          detail: `Elapsed ${elapsedSeconds().toFixed(1)}s exceeds maxSeconds=${cfg.maxSeconds}`,
          usage: finalizeUsage(),
          provenance: 'blocked',
        };
      }

      let toolResults: ToolResultBlockParam[];
      try {
        toolResults = await dispatchToolUses(toolUseBlocks, task as TaskSpec<unknown>);
      } catch (err) {
        return { ok: false, reason: 'api_error', detail: `Tool dispatch failed: ${describeError(err)}`, usage: finalizeUsage(), provenance: 'blocked' };
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // end_turn / stop_sequence / pause_turn: parse the final text block(s).
    const text = response.content.filter(isTextBlock).map((b) => b.text).join('\n');
    if (!task.outputSchema) {
      return { ok: true, output: text as unknown as T, text, usage: finalizeUsage(), provenance: 'manual_input', stopReason: response.stop_reason, model: response.model };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_output', detail: 'Final text block was not valid JSON', usage: finalizeUsage(), provenance: 'blocked' };
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
    return { ok: true, output: validated.data, text, usage: finalizeUsage(), provenance: 'manual_input', stopReason: response.stop_reason, model: response.model };
  }
}
