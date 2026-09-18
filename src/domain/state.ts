import type { MissionState } from './types.ts';

/**
 * Mission state machine (brief Section 9). PAUSED/CANCELLED/EXPIRED stop future work but never
 * erase an unresolved handoff/submission; those remain visible on the attempt record.
 */
const TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  DRAFT: ['WATCHING', 'CANCELLED', 'EXPIRED'],
  WATCHING: ['CANDIDATE', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  CANDIDATE: ['VALIDATING', 'WATCHING', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  VALIDATING: ['PREPARING', 'WATCHING', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  PREPARING: ['CHECKOUT_READY', 'WATCHING', 'PAUSED', 'UNKNOWN', 'CANCELLED', 'EXPIRED'],
  CHECKOUT_READY: ['HANDOFF_LOCKED', 'SUBMISSION_STARTED', 'WATCHING', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  HANDOFF_LOCKED: ['ORDER_OBSERVED', 'UNKNOWN', 'WATCHING'],
  SUBMISSION_STARTED: ['ORDER_OBSERVED', 'UNKNOWN'],
  ORDER_OBSERVED: ['COMPLETED', 'UNKNOWN'],
  UNKNOWN: ['ORDER_OBSERVED', 'WATCHING', 'COMPLETED'],
  COMPLETED: [],
  PAUSED: ['WATCHING', 'CANCELLED', 'EXPIRED'],
  CANCELLED: [],
  EXPIRED: [],
};

/** States in which a purchase-uncertainty lock is held; a worker lease expiring must not clear them. */
export const LOCKED_STATES: ReadonlySet<MissionState> = new Set(['HANDOFF_LOCKED', 'SUBMISSION_STARTED', 'ORDER_OBSERVED', 'UNKNOWN']);

/** States from which scheduling may take a fresh observation. */
export const OBSERVING_STATES: ReadonlySet<MissionState> = new Set(['WATCHING', 'CANDIDATE']);

export const TERMINAL_STATES: ReadonlySet<MissionState> = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED']);

export function canTransition(from: MissionState, to: MissionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: MissionState,
    public readonly to: MissionState,
  ) {
    super(`Illegal mission transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: MissionState, to: MissionState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Cancellation/expiry rule: a locked state cannot be cancelled away. The mission records the request
 * and stays locked until reconciliation resolves the attempt.
 */
export function stopRequestOutcome(current: MissionState, requested: 'CANCELLED' | 'EXPIRED' | 'PAUSED'): MissionState {
  if (LOCKED_STATES.has(current)) return current;
  if (TERMINAL_STATES.has(current)) return current;
  return requested;
}
