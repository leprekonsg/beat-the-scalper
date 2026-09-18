/**
 * SQLite storage via node:sqlite (Node >= 22.13, no native build). Five tables: missions, events,
 * attempts, evidence, settings. Immutable intent revisions live in events; missions holds the snapshot.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attempt, AttemptState, Event, Evidence, MissionState, Observation, PurchaseIntent, Provenance } from '../domain/types.ts';
import { AttemptSchema, EventSchema, EvidenceSchema, ObservationSchema, PurchaseIntentSchema } from '../domain/types.ts';
import { assertTransition, LOCKED_STATES } from '../domain/state.ts';

export interface MissionRow {
  id: string;
  state: MissionState;
  intent: PurchaseIntent;
  lastAvailability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  lastSuccessfulObservationId: string | null;
  lastObservationId: string | null;
  nextCheckAt: string | null;
  observationInFlightSince: string | null;
  executionLockAttemptId: string | null;
  generation: number;
  consecutiveFailures: number;
  pauseReason: string | null;
  stopRequested: 'CANCELLED' | 'EXPIRED' | null;
  createdAt: string;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  fulfillment_key TEXT NOT NULL UNIQUE,
  last_availability TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_successful_observation_id TEXT,
  last_observation_id TEXT,
  next_check_at TEXT,
  observation_in_flight_since TEXT,
  execution_lock_attempt_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  stop_requested TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  mission_id TEXT,
  attempt_id TEXT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  provenance TEXT NOT NULL,
  affected_target TEXT,
  dedupe_key TEXT UNIQUE,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_mission_at ON events(mission_id, at);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  observation_id TEXT,
  approved_cart_digest TEXT,
  checkout_session_id TEXT,
  last_dispatched_action TEXT,
  handoff_at TEXT,
  submission_at TEXT,
  merchant_order_ref TEXT,
  reconciliation_outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mission_id, generation)
);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_mission ON observations(mission_id, captured_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- settings ----------
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- missions ----------
  private rowToMission(r: Record<string, unknown>): MissionRow {
    return {
      id: r.id as string,
      state: r.state as MissionState,
      intent: PurchaseIntentSchema.parse(JSON.parse(r.intent_json as string)),
      lastAvailability: r.last_availability as MissionRow['lastAvailability'],
      lastSuccessfulObservationId: (r.last_successful_observation_id as string | null) ?? null,
      lastObservationId: (r.last_observation_id as string | null) ?? null,
      nextCheckAt: (r.next_check_at as string | null) ?? null,
      observationInFlightSince: (r.observation_in_flight_since as string | null) ?? null,
      executionLockAttemptId: (r.execution_lock_attempt_id as string | null) ?? null,
      generation: Number(r.generation),
      consecutiveFailures: Number(r.consecutive_failures),
      pauseReason: (r.pause_reason as string | null) ?? null,
      stopRequested: (r.stop_requested as MissionRow['stopRequested']) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  createMission(intent: PurchaseIntent, now: string): MissionRow {
    PurchaseIntentSchema.parse(intent);
    const active = this.listMissions().find((m) => !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(m.state));
    if (active) throw new Error(`One active mission at a time. Cancel or complete mission ${active.id} first`);
    this.db
      .prepare('INSERT INTO missions(id, state, intent_json, fulfillment_key, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(intent.id, 'DRAFT', JSON.stringify(intent), intent.fulfillmentKey, now, now);
    this.appendEvent({ missionId: intent.id, type: 'intent.drafted', at: now, provenance: 'manual_input', payload: { intent }, affectedTarget: intent.target.productUrl });
    return this.getMission(intent.id)!;
  }

  getMission(id: string): MissionRow | null {
    const r = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToMission(r) : null;
  }

  listMissions(): MissionRow[] {
    const rows = this.db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMission(r));
  }

  activeMission(): MissionRow | null {
    return this.listMissions().find((m) => !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(m.state)) ?? null;
  }

  /** Replace the intent snapshot with a new revision. Fulfillment key is immutable. */
  updateIntent(id: string, next: PurchaseIntent, now: string, reason: string): MissionRow {
    const m = this.getMission(id);
    if (!m) throw new Error(`Mission ${id} not found`);
    if (next.fulfillmentKey !== m.intent.fulfillmentKey) throw new Error('fulfillmentKey is immutable across intent edits');
    if (next.revision !== m.intent.revision + 1) throw new Error(`Intent revision must increment by one (have ${m.intent.revision}, got ${next.revision})`);
    PurchaseIntentSchema.parse(next);
    this.transaction(() => {
      this.db.prepare('UPDATE missions SET intent_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now, id);
      this.appendEvent({ missionId: id, type: 'intent.revised', at: now, provenance: 'manual_input', payload: { revision: next.revision, reason, intent: next }, affectedTarget: next.target.productUrl });
    });
    return this.getMission(id)!;
  }

  /** Atomic state transition; throws on an illegal edge. */
  transition(id: string, to: MissionState, now: string, payload: Record<string, unknown> = {}, provenance: Provenance = 'demo'): MissionRow {
    return this.transaction(() => {
      const m = this.getMission(id);
      if (!m) throw new Error(`Mission ${id} not found`);
      assertTransition(m.state, to);
      this.db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(to, now, id);
      this.appendEvent({ missionId: id, type: 'mission.transition', at: now, provenance, payload: { from: m.state, to, ...payload }, affectedTarget: m.intent.target.productUrl });
      return this.getMission(id)!;
    });
  }

  patchMission(id: string, patch: Partial<Pick<MissionRow, 'lastAvailability' | 'lastSuccessfulObservationId' | 'lastObservationId' | 'nextCheckAt' | 'observationInFlightSince' | 'executionLockAttemptId' | 'consecutiveFailures' | 'pauseReason' | 'stopRequested'>>, now: string): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      lastAvailability: 'last_availability',
      lastSuccessfulObservationId: 'last_successful_observation_id',
      lastObservationId: 'last_observation_id',
      nextCheckAt: 'next_check_at',
      observationInFlightSince: 'observation_in_flight_since',
      executionLockAttemptId: 'execution_lock_attempt_id',
      consecutiveFailures: 'consecutive_failures',
      pauseReason: 'pause_reason',
      stopRequested: 'stop_requested',
    };
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    cols.push('updated_at = ?');
    vals.push(now, id);
    this.db.prepare(`UPDATE missions SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }

  /** Claim the single outstanding observation slot. Returns false if one is already in flight. */
  claimObservation(id: string, now: string, staleAfterMs: number): boolean {
    return this.transaction(() => {
      const m = this.getMission(id)!;
      if (m.observationInFlightSince && Date.parse(now) - Date.parse(m.observationInFlightSince) < staleAfterMs) return false;
      this.db.prepare('UPDATE missions SET observation_in_flight_since = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return true;
    });
  }

  releaseObservation(id: string, now: string): void {
    this.db.prepare('UPDATE missions SET observation_in_flight_since = NULL, updated_at = ? WHERE id = ?').run(now, id);
  }

  // ---------- attempts ----------
  private rowToAttempt(r: Record<string, unknown>): Attempt {
    return AttemptSchema.parse({
      attemptId: r.attempt_id,
      missionId: r.mission_id,
      intentRevision: Number(r.intent_revision),
      generation: Number(r.generation),
      state: r.state,
      observationId: r.observation_id ?? null,
      approvedCartDigest: r.approved_cart_digest ?? null,
      checkoutSessionId: r.checkout_session_id ?? null,
      lastDispatchedAction: r.last_dispatched_action ?? null,
      handoffAt: r.handoff_at ?? null,
      submissionAt: r.submission_at ?? null,
      merchantOrderRef: r.merchant_order_ref ?? null,
      reconciliationOutcome: r.reconciliation_outcome ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  /**
   * Claim the account execution lock with a new monotonically increasing generation.
   * Fails when a lock is held or an unresolved prior submission exists.
   */
  claimAttempt(missionId: string, observationId: string, now: string): Attempt {
    return this.transaction(() => {
      const m = this.getMission(missionId);
      if (!m) throw new Error(`Mission ${missionId} not found`);
      if (m.executionLockAttemptId) throw new Error(`Execution lock held by attempt ${m.executionLockAttemptId}`);
      const unresolved = this.listAttempts(missionId).find((a) => ['SUBMISSION_STARTED', 'HANDOFF_LOCKED', 'UNKNOWN', 'ORDER_OBSERVED'].includes(a.state));
      if (unresolved) throw new Error(`Unresolved prior attempt ${unresolved.attemptId} in ${unresolved.state}; reconcile before any new attempt`);
      const generation = m.generation + 1;
      const attemptId = `att_${randomUUID()}`;
      this.db
        .prepare('INSERT INTO attempts(attempt_id, mission_id, intent_revision, generation, state, observation_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(attemptId, missionId, m.intent.revision, generation, 'CLAIMED', observationId, now, now);
      this.db.prepare('UPDATE missions SET generation = ?, execution_lock_attempt_id = ?, updated_at = ? WHERE id = ?').run(generation, attemptId, now, missionId);
      this.appendEvent({ missionId, attemptId, type: 'attempt.claimed', at: now, provenance: 'demo', payload: { generation, intentRevision: m.intent.revision, observationId }, affectedTarget: m.intent.target.productUrl });
      return this.getAttempt(attemptId)!;
    });
  }

  getAttempt(attemptId: string): Attempt | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
    return r ? this.rowToAttempt(r) : null;
  }

  listAttempts(missionId: string): Attempt[] {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE mission_id = ? ORDER BY generation DESC').all(missionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAttempt(r));
  }

  /**
   * Update an attempt only if the caller holds the current generation. Stale workers get an error.
   * Durable boundaries (SUBMISSION_STARTED, HANDOFF_LOCKED) are written here before any external action.
   */
  updateAttempt(attemptId: string, expectedGeneration: number, patch: Partial<Pick<Attempt, 'state' | 'approvedCartDigest' | 'checkoutSessionId' | 'lastDispatchedAction' | 'handoffAt' | 'submissionAt' | 'merchantOrderRef' | 'reconciliationOutcome'>>, now: string, eventType?: string, eventPayload: Record<string, unknown> = {}): Attempt {
    return this.transaction(() => {
      const a = this.getAttempt(attemptId);
      if (!a) throw new Error(`Attempt ${attemptId} not found`);
      const m = this.getMission(a.missionId)!;
      if (a.generation !== expectedGeneration || m.generation !== expectedGeneration) {
        throw new StaleGenerationError(`Stale generation ${expectedGeneration}; current is ${m.generation}`);
      }
      if (m.stopRequested && patch.state && !['UNKNOWN', 'ORDER_OBSERVED', 'COMPLETED', 'ABANDONED'].includes(patch.state) && !LOCKED_STATES.has(m.state)) {
        throw new StaleGenerationError(`Mission stop requested (${m.stopRequested}); action rejected`);
      }
      const map: Record<string, string> = {
        state: 'state',
        approvedCartDigest: 'approved_cart_digest',
        checkoutSessionId: 'checkout_session_id',
        lastDispatchedAction: 'last_dispatched_action',
        handoffAt: 'handoff_at',
        submissionAt: 'submission_at',
        merchantOrderRef: 'merchant_order_ref',
        reconciliationOutcome: 'reconciliation_outcome',
      };
      const cols: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        cols.push(`${map[k]} = ?`);
        vals.push(v ?? null);
      }
      cols.push('updated_at = ?');
      vals.push(now, attemptId);
      this.db.prepare(`UPDATE attempts SET ${cols.join(', ')} WHERE attempt_id = ?`).run(...(vals as never[]));
      if (eventType) this.appendEvent({ missionId: a.missionId, attemptId, type: eventType, at: now, provenance: 'demo', payload: { generation: expectedGeneration, ...patch, ...eventPayload }, affectedTarget: m.intent.target.productUrl });
      return this.getAttempt(attemptId)!;
    });
  }

  releaseExecutionLock(missionId: string, now: string): void {
    this.db.prepare('UPDATE missions SET execution_lock_attempt_id = NULL, updated_at = ? WHERE id = ?').run(now, missionId);
  }

  // ---------- evidence & observations ----------
  putEvidence(e: Evidence): void {
    EvidenceSchema.parse(e);
    this.db.prepare('INSERT OR REPLACE INTO evidence(evidence_id, json, received_at) VALUES(?, ?, ?)').run(e.evidenceId, JSON.stringify(e), e.receivedAt);
  }
  getEvidence(id: string): Evidence | null {
    const r = this.db.prepare('SELECT json FROM evidence WHERE evidence_id = ?').get(id) as { json: string } | undefined;
    return r ? EvidenceSchema.parse(JSON.parse(r.json)) : null;
  }
  listEvidence(limit = 50): Evidence[] {
    const rows = this.db.prepare('SELECT json FROM evidence ORDER BY received_at DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => EvidenceSchema.parse(JSON.parse(r.json)));
  }

  putObservation(o: Observation): void {
    ObservationSchema.parse(o);
    this.db.prepare('INSERT OR REPLACE INTO observations(observation_id, mission_id, captured_at, json) VALUES(?, ?, ?, ?)').run(o.observationId, o.missionId, o.capturedAt, JSON.stringify(o));
  }
  getObservation(id: string): Observation | null {
    const r = this.db.prepare('SELECT json FROM observations WHERE observation_id = ?').get(id) as { json: string } | undefined;
    return r ? ObservationSchema.parse(JSON.parse(r.json)) : null;
  }

  // ---------- events ----------
  appendEvent(e: { eventId?: string; missionId?: string | null; attemptId?: string | null; type: string; at: string; provenance: Provenance; affectedTarget?: string | null; dedupeKey?: string | null; payload: Record<string, unknown> }): Event | null {
    const ev: Event = EventSchema.parse({
      eventId: e.eventId ?? `evt_${randomUUID()}`,
      missionId: e.missionId ?? null,
      attemptId: e.attemptId ?? null,
      type: e.type,
      at: e.at,
      provenance: e.provenance,
      affectedTarget: e.affectedTarget ?? null,
      dedupeKey: e.dedupeKey ?? null,
      payload: redact(e.payload),
    });
    try {
      this.db
        .prepare('INSERT INTO events(event_id, mission_id, attempt_id, type, at, provenance, affected_target, dedupe_key, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ev.eventId, ev.missionId, ev.attemptId, ev.type, ev.at, ev.provenance, ev.affectedTarget, ev.dedupeKey, JSON.stringify(ev.payload));
      return ev;
    } catch (err) {
      if (ev.dedupeKey && String(err).includes('UNIQUE')) return null; // duplicate signal: recorded once, ignored now
      throw err;
    }
  }

  listEvents(missionId: string | null, limit = 200): Event[] {
    const rows = (
      missionId
        ? this.db.prepare('SELECT * FROM events WHERE mission_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(missionId, limit)
        : this.db.prepare('SELECT * FROM events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) =>
      EventSchema.parse({
        eventId: r.event_id,
        missionId: r.mission_id ?? null,
        attemptId: r.attempt_id ?? null,
        type: r.type,
        at: r.at,
        provenance: r.provenance,
        affectedTarget: r.affected_target ?? null,
        dedupeKey: r.dedupe_key ?? null,
        payload: JSON.parse(r.payload_json as string),
      }),
    );
  }
}

export class StaleGenerationError extends Error {}

/**
 * Credential-like keys, matched as whole words at the end of the key (snake_case, kebab-case, or camelCase),
 * so `sessionToken`, `auth_token`, `shippingAddress` redact but `missedTicksDiscarded` does not.
 */
const SENSITIVE_KEYS = /(?:^|[_-])(?:cookies?|tokens?|passwords?|secrets?|authorization|cards?|cardnumber|cvv|address(?:es)?)$|[a-z0-9](?:Cookies?|Tokens?|Passwords?|Secrets?|Authorization|Cards?|CardNumber|Cvv|Address(?:es)?)$/;

/** Strip credential-like keys from anything persisted to events. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v);
    }
    return out as T;
  }
  return value;
}

export type { Attempt, AttemptState };
