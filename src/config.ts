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
  BTS_MODEL_PROVIDER: z.enum(['anthropic', 'gemini']).default('anthropic'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_API_KEY: z.string().optional().transform((s) => (s && s.trim() ? s.trim() : null)),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_API_KEY: z.string().optional().transform((s) => (s && s.trim() ? s.trim() : null)),
  /** 'low' is the speed choice for the fast alternative path; 'minimal' is rejected by gemini-3.8-flash. */
  BTS_GEMINI_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('low'),
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
  /** Optional restock-alert webhook (e.g. an ntfy topic URL). Empty = terminal bell and dashboard only. */
  BTS_ALERT_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((s) => (s && s.trim() ? s.trim() : null))
    .refine((s) => s === null || URL.canParse(s), { message: 'must be a full URL, e.g. https://ntfy.sh/<your-topic>' }),
});

export interface AppConfig {
  mode: Mode;
  /** The selected provider's model id (shown in the UI band and /api/health). */
  model: string;
  /** Kept for backward compatibility: always the Anthropic key, regardless of modelProvider. */
  apiKey: string | null;
  modelProvider: 'anthropic' | 'gemini';
  geminiApiKey: string | null;
  geminiModel: string;
  geminiThinkingLevel: 'low' | 'medium' | 'high';
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
  /** Restock alerts are also POSTed here when set (see src/worker/notifier.ts). */
  alertWebhookUrl: string | null;
  monitorPolicy: MonitorPolicy;
  /** Origins the UI may call the API from. */
  uiOrigins: string[];
  /** The only loopback origin the demo executor may touch. */
  demoStoreOrigin: string;
  demoAdminOrigin: string;
  /** 'live' when the selected provider's key exists; otherwise offline replay is the only model path and is labelled as such. */
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
  const selectedKey = e.BTS_MODEL_PROVIDER === 'gemini' ? e.GEMINI_API_KEY : e.ANTHROPIC_API_KEY;
  return {
    mode: e.BTS_MODE,
    model: e.BTS_MODEL_PROVIDER === 'gemini' ? e.GEMINI_MODEL : e.ANTHROPIC_MODEL,
    apiKey: e.ANTHROPIC_API_KEY,
    modelProvider: e.BTS_MODEL_PROVIDER,
    geminiApiKey: e.GEMINI_API_KEY,
    geminiModel: e.GEMINI_MODEL,
    geminiThinkingLevel: e.BTS_GEMINI_THINKING_LEVEL,
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
    alertWebhookUrl: e.BTS_ALERT_WEBHOOK_URL,
    monitorPolicy: v.policy,
    uiOrigins: [`http://127.0.0.1:${e.BTS_UI_PORT}`, `http://localhost:${e.BTS_UI_PORT}`],
    demoStoreOrigin: `http://127.0.0.1:${e.BTS_DEMO_STORE_PORT}`,
    demoAdminOrigin: `http://127.0.0.1:${e.BTS_DEMO_ADMIN_PORT}`,
    modelPath: selectedKey ? 'live' : 'offline_replay',
  };
}
