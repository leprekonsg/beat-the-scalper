/**
 * Provider selection (src/agent/modelClient.ts). Every config is built through the real
 * loadConfig with `dotenv: false`, so the developer's .env can never leak a key into these
 * assertions and no client here can reach the network.
 */
import { describe, expect, it } from 'vitest';
import { createModelClient, describeModelClient } from '../../src/agent/modelClient.ts';
import { loadConfig } from '../../src/config.ts';

const NO_DOTENV = { dotenv: false } as const;

describe('createModelClient (A24)', () => {
  it.each([
    { provider: 'anthropic' as const },
    { provider: 'gemini' as const },
  ])('A24: provider $provider with no key for that provider yields an offline_replay client', ({ provider }) => {
    const cfg = loadConfig({ BTS_MODEL_PROVIDER: provider }, NO_DOTENV);
    expect(createModelClient(cfg).path).toBe('offline_replay');
  });
});

describe('describeModelClient', () => {
  it('describes the gemini provider by its thinking level', () => {
    const cfg = loadConfig({ BTS_MODEL_PROVIDER: 'gemini' }, NO_DOTENV);
    expect(describeModelClient(cfg)).toEqual({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      path: 'offline_replay',
      detail: 'thinking level low',
    });
  });

  it('describes the anthropic provider by its effort level', () => {
    const cfg = loadConfig({ BTS_MODEL_PROVIDER: 'anthropic' }, NO_DOTENV);
    expect(describeModelClient(cfg)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      path: 'offline_replay',
      detail: 'effort high',
    });
  });
});
