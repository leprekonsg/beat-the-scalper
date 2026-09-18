/**
 * Worker contract consumed by the HTTP server and tests. Implemented in ./worker.ts.
 */
import type { Attempt, Event, MissionState, MonitorHealth, Observation, PurchaseIntent } from '../domain/types.ts';
import type { MissionRow } from '../storage/db.ts';
import type { CadenceLabel } from '../domain/scheduling.ts';

export interface HealthSnapshot {
  health: MonitorHealth;
  workerHeartbeatAt: string | null;
  lastSuccessfulObservationAt: string | null;
  latestAttemptOutcome: string | null;
  nextCheckAt: string | null;
  cadence: CadenceLabel | null;
  cadenceLabels: string[];
  apiReadiness: 'live' | 'offline_replay' | 'blocked';
  browserReadiness: 'ready' | 'not_started' | 'failed';
  currentAction: string | null;
  missedChecks: number;
  clock: { kind: 'system' | 'virtual'; now: string; accelerated: boolean };
}

export interface LatencyMarks {
  signalReceivedAt: string | null;
  observationStartAt: string | null;
  observationEndAt: string | null;
  candidateAt: string | null;
  validationDoneAt: string | null;
  checkoutReadyAt: string | null;
  handoffAt: string | null;
  submissionAt: string | null;
  orderObservedAt: string | null;
}

export interface MissionView {
  mission: MissionRow;
  state: MissionState;
  intent: PurchaseIntent;
  lastSuccessfulObservation: Observation | null;
  lastObservation: Observation | null;
  attempts: Attempt[];
  events: Event[];
  latency: LatencyMarks;
  eligibility: { verdict: 'eligible' | 'ineligible' | 'unknown'; checks: { check: string; verdict: string; detail: string }[] } | null;
}

export interface WorkerApi {
  /** Run one scheduler iteration. Idempotent; safe to call from a timer or a test. */
  tick(): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
  health(): HealthSnapshot;
  missionView(missionId: string): MissionView | null;
  /** Operations named in the brief (application interfaces, not retailer endpoints). */
  approveIntent(missionId: string, approval: { expiresAt: string; authority: PurchaseIntent['authority'] }): MissionRow;
  pauseMission(missionId: string, reason: string): MissionRow;
  resumeMission(missionId: string): MissionRow;
  cancelMission(missionId: string): MissionRow;
  /** User reports the outcome of a live handoff. */
  completeHandoff(missionId: string, outcome: { result: 'ordered' | 'not_ordered' | 'unknown'; merchantOrderRef: string | null }): MissionRow;
  /** User resolves a packaging/user-review pause by accepting a specific condition evidence ID. */
  acceptCondition(missionId: string, evidenceId: string): MissionRow;
  /** External signal (shared alert, official announcement). Deduped by key; queues one fresh observation. */
  importSignal(signal: { missionId: string; kind: 'restock_alert' | 'official_announcement' | 'user_note'; dedupeKey: string; evidenceId: string | null; receivedAt: string }): { queued: boolean; duplicate: boolean };
}
