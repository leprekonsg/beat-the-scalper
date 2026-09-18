import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

/** Every case passes an explicit env object and disables .env loading so the repo's own .env cannot leak in. */
const NO_DOTENV = { dotenv: false } as const;

describe('loadConfig', () => {
  it('A16: live observation without explicit intervals is refused', () => {
    expect(() => loadConfig({ BTS_MODE: 'lazada_assist', BTS_LIVE_OBSERVE_ENABLED: 'true' }, NO_DOTENV)).toThrow(/MonitorPolicy rejected/);
    expect(() => loadConfig({ BTS_MODE: 'lazada_assist', BTS_LIVE_OBSERVE_ENABLED: 'true' }, NO_DOTENV)).toThrow(/explicit baselineIntervalSeconds/);
  });

  it('A16: live observation carrying the 30s/2s demo cadence is refused as an implicit demo default', () => {
    const env = {
      BTS_MODE: 'lazada_assist',
      BTS_BASELINE_INTERVAL_SECONDS: '30',
      BTS_PRIORITY_INTERVAL_SECONDS: '2',
      BTS_LIVE_OBSERVE_ENABLED: 'true',
    };
    expect(() => loadConfig(env, NO_DOTENV)).toThrow(/demo defaults \(30s\/2s\)/);
  });

  it('A16: lazada_assist with live flags off loads with a disabled monitor policy', () => {
    const cfg = loadConfig({ BTS_MODE: 'lazada_assist' }, NO_DOTENV);
    expect(cfg.mode).toBe('lazada_assist');
    expect(cfg.liveObserveEnabled).toBe(false);
    expect(cfg.monitorPolicy.label).toBe('disabled');
    expect(cfg.monitorPolicy.baselineIntervalSeconds).toBeNull();
    expect(cfg.monitorPolicy.priorityIntervalSeconds).toBeNull();
    expect(cfg.monitorPolicy.maxObservationsPerOriginPerMinute).toBeNull();
  });

  it('A24: the default demo config has no API key, so the only model path is the labelled offline replay', () => {
    const cfg = loadConfig({}, NO_DOTENV);
    expect(cfg.mode).toBe('demo');
    expect(cfg.apiKey).toBeNull();
    expect(cfg.modelPath).toBe('offline_replay');
    expect(cfg.monitorPolicy.label).toBe('demo_defaults');
    expect(cfg.monitorPolicy.baselineIntervalSeconds).toBe(30);
    expect(cfg.monitorPolicy.priorityIntervalSeconds).toBe(2);
    expect(cfg.agentMaxToolCalls).toBe(20);
    expect(cfg.agentMaxSeconds).toBe(120);
    expect(cfg.effort).toBe('high');
    expect(cfg.timezone).toBe('Asia/Singapore');
  });

  it.each([
    { key: 'sk-ant-test-key', modelPath: 'live' as const },
    { key: '   ', modelPath: 'offline_replay' as const },
  ])('A24: an API key of "$key" selects the $modelPath model path', ({ key, modelPath }) => {
    expect(loadConfig({ ANTHROPIC_API_KEY: key }, NO_DOTENV).modelPath).toBe(modelPath);
  });

  it('A26: demo and live origins stay separate and the demo store is the only permitted loopback target', () => {
    const cfg = loadConfig({ BTS_DEMO_STORE_PORT: '4310', BTS_DEMO_ADMIN_PORT: '4311', BTS_UI_PORT: '5173' }, NO_DOTENV);
    expect(cfg.demoStoreOrigin).toBe('http://127.0.0.1:4310');
    expect(cfg.demoAdminOrigin).toBe('http://127.0.0.1:4311');
    expect(cfg.demoStoreOrigin).not.toBe(cfg.demoAdminOrigin);
    expect(cfg.uiOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(cfg.uiOrigins).not.toContain(cfg.demoStoreOrigin);
  });

  it.each([
    { env: { BTS_MODE: 'live' }, why: 'unknown mode' },
    { env: { BTS_BASELINE_INTERVAL_SECONDS: '0' }, why: 'non-positive interval' },
    { env: { BTS_AGENT_MAX_TOOL_CALLS: 'many' }, why: 'non-numeric tool-call limit' },
    { env: { BTS_TIMEZONE: 'UTC' }, why: 'unsupported timezone' },
  ])('A16: invalid configuration is refused: $why', ({ env }) => {
    expect(() => loadConfig(env, NO_DOTENV)).toThrow(/Invalid configuration/);
  });
});
