/** Kills the stack global-setup.ts spawned and removes its throwaway data dir. */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { HANDSHAKE_PATH, readHandshake } from './stack.ts';

export default async function globalTeardown(): Promise<void> {
  let handshake;
  try {
    handshake = readHandshake();
  } catch {
    return;
  }

  for (const pid of handshake.pids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  // The stack is gone, so the session token in the handshake is dead; do not leave it lying around.
  rmSync(HANDSHAKE_PATH, { force: true });

  // The demo browser profile and SQLite WAL files can stay locked for a moment after the kill.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(handshake.dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.warn(`[e2e] could not remove ${handshake.dataDir}; data/ is gitignored, remove it manually if it matters.`);
}
