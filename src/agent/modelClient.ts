/**
 * createModelClient / describeModelClient: the single place (besides src/config.ts) that
 * knows both model providers exist. Picks the live `FableClient` implementation from
 * `config.modelProvider` so `src/server/wiring.ts`, `scripts/smoke-fable.ts`, and
 * `scripts/eval-fable.ts` do not each need their own provider switch.
 */
import type { AppConfig } from '../config.ts';
import type { FableClient } from './client.ts';
import { createFableClient } from './client.ts';
import { createGeminiClient } from './geminiClient.ts';

export function createModelClient(config: AppConfig): FableClient {
  if (config.modelProvider === 'gemini') {
    return createGeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      thinkingLevel: config.geminiThinkingLevel,
      maxSeconds: config.agentMaxSeconds,
    });
  }
  return createFableClient({
    apiKey: config.apiKey,
    model: config.model,
    effort: config.effort,
    maxToolCalls: config.agentMaxToolCalls,
    maxSeconds: config.agentMaxSeconds,
    showModelUpdates: config.showModelUpdates,
  });
}

export interface ModelClientDescription {
  provider: 'anthropic' | 'gemini';
  model: string;
  path: 'live' | 'offline_replay';
  detail: string;
}

/** For startup banners, /api/health, and the smoke/eval scripts; never touches the network. */
export function describeModelClient(config: AppConfig): ModelClientDescription {
  if (config.modelProvider === 'gemini') {
    return { provider: 'gemini', model: config.model, path: config.modelPath, detail: `thinking level ${config.geminiThinkingLevel}` };
  }
  return { provider: 'anthropic', model: config.model, path: config.modelPath, detail: `effort ${config.effort}` };
}
