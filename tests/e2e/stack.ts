/**
 * Shared description of the stack the e2e suite boots, plus the handshake file global-setup.ts writes
 * and the specs read. Kept free of @playwright/test imports so global-setup/teardown can use it too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const API_ORIGIN = 'http://127.0.0.1:4300';
export const UI_ORIGIN = 'http://127.0.0.1:5173';
export const STORE_ORIGIN = 'http://127.0.0.1:4310';
export const ADMIN_ORIGIN = 'http://127.0.0.1:4311';

/** Written by global-setup.ts, read by the specs and by global-teardown.ts. */
export const HANDSHAKE_PATH = resolve(process.cwd(), 'test-results', 'e2e-stack.json');

export interface StackHandshake {
  token: string;
  dataDir: string;
  /** PIDs of the spawned shells; killed with `taskkill /PID <pid> /T /F` on Windows. */
  pids: number[];
  virtualClockStart: string;
}

export function readHandshake(): StackHandshake {
  try {
    return JSON.parse(readFileSync(HANDSHAKE_PATH, 'utf8')) as StackHandshake;
  } catch (err) {
    throw new Error(`E2E stack handshake missing at ${HANDSHAKE_PATH}. Run the suite through "npm run test:e2e" so globalSetup boots the stack first. (${String(err)})`);
  }
}

/** The session token, from the env global-setup exported or from the handshake file as a fallback. */
export function sessionToken(): string {
  return process.env.BTS_E2E_TOKEN ?? readHandshake().token;
}
