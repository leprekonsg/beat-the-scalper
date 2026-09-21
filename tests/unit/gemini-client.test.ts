/**
 * Deterministic tests for src/agent/geminiClient.ts. Every case injects a fake
 * `interactions: { create }`; a real `GoogleGenAI` is never constructed and no network call
 * is ever made. The offline-replay cases (A24) additionally assert that an injected fake is
 * never reached when no key is configured -- offline replay is a separate code path, not a
 * live call with a stubbed transport.
 */
import { ApiError } from '@google/genai';
import type { MessageParam, ToolUnion } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TaskSpec } from '../../src/agent/client.ts';
import { extractAnnouncement } from '../../src/agent/extract.ts';
import { createGeminiClient, toGeminiInput, toGeminiOutputSchema } from '../../src/agent/geminiClient.ts';
import type { Clock } from '../../src/domain/time.ts';
import {
  AnnouncementExtractionSchema,
  AnnouncementExtractionWireSchema,
  type AnnouncementExtractionWire,
} from '../../src/domain/types.ts';

const MODEL = 'gemini-3.8-flash';

interface FakeInteractions {
  create: (params: unknown) => Promise<unknown>;
  calls: unknown[];
}

/**
 * A fake `interactions` whose `create` records its params and replays the supplied
 * responses/throws in order; the last entry repeats for any further call.
 */
function fakeCreate(...responses: (unknown | Error)[]): FakeInteractions {
  const calls: unknown[] = [];
  return {
    calls,
    create: (params: unknown): Promise<unknown> => {
      calls.push(params);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
}

/** A fake that fails loudly if the code under test ever reaches the network boundary. */
function neverCalled(): FakeInteractions {
  const calls: unknown[] = [];
  return {
    calls,
    create: (params: unknown): Promise<unknown> => {
      calls.push(params);
      throw new Error('interactions.create must not be reached on this path');
    },
  };
}

function liveClient(over: Partial<Parameters<typeof createGeminiClient>[0]> = {}) {
  return createGeminiClient({
    apiKey: 'test-key-not-a-real-credential',
    model: MODEL,
    thinkingLevel: 'low',
    maxSeconds: 120,
    interactions: fakeCreate({ id: 'i1', status: 'completed', output_text: 'ok' }),
    ...over,
  });
}

/** A minimal schema-less task; the response text is returned verbatim. */
function textTask(): TaskSpec<string> {
  return { name: 'text-task', system: 'be brief', messages: [{ role: 'user', content: 'hello' }] };
}

/** A task carrying both an outputSchema and a wire schema, the shape extractAnnouncement builds. */
function schemaTask(): TaskSpec<z.infer<typeof AnnouncementExtractionSchema>> {
  return {
    name: 'extract-announcement',
    system: 'system prompt text',
    messages: [{ role: 'user', content: 'announcement text' }],
    outputSchema: AnnouncementExtractionSchema,
    wire: { schema: AnnouncementExtractionWireSchema, toDomain: (w) => w as never },
  };
}

function wirePayload(): AnnouncementExtractionWire {
  return {
    facts: [
      { name: 'productFormat', value: 'Elite Trainer Box', span: 'Elite Trainer Box', reason: '' },
      { name: 'productName', value: 'Scarlet & Violet Elite Trainer Box', span: '', reason: '' },
      { name: 'language', value: 'English', span: '', reason: '' },
      { name: 'market', value: 'Singapore', span: '', reason: '' },
      { name: 'releaseDateLocal', value: '2026-09-25', span: '"25 September 2026"', reason: '' },
      { name: 'releaseTimeLocal', value: '10:00', span: '"10:00am"', reason: '' },
      { name: 'timezone', value: 'Asia/Singapore', span: '"Singapore time"', reason: '' },
      { name: 'sellerOrChannel', value: 'Pokemon Official Store SG', span: '', reason: '' },
      { name: 'purchaseLimit', value: '1', span: '"limit one per customer"', reason: '' },
      { name: 'packagingCondition', value: 'not_stated', span: '', reason: 'Packaging is not mentioned' },
      { name: 'relativeAge', value: '', span: '', reason: 'Dated announcement, no relative-age phrase' },
    ],
    dateBasis: 'source_confirmed',
    missingFactsForActionableIntent: ['exact product URL'],
    notes: '',
  };
}

function completedWith(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'i1', status: 'completed', model: MODEL, output_text: text, ...over };
}

describe('createGeminiClient offline replay (A24)', () => {
  it('A24: a null apiKey selects offline replay, labels the result, and never reaches interactions.create', async () => {
    const create = neverCalled();
    const client = createGeminiClient({ apiKey: null, model: MODEL, thinkingLevel: 'low', maxSeconds: 120, interactions: create });
    expect(client.path).toBe('offline_replay');

    const result = await client.runTask({
      name: 'extract-announcement',
      system: 'irrelevant in replay',
      messages: [{ role: 'user', content: 'irrelevant in replay' }],
      outputSchema: AnnouncementExtractionSchema,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance).toBe('offline_replay');
      expect(result.model).toBeNull();
      expect(result.label).toMatch(/Offline replay/i);
    }
    expect(create.calls).toHaveLength(0);
  });
});

describe('toGeminiInput', () => {
  it('converts a string user message to a single text part', () => {
    const r = toGeminiInput([{ role: 'user', content: 'hello' }]);
    expect(r).toEqual({ ok: true, input: [{ type: 'text', text: 'hello' }] });
  });

  it('converts text and base64 png image blocks to ordered text/image parts', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ];
    const r = toGeminiInput(messages);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual([
        { type: 'text', text: 'first' },
        { type: 'image', data: 'AAAA', mime_type: 'image/png' },
      ]);
    }
  });

  it('refuses an assistant message, naming the role (the Gemini path never continues a prior history)', () => {
    const r = toGeminiInput([{ role: 'assistant', content: [{ type: 'text', text: 'prior turn' }] }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/assistant/);
  });

  it('refuses a tool_result content block', () => {
    const messages: MessageParam[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x' }] }];
    const r = toGeminiInput(messages);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/tool_result/);
  });

  it('refuses a URL-sourced image (only base64 sources are supported)', () => {
    const messages: MessageParam[] = [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }] }];
    const r = toGeminiInput(messages);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/base64/);
  });
});

describe('toGeminiOutputSchema', () => {
  it('drops $schema but keeps minimum/maximum/enum (Gemini supports them; the Anthropic stripper must not be reused)', () => {
    const schema = z.object({ score: z.number().min(1).max(5), kind: z.enum(['alpha', 'beta']) });
    const json = toGeminiOutputSchema(schema);
    expect(json).not.toHaveProperty('$schema');
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.score!.minimum).toBe(1);
    expect(props.score!.maximum).toBe(5);
    expect(props.kind!.enum).toEqual(['alpha', 'beta']);
  });

  it('renders the announcement wire schema as a plain object schema', () => {
    const json = toGeminiOutputSchema(AnnouncementExtractionWireSchema);
    expect(json).not.toHaveProperty('$schema');
    expect(json.type).toBe('object');
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
  });
});

describe('request shape', () => {
  it('sends exactly model/input/system_instruction/generation_config/store/response_format and no history, background, or tools', async () => {
    const create = fakeCreate(completedWith(JSON.stringify(wirePayload())));
    const client = liveClient({ interactions: create });
    await client.runTask(schemaTask());

    expect(create.calls).toHaveLength(1);
    const params = create.calls[0] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['generation_config', 'input', 'model', 'response_format', 'store', 'system_instruction']);
    expect(params.model).toBe(MODEL);
    expect(params.input).toEqual([{ type: 'text', text: 'announcement text' }]);
    expect(params.system_instruction).toBe('system prompt text');
    expect(params.generation_config).toEqual({ thinking_level: 'low', max_output_tokens: 16000 });
    expect(params.store).toBe(false);
    const responseFormat = params.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe('text');
    expect(responseFormat.mime_type).toBe('application/json');
    expect(responseFormat.schema).toEqual(toGeminiOutputSchema(AnnouncementExtractionWireSchema));
    expect(params).not.toHaveProperty('previous_interaction_id');
    expect(params).not.toHaveProperty('background');
    expect(params).not.toHaveProperty('tools');
  });
});

describe('tool refusal', () => {
  it('refuses a task carrying tools before any network call, naming BTS_MODEL_PROVIDER=anthropic', async () => {
    const create = neverCalled();
    const client = liveClient({ interactions: create });
    const result = await client.runTask({ ...textTask(), tools: [{} as unknown as ToolUnion] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/BTS_MODEL_PROVIDER=anthropic/);
      expect(result.provenance).toBe('blocked');
    }
    expect(create.calls).toHaveLength(0);
  });

  it('refuses a task carrying a browserExecutor before any network call', async () => {
    const create = neverCalled();
    const client = liveClient({ interactions: create });
    const browserExecutor = { executeBatch: async () => [] } as never;
    const result = await client.runTask({ ...textTask(), browserExecutor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/BTS_MODEL_PROVIDER=anthropic/);
      expect(result.provenance).toBe('blocked');
    }
    expect(create.calls).toHaveLength(0);
  });
});

describe('success path with wire conversion', () => {
  const response = (model = MODEL) => ({
    id: 'i1',
    status: 'completed',
    model,
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(wirePayload()) }] }],
    output_text: JSON.stringify(wirePayload()),
    usage: { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 20 },
  });

  it('A06: converts the wire payload to the domain extraction with live provenance, usage, and an estimated cost', async () => {
    const create = fakeCreate(response());
    const client = liveClient({ interactions: create });
    const result = await extractAnnouncement(client, { evidenceId: 'evd_test', text: 'launching 25 September 2026' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toBe('manual_input');
    expect(result.model).toBe(MODEL);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    // Thought tokens are added to output tokens (documented assumption in geminiClient.ts).
    expect(result.usage.outputTokens).toBe(70);
    expect(result.usage.estimatedCostUsd).toBeCloseTo((100 / 1e6) * 0.75 + (70 / 1e6) * 3.75, 12);
    expect(result.output.releaseDateLocal.value).toBe('2026-09-25');
    expect(result.output.purchaseLimit.value).toBe(1);
  });

  it('reports estimatedCostUsd as null for a model absent from the pricing table, never an invented price', async () => {
    const create = fakeCreate(response('gemini-9.9-imaginary'));
    const client = liveClient({ model: 'gemini-9.9-imaginary', interactions: create });
    const result = await extractAnnouncement(client, { evidenceId: 'evd_test', text: 'launching 25 September 2026' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage.estimatedCostUsd).toBeNull();
  });

  it('falls back to the last model_output step text when output_text is absent', async () => {
    const create = fakeCreate({
      id: 'i1',
      status: 'completed',
      model: MODEL,
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'superseded' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'final answer' }] },
      ],
    });
    const client = liveClient({ interactions: create });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('final answer');
  });
});

describe('status mapping', () => {
  it('maps status "incomplete" to truncated, never parsing truncated output', async () => {
    const client = liveClient({ interactions: fakeCreate({ id: 'i1', status: 'incomplete', output_text: '{"partial":' }) });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('truncated');
      expect(result.provenance).toBe('blocked');
    }
  });

  it('maps status "budget_exceeded" to truncated', async () => {
    const client = liveClient({ interactions: fakeCreate({ id: 'i1', status: 'budget_exceeded' }) });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('truncated');
  });

  it('maps status "failed" to api_error', async () => {
    const client = liveClient({ interactions: fakeCreate({ id: 'i1', status: 'failed' }) });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/failed/);
    }
  });

  it('maps status "requires_action" to api_error mentioning the tool request', async () => {
    const client = liveClient({ interactions: fakeCreate({ id: 'i1', status: 'requires_action' }) });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/tool/i);
    }
  });

  it('surfaces a model_output step error as api_error carrying the provider message', async () => {
    const client = liveClient({
      interactions: fakeCreate({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', error: { message: 'boom' } }] }),
    });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/boom/);
    }
  });

  it('A24: maps a completed interaction with empty text to refusal (Gemini blocks arrive as empty output)', async () => {
    const client = liveClient({ interactions: fakeCreate({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [] }] }) });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('refusal');
      expect(result.provenance).toBe('blocked');
    }
  });

  it('maps non-JSON text on a schema task to invalid_output, never a fabricated result', async () => {
    const client = liveClient({ interactions: fakeCreate(completedWith('not json at all')) });
    const result = await client.runTask(schemaTask());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_output');
  });

  it('maps JSON that fails the wire schema to invalid_output', async () => {
    const client = liveClient({ interactions: fakeCreate(completedWith(JSON.stringify({ facts: 'not an array' }))) });
    const result = await client.runTask(schemaTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_output');
      expect(result.detail).toMatch(/Wire schema validation failed/);
    }
  });
});

describe('retries', () => {
  it('retries a 429 twice and then succeeds', async () => {
    const create = fakeCreate(
      new ApiError({ message: 'rate', status: 429 }),
      new ApiError({ message: 'rate', status: 429 }),
      completedWith('ok'),
    );
    const client = liveClient({ interactions: create });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(true);
    expect(create.calls).toHaveLength(3);
  });

  it('never retries a 400 and fails on the first attempt', async () => {
    const create = fakeCreate(new ApiError({ message: 'bad request', status: 400 }));
    const client = liveClient({ interactions: create });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('api_error');
    expect(create.calls).toHaveLength(1);
  });

  it('gives up after three connection-level failures rather than looping', async () => {
    const create = fakeCreate(new Error('ECONNRESET'));
    const client = liveClient({ interactions: create });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/ECONNRESET/);
    }
    expect(create.calls).toHaveLength(3);
  });

  it('never retries a plain (non-ApiError) throw carrying status:400, failing after exactly 1 call', async () => {
    const create = fakeCreate(Object.assign(new Error('bad request'), { status: 400 }));
    const client = liveClient({ interactions: create });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('api_error');
    expect(create.calls).toHaveLength(1);
  });
});

describe('maxSeconds', () => {
  it('stops retrying and reports limit_exceeded once the elapsed budget is spent', async () => {
    // Calls 1 (startMono) and 2 (the first loop's budget check) read 0; every later read is past
    // maxSeconds, so the retry after the first failure trips the budget instead of calling again.
    let reads = 0;
    const clock: Clock = {
      now: () => new Date('2026-09-25T05:00:00.000Z'),
      monotonicMs: () => {
        reads += 1;
        return reads <= 2 ? 0 : 10 * 120 * 1000;
      },
    };
    const create = fakeCreate(new ApiError({ message: 'rate', status: 429 }));
    const client = liveClient({ interactions: create, clock, maxSeconds: 120 });
    const result = await client.runTask(textTask());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('limit_exceeded');
      expect(result.provenance).toBe('blocked');
    }
    expect(create.calls).toHaveLength(1);
  });
});

describe('A24: never live without a key, never offline with one', () => {
  it('selects the live path when a key is present and never labels a live result offline_replay', async () => {
    const client = liveClient({ interactions: fakeCreate(completedWith('ok')) });
    expect(client.path).toBe('live');
    const result = await client.runTask(textTask());
    expect(result.provenance).not.toBe('offline_replay');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.label).toBeUndefined();
  });
});
