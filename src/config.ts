/**
 * Runtime configuration. Reads .env (if present) and process.env, validates, and derives the MonitorPolicy.
 * A single flag can never turn demo submission into live submission: live preparation is a separate
 * adapter registration gated by docs/lazada-feasibility.md status recorded in settings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { monitorPolicyFromConfig, validateMonitorPolicy } from './domain/policy.ts';
import type { MonitorPolicy, Mode } from './domain/types.ts';

function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const bool = z
  .string()
  .optional()
  .transform((s) => (s ?? 'false').toLowerCase() === 'true');
const optInt = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s.trim() === '' ? null : Number.parseInt(s, 10)))
  .refine((n) => n === null || (Number.isInteger(n) && n > 0), { message: 'must be a positive integer or empty' });
const intWithDefault = (d: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s === undefined || s.trim() === '' ? d : Number.parseInt(s, 10)))
    .refine((n) => Number.isInteger(n) && n > 0, { message: 'must be a positive integer' });

const EnvSchema = z.object({
  BTS_MODE: z.enum(['demo', 'lazada_assist']).default('demo'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_API_KEY: z.string().optional().transform((s) => (s && s.trim() ? s.trim() : null)),
  BTS_AGENT_EFFORT: z.enum(['low', 'medium', 'high']).default('high'),
  BTS_TIMEZONE: z.literal('Asia/Singapore').default('Asia/Singapore'),
  BTS_LIVE_OBSERVE_ENABLED: bool,
  BTS_LIVE_PREPARE_ENABLED: bool,
  BTS_BASELINE_INTERVAL_SECONDS: optInt,
  BTS_PRIORITY_INTERVAL_SECONDS: optInt,
  BTS_AGENT_MAX_TOOL_CALLS: intWithDefault(20),
  BTS_AGENT_MAX_SECONDS: intWithDefault(120),
  BTS_SHOW_MODEL_UPDATES: bool,
  BTS_API_PORT: intWithDefault(4300),
  BTS_UI_PORT: intWithDefault(5173),
  BTS_DEMO_STORE_PORT: intWithDefault(4310),
  BTS_DEMO_ADMIN_PORT: intWithDefault(4311),
  BTS_DATA_DIR: z.string().default('./data'),
});

export interface AppConfig {
  mode: Mode;
  model: string;
  apiKey: string | null;
  effort: 'low' | 'medium' | 'high';
  timezone: 'Asia/Singapore';
  liveObserveEnabled: boolean;
  livePrepareEnabled: boolean;
  agentMaxToolCalls: number;
  agentMaxSeconds: number;
  showModelUpdates: boolean;
  apiPort: number;
  uiPort: number;
  demoStorePort: number;
  demoAdminPort: number;
  dataDir: string;
  monitorPolicy: MonitorPolicy;
  /** Origins the UI may call the API from. */
  uiOrigins: string[];
  /** The only loopback origin the demo executor may touch. */
  demoStoreOrigin: string;
  demoAdminOrigin: string;
  /** 'live' when a key exists; otherwise offline replay is the only model path and is labelled as such. */
  modelPath: 'live' | 'offline_replay';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { dotenv?: boolean } = {}): AppConfig {
  if (opts.dotenv !== false) loadDotEnv();
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  const policy = monitorPolicyFromConfig({
    mode: e.BTS_MODE,
    liveObserveEnabled: e.BTS_LIVE_OBSERVE_ENABLED,
    livePrepareEnabled: e.BTS_LIVE_PREPARE_ENABLED,
    baselineIntervalSeconds: e.BTS_BASELINE_INTERVAL_SECONDS,
    priorityIntervalSeconds: e.BTS_PRIORITY_INTERVAL_SECONDS,
  });
  const v = validateMonitorPolicy(policy);
  if (!v.ok) throw new Error(`MonitorPolicy rejected: ${v.error}`);
  return {
    mode: e.BTS_MODE,
    model: e.ANTHROPIC_MODEL,
    apiKey: e.ANTHROPIC_API_KEY,
    effort: e.BTS_AGENT_EFFORT,
    timezone: e.BTS_TIMEZONE,
    liveObserveEnabled: e.BTS_LIVE_OBSERVE_ENABLED,
    livePrepareEnabled: e.BTS_LIVE_PREPARE_ENABLED,
    agentMaxToolCalls: e.BTS_AGENT_MAX_TOOL_CALLS,
    agentMaxSeconds: e.BTS_AGENT_MAX_SECONDS,
    showModelUpdates: e.BTS_SHOW_MODEL_UPDATES,
    apiPort: e.BTS_API_PORT,
    uiPort: e.BTS_UI_PORT,
    demoStorePort: e.BTS_DEMO_STORE_PORT,
    demoAdminPort: e.BTS_DEMO_ADMIN_PORT,
    dataDir: resolve(process.cwd(), e.BTS_DATA_DIR),
    monitorPolicy: v.policy,
    uiOrigins: [`http://127.0.0.1:${e.BTS_UI_PORT}`, `http://localhost:${e.BTS_UI_PORT}`],
    demoStoreOrigin: `http://127.0.0.1:${e.BTS_DEMO_STORE_PORT}`,
    demoAdminOrigin: `http://127.0.0.1:${e.BTS_DEMO_ADMIN_PORT}`,
    modelPath: e.ANTHROPIC_API_KEY ? 'live' : 'offline_replay',
  };
}
