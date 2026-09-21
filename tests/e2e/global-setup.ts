/**
 * Boots the demo stack for the e2e suite the way scripts/capture-ui.ts does: demo storefront, local API,
 * and Vite, on the fixed loopback ports, against a throwaway BTS_DATA_DIR and a virtual clock pinned to
 * 12:58 Asia/Singapore (04:58Z) so "Next 13:00" and the restock window are reachable with clock advances.
 *
 * ANTHROPIC_API_KEY is deliberately blanked for the children: the suite must be deterministic, free, and
 * offline, so extraction/interpretation run through the labelled offline-replay fixtures.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ADMIN_ORIGIN, API_ORIGIN, HANDSHAKE_PATH, STORE_ORIGIN, UI_ORIGIN, type StackHandshake } from './stack.ts';

const root = process.cwd();

function virtualClockStart(): string {
  // 12:58 Asia/Singapore today = 04:58 UTC.
  return `${new Date().toISOString().slice(0, 10)}T04:58:00.000Z`;
}

async function assertPortFree(url: string, label: string): Promise<void> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {
    return; // nothing listening: what we want
  }
  throw new Error(`${label} is already listening at ${url}. Stop the running BTS stack (npm start / npm run server) before "npm run test:e2e" - the suite needs those fixed ports.`);
}

async function waitFor(url: string, label: string, ms = 90_000): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not come up at ${url} within ${ms}ms (last: ${last})`);
}

export default async function globalSetup(): Promise<void> {
  await assertPortFree(`${API_ORIGIN}/api/health`, 'The BTS API');
  await assertPortFree(`${STORE_ORIGIN}/`, 'The demo storefront');
  await assertPortFree(`${UI_ORIGIN}/`, 'The Vite UI server');

  const dataDir = resolve(root, 'data', `e2e-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(HANDSHAKE_PATH), { recursive: true });

  const start = virtualClockStart();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BTS_DATA_DIR: dataDir,
    BTS_MODE: 'demo',
    BTS_VIRTUAL_CLOCK_START: start,
    // Offline replay only. config.ts's .env loader never overwrites an already-defined variable, so an
    // empty string here wins over the developer's .env key and forces modelPath=offline_replay.
    ANTHROPIC_API_KEY: '',
    // Both provider keys are blanked and the provider is pinned, so the suite is offline whatever BTS_MODEL_PROVIDER the developer's environment sets.
    GEMINI_API_KEY: '',
    BTS_MODEL_PROVIDER: 'anthropic',
  };

  const children: ChildProcess[] = [];
  const spawnChild = (cmd: string, args: string[], name: string): void => {
    const child = spawn(cmd, args, { env, cwd: root, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${name}] ${String(d)}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${name}] ${String(d)}`));
    children.push(child);
  };

  spawnChild('npx', ['tsx', 'demo/store/server.ts'], 'store');
  spawnChild('npx', ['tsx', 'src/server/index.ts'], 'api');
  spawnChild('npx', ['vite', '--config', 'src/ui/vite.config.ts', '--port', '5173', '--strictPort'], 'ui');

  const pids = children.map((c) => c.pid).filter((p): p is number => typeof p === 'number');
  // Write the handshake before waiting: if a service never comes up, teardown still knows what to kill.
  const handshake: StackHandshake = { token: '', dataDir, pids, virtualClockStart: start };
  writeFileSync(HANDSHAKE_PATH, JSON.stringify(handshake, null, 2));

  await waitFor(`${STORE_ORIGIN}/`, 'demo store');
  await waitFor(`${ADMIN_ORIGIN}/`, 'demo store admin');
  await waitFor(`${API_ORIGIN}/api/health`, 'API');
  await waitFor(`${UI_ORIGIN}/`, 'UI');

  const tokenPath = resolve(dataDir, 'session-token');
  if (!existsSync(tokenPath)) throw new Error(`Session token not found at ${tokenPath}; the API did not finish bootstrapping.`);
  handshake.token = readFileSync(tokenPath, 'utf8').trim();
  writeFileSync(HANDSHAKE_PATH, JSON.stringify(handshake, null, 2));
  process.env.BTS_E2E_TOKEN = handshake.token;

  const health = (await (await fetch(`${API_ORIGIN}/api/health`)).json()) as {
    mode: string;
    modelPath: string;
    modelProvider: string;
    capabilities: Record<string, string>;
    health: { clock: { kind: string; now: string } };
  };
  if (health.health.clock.kind !== 'virtual') throw new Error('API did not start with a virtual clock; BTS_VIRTUAL_CLOCK_START was not honoured.');
  if (health.capabilities.demoBrowser !== 'ready') throw new Error(`Demo browser capability is "${health.capabilities.demoBrowser}"; the suite cannot observe the storefront. Run "npx playwright install chromium".`);
  if (health.modelPath !== 'offline_replay') throw new Error(`API started with modelPath="${health.modelPath}"; the e2e suite must run on the labelled offline-replay path.`);
  console.log(`[e2e] stack up: mode=${health.mode} modelProvider=${health.modelProvider} modelPath=${health.modelPath} clock=${health.health.clock.now} dataDir=${dataDir}`);
}
