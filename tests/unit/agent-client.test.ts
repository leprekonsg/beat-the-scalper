/**
 * Deterministic tests for the agent/client.ts contracts that do not require a live
 * model call: offline replay (A24), the A25 history-tamper detector, and the
 * extract.ts code rule that downgrades an unsupported source_confirmed claim.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { createFableClient, verifyHistoryPrefix } from '../../src/agent/client.ts';
import { extractAnnouncement } from '../../src/agent/extract.ts';
import { AnnouncementExtractionSchema } from '../../src/domain/types.ts';
import { fact, makeExtraction } from './builders.ts';

function hashOf(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

describe('verifyHistoryPrefix (A25)', () => {
  it('accepts an untouched assistant history matching its recorded hashes', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: 'thanks' },
    ];
    const hashes = [hashOf(messages[1]!.content)];
    expect(verifyHistoryPrefix(messages, hashes)).toBe(true);
  });

  it('detects a rewritten earlier assistant message', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello, rewritten after the fact' }] },
    ];
    // The hash was recorded against the original ("hello"), not the mutated content.
    const hashes = [hashOf([{ type: 'text', text: 'hello' }])];
    expect(verifyHistoryPrefix(messages, hashes)).toBe(false);
  });

  it('detects a dropped assistant message (fewer assistant turns than recorded hashes)', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const hashes = [hashOf([{ type: 'text', text: 'hello' }])];
    expect(verifyHistoryPrefix(messages, hashes)).toBe(false);
  });
});

describe('createFableClient offline replay (A24)', () => {
  it('never selects the live path without an apiKey, and labels every result offline_replay', async () => {
    const client = createFableClient({
      apiKey: null,
      model: 'claude-fable-5-1',
      effort: 'high',
      maxToolCalls: 20,
      maxSeconds: 120,
      showModelUpdates: false,
    });
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
      expect(result.output.dateBasis).toBe('source_confirmed');
    }
  });

  it('reports a missing fixture as a non-fabricated failure, never a fabricated success', async () => {
    const client = createFableClient({ apiKey: null, model: 'claude-fable-5-1', effort: 'high', maxToolCalls: 20, maxSeconds: 120, showModelUpdates: false });
    const result = await client.runTask({ name: 'task-with-no-fixture', system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/No offline replay fixture/);
  });

  it('reports a fixture that fails schema validation as invalid_output, never a fabricated success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bts-replay-'));
    writeFileSync(join(dir, 'bad-fixture.json'), JSON.stringify({ label: 'Offline replay fixture - not a live Fable run', output: { not: 'a valid extraction' } }));
    const client = createFableClient({ apiKey: null, model: 'claude-fable-5-1', effort: 'high', maxToolCalls: 20, maxSeconds: 120, showModelUpdates: false, replayDir: dir });
    const result = await client.runTask({ name: 'bad-fixture', system: 's', messages: [{ role: 'user', content: 'x' }], outputSchema: AnnouncementExtractionSchema });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_output');
  });
});

describe('extractAnnouncement code rules (A06 downgrade)', () => {
  it('downgrades a source_confirmed claim with no resolved release date to unknown', async () => {
    const extraction = makeExtraction({
      dateBasis: 'source_confirmed',
      releaseDateLocal: fact<string>(null, { reason: 'stale fixture: claims source_confirmed but never resolved a date' }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'bts-replay-'));
    writeFileSync(join(dir, 'extract-announcement.json'), JSON.stringify({ label: 'Offline replay fixture - not a live Fable run', output: extraction }));
    const client = createFableClient({ apiKey: null, model: 'claude-fable-5-1', effort: 'high', maxToolCalls: 20, maxSeconds: 120, showModelUpdates: false, replayDir: dir });

    const result = await extractAnnouncement(client, { evidenceId: 'evd_test' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.dateBasis).toBe('unknown');
  });

  it('leaves a genuinely source_confirmed extraction (with a resolved date) unchanged', async () => {
    const client = createFableClient({ apiKey: null, model: 'claude-fable-5-1', effort: 'high', maxToolCalls: 20, maxSeconds: 120, showModelUpdates: false });
    const result = await extractAnnouncement(client, { evidenceId: 'evd_test' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.dateBasis).toBe('source_confirmed');
      expect(result.output.releaseDateLocal.value).not.toBeNull();
    }
  });
});
