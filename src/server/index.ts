/**
 * Entry point for `npm run server`. Loads config, opens storage, wires the (possibly still-missing)
 * concurrent modules through wiring.ts, starts the worker, and serves the local API on 127.0.0.1 only.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { describeModelClient } from '../agent/modelClient.ts';
import { Store } from '../storage/db.ts';
import { SystemClock, VirtualClock } from '../domain/time.ts';
import { createApiHandler } from './api.ts';
import { buildWiring } from './wiring.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  mkdirSync(config.dataDir, { recursive: true });

  const sessionToken = randomBytes(32).toString('hex');
  const tokenPath = join(config.dataDir, 'session-token');
  writeFileSync(tokenPath, sessionToken, { mode: 0o600 });

  // Bind the port *before* opening storage or launching a browser: a port conflict then fails fast
  // without leaving a worker timer or a Playwright browser process orphaned behind a rejected promise.
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(config.apiPort, '127.0.0.1', () => resolvePromise());
  });

  const store = new Store(join(config.dataDir, 'bts.sqlite'));

  const virtualStart = process.env.BTS_VIRTUAL_CLOCK_START;
  const clock = virtualStart ? new VirtualClock(virtualStart) : new SystemClock();

  const wiring = await buildWiring({ store, clock, config });
  for (const warning of wiring.warnings) {
    console.warn(`[BTS] degraded capability: ${warning}`);
  }

  wiring.worker.start(1000);

  server.on(
    'request',
    createApiHandler({
      store,
      worker: wiring.worker,
      config,
      sessionToken,
      clock,
      importAnnouncement: wiring.importAnnouncement,
      demoAdmin: { origin: config.demoAdminOrigin },
      capabilities: wiring.capabilities,
    }),
  );

  printBanner(config, sessionToken, tokenPath, wiring.capabilities, virtualStart !== undefined);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[BTS] shutting down...');
    await wiring.worker.stop();
    await wiring.shutdown();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function printBanner(
  config: Awaited<ReturnType<typeof loadConfig>>,
  sessionToken: string,
  tokenPath: string,
  capabilities: { extraction: string; interpreter: string; demoBrowser: string },
  virtualClock: boolean,
): void {
  const modelDescription = describeModelClient(config);
  const missingKeyName = config.modelProvider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  const lines = [
    '',
    '=== BTS - Beat The Scalper ===',
    `Mode:           ${config.mode}`,
    `Model path:     ${config.modelPath}${config.modelPath === 'offline_replay' ? ` (no ${missingKeyName}; extraction/interpreter run in labelled offline replay)` : ''}`,
    `Model:          ${config.modelProvider}/${modelDescription.model} (${modelDescription.detail})`,
    `Capabilities:   extraction=${capabilities.extraction} interpreter=${capabilities.interpreter} demoBrowser=${capabilities.demoBrowser}`,
    `Clock:          ${virtualClock ? 'VIRTUAL (accelerated demo clock, see BTS_VIRTUAL_CLOCK_START)' : 'system'}`,
    `API URL:        http://127.0.0.1:${config.apiPort}`,
    `UI URL:         http://127.0.0.1:${config.uiPort} (run "npm run ui" separately)`,
    `Demo store URL: ${config.demoStoreOrigin}`,
    `Session token:  ${sessionToken}`,
    `Token file:     ${tokenPath}`,
    '',
  ];
  if (config.mode === 'lazada_assist' && !config.liveObserveEnabled) {
    lines.push('WARNING: Live Lazada observation: BLOCKED (feasibility gate). See docs/lazada-feasibility.md.', '');
  }
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('[BTS] fatal startup error:', err);
  // Force-exit: an open worker timer or browser process launched before the failure would otherwise
  // keep the event loop alive indefinitely with `process.exitCode` alone.
  process.exit(1);
});
