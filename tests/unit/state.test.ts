import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, IllegalTransitionError, LOCKED_STATES, stopRequestOutcome, TERMINAL_STATES } from '../../src/domain/state.ts';
import { MissionStateSchema, type MissionState } from '../../src/domain/types.ts';

/** The table from the brief, Section 9, restated here so the test is the specification. */
const LEGAL: Record<MissionState, MissionState[]> = {
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

const ALL_STATES = MissionStateSchema.options;
const edges = Object.entries(LEGAL).flatMap(([from, tos]) => tos.map((to) => ({ from: from as MissionState, to })));

describe('mission state machine', () => {
  it.each(edges)('allows the specified edge $from -> $to', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every edge not in the specified table', () => {
    const unexpected: string[] = [];
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const legal = LEGAL[from].includes(to);
        if (canTransition(from, to) !== legal) unexpected.push(`${from} -> ${to} (expected ${legal ? 'legal' : 'illegal'})`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it.each([
    { from: 'SUBMISSION_STARTED' as MissionState, to: 'WATCHING' as MissionState, why: 'a started submission must reconcile, not resume watching' },
    { from: 'HANDOFF_LOCKED' as MissionState, to: 'CANCELLED' as MissionState, why: 'A21: handoff uncertainty cannot be cancelled away' },
    { from: 'COMPLETED' as MissionState, to: 'WATCHING' as MissionState, why: 'COMPLETED is terminal' },
    { from: 'DRAFT' as MissionState, to: 'CANDIDATE' as MissionState, why: 'a draft must arm before it can hold a candidate' },
    { from: 'CANCELLED' as MissionState, to: 'WATCHING' as MissionState, why: 'CANCELLED is terminal' },
  ])('A22: rejects $from -> $to ($why)', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    expect(() => assertTransition(from, to)).toThrow(`Illegal mission transition ${from} -> ${to}`);
  });

  it('A22: COMPLETED permits no outgoing transition at all', () => {
    const allowed = ALL_STATES.filter((to) => canTransition('COMPLETED', to));
    expect(allowed).toEqual([]);
  });

  it.each([...LOCKED_STATES].map((state) => ({ state })))('A21/A22: stopRequestOutcome keeps the locked state $state', ({ state }) => {
    expect(stopRequestOutcome(state, 'CANCELLED')).toBe(state);
    expect(stopRequestOutcome(state, 'EXPIRED')).toBe(state);
    expect(stopRequestOutcome(state, 'PAUSED')).toBe(state);
  });

  it.each([...TERMINAL_STATES].map((state) => ({ state })))('stopRequestOutcome keeps the terminal state $state', ({ state }) => {
    expect(stopRequestOutcome(state, 'CANCELLED')).toBe(state);
    expect(stopRequestOutcome(state, 'EXPIRED')).toBe(state);
  });

  it.each([
    { current: 'WATCHING' as MissionState, requested: 'CANCELLED' as const },
    { current: 'CANDIDATE' as MissionState, requested: 'PAUSED' as const },
    { current: 'CHECKOUT_READY' as MissionState, requested: 'EXPIRED' as const },
  ])('stopRequestOutcome applies $requested from the unlocked state $current', ({ current, requested }) => {
    expect(stopRequestOutcome(current, requested)).toBe(requested);
  });
});
