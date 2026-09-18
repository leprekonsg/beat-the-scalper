/**
 * Lightweight mirrors of the server's JSON shapes (see src/domain/types.ts and src/worker/types.ts).
 * Kept local to the UI so a display-only mismatch in a concurrently-developed module never blocks the
 * dashboard from rendering the fields it does receive.
 */

export type Availability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type MissionState =
  | 'DRAFT'
  | 'WATCHING'
  | 'CANDIDATE'
  | 'VALIDATING'
  | 'PREPARING'
  | 'CHECKOUT_READY'
  | 'HANDOFF_LOCKED'
  | 'SUBMISSION_STARTED'
  | 'ORDER_OBSERVED'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'PAUSED'
  | 'CANCELLED'
  | 'EXPIRED';
export type MonitorHealth = 'Healthy' | 'Degraded' | 'Paused' | 'Expired' | 'Disabled' | 'Starting';
export type Provenance = 'live_verified' | 'manual_input' | 'demo' | 'offline_replay' | 'blocked';
export type LaunchBasis = 'source_confirmed' | 'user_expected' | 'unknown';
export type PackagingPolicy = 'must_be_intact' | 'removed_allowed' | 'ask';
export type PackagingCondition = 'stated_intact' | 'stated_removed' | 'not_stated' | 'unreadable';
export type Authority = 'observe' | 'prepare' | 'demo_purchase';
export type Mode = 'demo' | 'lazada_assist';

export interface Target {
  productUrl: string | null;
  retailerProductId: string | null;
  variantId: string | null;
  sellerRef: string | null;
  sellerEvidenceId: string | null;
  productFormat: string;
  language: string;
  description: string;
}

export interface RestockWindow {
  timezone: string;
  startLocal: string;
  endLocal: string;
  basis: string;
  enabled: boolean;
}

export interface PurchaseIntent {
  id: string;
  revision: number;
  fulfillmentKey: string;
  mode: Mode;
  accountRef: string;
  target: Target;
  quantity: 1;
  currency: 'SGD';
  maxDeliveredPriceMinor: number;
  packagingPolicy: PackagingPolicy;
  allowedConditionEvidenceIds: string[];
  launchAt: string | null;
  launchBasis: LaunchBasis;
  launchEvidenceId: string | null;
  restockWindow: RestockWindow;
  expiresAt: string;
  authority: Authority;
}

export interface MissionRow {
  id: string;
  state: MissionState;
  intent: PurchaseIntent;
  lastAvailability: Availability;
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

export interface OfferedItem {
  retailerProductId: string | null;
  variantId: string | null;
  variantLabel: string | null;
  sellerRef: string | null;
  sellerLabel: string | null;
  productFormat: string | null;
  language: string | null;
  title: string | null;
  itemPriceMinor: number | null;
  deliveryFeeMinor: number | null;
  deliveredTotalMinor: number | null;
  packagingCondition: PackagingCondition;
  packagingEvidenceRegion: string | null;
  purchaseLimit: number | null;
}

export interface Observation {
  observationId: string;
  missionId: string;
  evidenceId: string;
  provenance: Provenance;
  capturedAt: string;
  pageRevision: string;
  availability: Availability;
  offer: OfferedItem | null;
  accessControl: 'none' | 'captcha' | 'queue' | 'rate_limited' | 'login_expired' | 'unsupported_layout';
  retryAfterSeconds: number | null;
  error: string | null;
}

export interface Attempt {
  attemptId: string;
  missionId: string;
  intentRevision: number;
  generation: number;
  state: string;
  observationId: string | null;
  approvedCartDigest: string | null;
  checkoutSessionId: string | null;
  lastDispatchedAction: string | null;
  handoffAt: string | null;
  submissionAt: string | null;
  merchantOrderRef: string | null;
  reconciliationOutcome: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  eventId: string;
  missionId: string | null;
  attemptId: string | null;
  type: string;
  at: string;
  provenance: Provenance;
  affectedTarget: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
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

export interface CheckResult {
  check: string;
  verdict: string;
  detail: string;
}

export interface MissionView {
  mission: MissionRow;
  state: MissionState;
  intent: PurchaseIntent;
  lastSuccessfulObservation: Observation | null;
  lastObservation: Observation | null;
  attempts: Attempt[];
  events: EventRecord[];
  latency: LatencyMarks;
  eligibility: { verdict: 'eligible' | 'ineligible' | 'unknown'; checks: CheckResult[] } | null;
}

export interface HealthSnapshot {
  health: MonitorHealth;
  workerHeartbeatAt: string | null;
  lastSuccessfulObservationAt: string | null;
  latestAttemptOutcome: string | null;
  nextCheckAt: string | null;
  cadence: string | null;
  cadenceLabels: string[];
  apiReadiness: 'live' | 'offline_replay' | 'blocked';
  browserReadiness: 'ready' | 'not_started' | 'failed';
  currentAction: string | null;
  missedChecks: number;
  clock: { kind: 'system' | 'virtual'; now: string; accelerated: boolean };
}

export interface HealthResponse {
  ok: true;
  health: HealthSnapshot;
  mode: Mode;
  modelPath: 'live' | 'offline_replay';
  model: string;
  effort: string;
  monitorPolicy: unknown;
  liveStatus: { observe: 'enabled' | 'blocked'; prepare: 'enabled' | 'blocked'; feasibilityNote: string };
  capabilities: { extraction: 'ready' | 'missing'; interpreter: 'ready' | 'missing'; demoBrowser: 'ready' | 'missing' };
  demoStoreOrigin: string;
  demoAdminOrigin: string;
}

export interface StateResponse {
  mission: MissionView | null;
  missions: MissionRow[];
  health: HealthSnapshot;
  recentEvents: EventRecord[];
}

export interface FactValue<T> {
  value: T | null;
  evidenceId: string | null;
  span: string | null;
  reason: string | null;
}

export interface AnnouncementExtraction {
  productFormat: FactValue<string>;
  productName: FactValue<string>;
  language: FactValue<string>;
  market: FactValue<string>;
  releaseDateLocal: FactValue<string>;
  releaseTimeLocal: FactValue<string>;
  timezone: FactValue<string>;
  sellerOrChannel: FactValue<string>;
  purchaseLimit: FactValue<number>;
  statedConditions: FactValue<string>[];
  packagingCondition: FactValue<PackagingCondition>;
  relativeAge: FactValue<string>;
  dateBasis: LaunchBasis;
  missingFactsForActionableIntent: string[];
  notes: string | null;
}

export interface ImportResult {
  evidenceId: string;
  extraction: AnnouncementExtraction;
  provenance: string;
  label: string;
  launchPlan: { launchAt: string | null; launchBasis: LaunchBasis; preflightAt: string | null; message: string };
  missingFacts: string[];
  usage: unknown;
}

export interface ImportPrefill {
  productFormat?: string;
  language?: string;
  launchDateLocal?: string | null;
  launchTimeLocal?: string | null;
  launchBasis?: LaunchBasis;
  packagingPolicy?: PackagingPolicy;
}

export interface MissionDraftInput {
  mode: Mode;
  description: string;
  productUrl: string | null;
  retailerProductId: string | null;
  variantId: string | null;
  sellerRef: string | null;
  sellerEvidenceId: string | null;
  productFormat: string;
  language: string;
  maxDeliveredPriceSgd: string;
  packagingPolicy: PackagingPolicy;
  launch: { dateLocal: string | null; timeLocal: string | null; basis: LaunchBasis };
  restockWindowEnabled: boolean;
  expiresAt: string | null;
  authority: Authority;
}
