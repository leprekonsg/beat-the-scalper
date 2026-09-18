/**
 * Boots the demo stack (store, API, UI) against a throwaway data dir with a virtual clock, arms a demo
 * mission, and captures dashboard screenshots into .impeccable/review/ for the design inspection round.
 *
 *   npx tsx scripts/capture-ui.ts
 *
 * Nothing here touches a real retailer. The stack is killed on exit.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const outDir = resolve(root, '.impeccable', 'review');
const dataDir = resolve(root, 'data', `capture-${Date.now()}`);
mkdirSync(outDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// Ports come from the environment so a capture can run beside another stack (e.g. the e2e suite).
const apiPort = process.env.BTS_API_PORT ?? '4300';
const uiPort = process.env.BTS_UI_PORT ?? '5173';
const storePort = process.env.BTS_DEMO_STORE_PORT ?? '4310';
const adminPort = process.env.BTS_DEMO_ADMIN_PORT ?? '4311';
const API = `http://127.0.0.1:${apiPort}`;
const UI = `http://127.0.0.1:${uiPort}`;
const STORE = `http://127.0.0.1:${storePort}`;
const ADMIN = `http://127.0.0.1:${adminPort}`;

// 12:58 Asia/Singapore today = 04:58 UTC. The window cell shows "Next 13:00" and one +10 min lands inside the window.
const today = new Date().toISOString().slice(0, 10);
const virtualStart = `${today}T04:58:00.000Z`;

const env = {
  ...process.env,
  BTS_DATA_DIR: dataDir,
  BTS_VIRTUAL_CLOCK_START: virtualStart,
  BTS_MODE: 'demo',
  BTS_API_PORT: apiPort,
  BTS_UI_PORT: uiPort,
  BTS_DEMO_STORE_PORT: storePort,
  BTS_DEMO_ADMIN_PORT: adminPort,
};
const children: ChildProcess[] = [];

function run(cmd: string, args: string[], name: string): ChildProcess {
  const child = spawn(cmd, args, { env, cwd: root, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => process.stdout.write(`[${name}] ${String(d)}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${name}] ${String(d)}`));
  children.push(child);
  return child;
}

async function waitFor(url: string, label: string, ms = 60_000): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? `${err.name}: ${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ''}` : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not come up at ${url} within ${ms}ms (last: ${last})`);
}

function killAll(): void {
  for (const c of children) {
    if (c.pid === undefined) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-bts-token': token, origin: UI, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  run('npx', ['tsx', 'demo/store/server.ts'], 'store');
  run('npx', ['tsx', 'src/server/index.ts'], 'api');
  run('npx', ['vite', '--config', 'src/ui/vite.config.ts', '--port', uiPort, '--strictPort'], 'ui');

  await waitFor(`${STORE}/`, 'demo store');
  await waitFor(`${API}/api/health`, 'API');
  await waitFor(`${UI}/`, 'UI');

  const tokenPath = resolve(dataDir, 'session-token');
  if (!existsSync(tokenPath)) throw new Error(`session token not found at ${tokenPath}`);
  const token = readFileSync(tokenPath, 'utf8').trim();

  const browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  page.on('pageerror', (err) => console.error('[page] error:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[page] ${msg.type()}: ${msg.text()}`);
  });

  // 1. connect state
  await page.goto(UI, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(outDir, 'connect-desktop.png'), fullPage: true });

  // 2. connected, no mission
  await page.evaluate((t) => sessionStorage.setItem('bts.sessionToken', t), token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('mission-form').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: resolve(outDir, 'empty-desktop.png'), fullPage: true });

  // 3. create and arm a demo mission against the owned storefront (etb-151/en starts out of stock)
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const created = await api<{ mission: { mission: { id: string } } }>(token, '/api/missions', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'demo',
      description: 'Pokemon TCG: Scarlet & Violet 151 Elite Trainer Box',
      productUrl: `${STORE}/product/etb-151?variant=en`,
      retailerProductId: 'etb-151',
      variantId: 'en',
      sellerRef: 'pokemon-store-online-sg',
      sellerEvidenceId: null,
      productFormat: 'Elite Trainer Box',
      language: 'English',
      maxDeliveredPriceSgd: '120.00',
      packagingPolicy: 'ask',
      launch: { dateLocal: null, timeLocal: null, basis: 'unknown' },
      restockWindowEnabled: true,
      expiresAt,
      authority: 'demo_purchase',
    }),
  });
  const missionId = created.mission.mission.id;
  await api(token, `/api/missions/${missionId}/approve`, { method: 'POST', body: JSON.stringify({ expiresAt, authority: 'demo_purchase' }) });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('candidate-card').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: resolve(outDir, 'desktop.png'), fullPage: true });

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mpage = await mobile.newPage();
  await mpage.goto(UI, { waitUntil: 'networkidle' });
  await mpage.evaluate((t) => sessionStorage.setItem('bts.sessionToken', t), token);
  await mpage.reload({ waitUntil: 'networkidle' });
  await mpage.getByTestId('candidate-card').waitFor({ timeout: 15_000 });
  await mpage.waitForTimeout(1500);
  await mpage.screenshot({ path: resolve(outDir, 'mobile.png'), fullPage: true });

  // 4. presenter publishes a restock; packaging policy 'ask' plus the stated wrap removal should pause for review
  await fetch(`${ADMIN}/admin/stock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: 'etb-151', variantId: 'en', quantity: 5 }) });
  await api(token, '/api/clock/advance', { method: 'POST', body: JSON.stringify({ ms: 120_000 }) });
  const deadline = Date.now() + 25_000;
  let state = '';
  while (Date.now() < deadline) {
    const s = await api<{ mission: { state: string } | null }>(token, '/api/state');
    state = s.mission?.state ?? '';
    if (state === 'PAUSED' || state === 'COMPLETED' || state === 'CHECKOUT_READY' || state === 'UNKNOWN') break;
    await new Promise((r) => setTimeout(r, 800));
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('candidate-card').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(outDir, 'review-desktop.png'), fullPage: true });
  await mpage.reload({ waitUntil: 'networkidle' });
  await mpage.waitForTimeout(2000);
  await mpage.screenshot({ path: resolve(outDir, 'review-mobile.png'), fullPage: true });

  console.log(JSON.stringify({ missionId, stateAfterRestock: state, outDir }, null, 2));
  await browser.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    killAll();
    setTimeout(() => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // browser profile may still be locked briefly; leave it, data/ is gitignored
      }
      process.exit(process.exitCode ?? 0);
    }, 1500);
  });
