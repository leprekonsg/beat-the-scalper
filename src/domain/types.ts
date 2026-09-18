/**
 * Runtime-validated domain contracts (Zod 4). Money is integer minor units (SGD cents).
 * Instants are ISO-8601 UTC strings.
 */
import { z } from 'zod';

export const AvailabilitySchema = z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const ModeSchema = z.enum(['demo', 'lazada_assist']);
export type Mode = z.infer<typeof ModeSchema>;

export const LaunchBasisSchema = z.enum(['source_confirmed', 'user_expected', 'unknown']);
export type LaunchBasis = z.infer<typeof LaunchBasisSchema>;

export const PackagingPolicySchema = z.enum(['must_be_intact', 'removed_allowed', 'ask']);
export type PackagingPolicy = z.infer<typeof PackagingPolicySchema>;

export const PackagingConditionSchema = z.enum(['stated_intact', 'stated_removed', 'not_stated', 'unreadable']);
export type PackagingCondition = z.infer<typeof PackagingConditionSchema>;

export const AuthoritySchema = z.enum(['observe', 'prepare', 'demo_purchase']);
export type Authority = z.infer<typeof AuthoritySchema>;

/** How a fact or result was obtained. Shown verbatim in the UI and reports. */
export const ProvenanceSchema = z.enum(['live_verified', 'manual_input', 'demo', 'offline_replay', 'blocked']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const MissionStateSchema = z.enum([
  'DRAFT',
  'WATCHING',
  'CANDIDATE',
  'VALIDATING',
  'PREPARING',
  'CHECKOUT_READY',
  'HANDOFF_LOCKED',
  'SUBMISSION_STARTED',
  'ORDER_OBSERVED',
  'UNKNOWN',
  'COMPLETED',
  'PAUSED',
  'CANCELLED',
  'EXPIRED',
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

export const MonitorHealthSchema = z.enum(['Healthy', 'Degraded', 'Paused', 'Expired', 'Disabled', 'Starting']);
export type MonitorHealth = z.infer<typeof MonitorHealthSchema>;

const IsoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && s.endsWith('Z'), {
  message: 'Expected an ISO-8601 UTC instant ending in Z',
});

export const TargetSchema = z.object({
  productUrl: z.url().nullable(),
  retailerProductId: z.string().min(1).nullable(),
  variantId: z.string().min(1).nullable(),
  sellerRef: z.string().min(1).nullable(),
  sellerEvidenceId: z.string().nullable(),
  productFormat: z.string().min(1),
  language: z.string().min(1),
  description: z.string(),
});
export type Target = z.infer<typeof TargetSchema>;

export const RestockWindowSchema = z.object({
  timezone: z.literal('Asia/Singapore'),
  startLocal: z.literal('13:00'),
  endLocal: z.literal('14:00'),
  basis: z.literal('user_observation'),
  enabled: z.boolean(),
});
export type RestockWindow = z.infer<typeof RestockWindowSchema>;

export const PurchaseIntentSchema = z.object({
  id: z.string().min(1),
  revision: z.int().min(1),
  fulfillmentKey: z.string().min(8),
  mode: ModeSchema,
  accountRef: z.string().min(1),
  target: TargetSchema,
  quantity: z.literal(1),
  currency: z.literal('SGD'),
  maxDeliveredPriceMinor: z.int().positive(),
  packagingPolicy: PackagingPolicySchema,
  allowedConditionEvidenceIds: z.array(z.string()),
  launchAt: IsoInstant.nullable(),
  launchBasis: LaunchBasisSchema,
  launchEvidenceId: z.string().nullable(),
  restockWindow: RestockWindowSchema,
  expiresAt: IsoInstant,
  authority: AuthoritySchema,
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

/** True when product, variant, and seller identities are all resolved. Drafts may still watch/observe. */
export function intentIsResolved(intent: PurchaseIntent): boolean {
  const t = intent.target;
  return Boolean(t.productUrl && t.retailerProductId && t.variantId && t.sellerRef);
}

export const SourceKindSchema = z.enum(['official_announcement', 'user_import', 'retailer_page', 'demo']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  sourceKind: SourceKindSchema,
  provenance: ProvenanceSchema,
  sourceUrl: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  capturedAt: IsoInstant.nullable(),
  sourcePublishedAt: IsoInstant.nullable(),
  receivedAt: IsoInstant,
  targetRef: z.string().nullable(),
  variantRef: z.string().nullable(),
  pageRevision: z.string().nullable(),
  observedFields: z.record(z.string(), z.unknown()),
  snapshotRef: z.string().nullable(),
  contentHash: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const OfferedItemSchema = z.object({
  retailerProductId: z.string().nullable(),
  variantId: z.string().nullable(),
  variantLabel: z.string().nullable(),
  sellerRef: z.string().nullable(),
  sellerLabel: z.string().nullable(),
  productFormat: z.string().nullable(),
  language: z.string().nullable(),
  title: z.string().nullable(),
  itemPriceMinor: z.int().nullable(),
  deliveryFeeMinor: z.int().nullable(),
  deliveredTotalMinor: z.int().nullable(),
  packagingCondition: PackagingConditionSchema,
  packagingEvidenceRegion: z.string().nullable(),
  purchaseLimit: z.int().nullable(),
});
export type OfferedItem = z.infer<typeof OfferedItemSchema>;

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  missionId: z.string().min(1),
  evidenceId: z.string().min(1),
  provenance: ProvenanceSchema,
  capturedAt: IsoInstant,
  pageRevision: z.string().min(1),
  availability: AvailabilitySchema,
  offer: OfferedItemSchema.nullable(),
  accessControl: z.enum(['none', 'captcha', 'queue', 'rate_limited', 'login_expired', 'unsupported_layout']),
  retryAfterSeconds: z.int().nullable(),
  error: z.string().nullable(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const AttemptStateSchema = z.enum([
  'CLAIMED',
  'PREPARING',
  'CHECKOUT_READY',
  'HANDOFF_LOCKED',
  'SUBMISSION_STARTED',
  'ORDER_OBSERVED',
  'UNKNOWN',
  'COMPLETED',
  'ABANDONED',
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export const AttemptSchema = z.object({
  attemptId: z.string().min(1),
  missionId: z.string().min(1),
  intentRevision: z.int().min(1),
  generation: z.int().min(1),
  state: AttemptStateSchema,
  observationId: z.string().nullable(),
  approvedCartDigest: z.string().nullable(),
  checkoutSessionId: z.string().nullable(),
  lastDispatchedAction: z.string().nullable(),
  handoffAt: IsoInstant.nullable(),
  submissionAt: IsoInstant.nullable(),
  merchantOrderRef: z.string().nullable(),
  reconciliationOutcome: z.string().nullable(),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const MonitorPolicySchema = z.object({
  mode: ModeSchema,
  baselineIntervalSeconds: z.int().positive().nullable(),
  priorityIntervalSeconds: z.int().positive().nullable(),
  maxObservationsPerOriginPerMinute: z.int().positive().nullable(),
  liveObserveEnabled: z.boolean(),
  livePrepareEnabled: z.boolean(),
  label: z.enum(['demo_defaults', 'reviewed_live', 'disabled']),
});
export type MonitorPolicy = z.infer<typeof MonitorPolicySchema>;

export const DEMO_MONITOR_POLICY: MonitorPolicy = {
  mode: 'demo',
  baselineIntervalSeconds: 30,
  priorityIntervalSeconds: 2,
  maxObservationsPerOriginPerMinute: 60,
  liveObserveEnabled: false,
  livePrepareEnabled: false,
  label: 'demo_defaults',
};

/** Structured-extraction result for an imported announcement. Model proposals; never verified facts. */
export const FactSchema = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    evidenceId: z.string().nullable(),
    span: z.string().nullable().describe('Readable text span or image region "x0,y0,x1,y1" supporting the value'),
    reason: z.string().nullable().describe('Why the value is null or uncertain'),
  });

export const AnnouncementExtractionSchema = z.object({
  productFormat: FactSchema(z.string()),
  productName: FactSchema(z.string()),
  language: FactSchema(z.string()),
  market: FactSchema(z.string()),
  releaseDateLocal: FactSchema(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  releaseTimeLocal: FactSchema(z.string().regex(/^\d{2}:\d{2}$/)),
  timezone: FactSchema(z.string()),
  sellerOrChannel: FactSchema(z.string()),
  purchaseLimit: FactSchema(z.int()),
  statedConditions: z.array(FactSchema(z.string())),
  packagingCondition: FactSchema(PackagingConditionSchema),
  relativeAge: FactSchema(z.string()).describe('e.g. "42 minutes ago" preserved verbatim; never resolved without an anchor'),
  dateBasis: z.enum(['source_confirmed', 'user_expected', 'unknown']),
  missingFactsForActionableIntent: z.array(z.string()),
  notes: z.string().nullable(),
});
export type AnnouncementExtraction = z.infer<typeof AnnouncementExtractionSchema>;

export const OfferAssessmentSchema = z.object({
  finding: z.string(),
  selectedVariantMatches: z.enum(['yes', 'no', 'unknown']),
  sellerMatches: z.enum(['yes', 'no', 'unknown']),
  productFormatMatches: z.enum(['yes', 'no', 'unknown']),
  packagingCondition: PackagingConditionSchema,
  packagingEvidenceRegion: z.string().nullable(),
  deliveredTotalMinor: z.int().nullable(),
  missingFacts: z.array(z.string()),
  requestedAction: z.enum(['none', 'reobserve', 'user_review', 'pause_handoff']),
  evidenceIds: z.array(z.string()),
});
export type OfferAssessment = z.infer<typeof OfferAssessmentSchema>;

export const EventSchema = z.object({
  eventId: z.string().min(1),
  missionId: z.string().nullable(),
  attemptId: z.string().nullable(),
  type: z.string().min(1),
  at: IsoInstant,
  provenance: ProvenanceSchema,
  affectedTarget: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof EventSchema>;

/**
 * Wire form for the structured-output endpoint. The endpoint caps union-typed (nullable) fields at 16 and
 * rejects large compiled grammars (both verified live 2026-09-18), so the wire form is one small repeated
 * object: a list of named facts with no nullables. `announcementFromWire` converts back to the domain shape.
 */
export const FACT_NAMES = [
  'productFormat',
  'productName',
  'language',
  'market',
  'releaseDateLocal',
  'releaseTimeLocal',
  'timezone',
  'sellerOrChannel',
  'purchaseLimit',
  'packagingCondition',
  'relativeAge',
  'statedCondition',
] as const;
export type FactName = (typeof FACT_NAMES)[number];

export const FactWireSchema = z.object({
  name: z.enum(FACT_NAMES),
  value: z.string().describe('The fact as text; empty string when the source does not state it. releaseDateLocal as YYYY-MM-DD, releaseTimeLocal as HH:mm, purchaseLimit as an integer, packagingCondition as stated_intact | stated_removed | not_stated | unreadable, relativeAge verbatim'),
  span: z.string().describe('Readable text span or image region "x0,y0,x1,y1" supporting the value; empty string when none'),
  reason: z.string().describe('Why the value is absent or uncertain; empty string when the value is clear'),
});
export type FactWire = z.infer<typeof FactWireSchema>;

export const AnnouncementExtractionWireSchema = z.object({
  facts: z.array(FactWireSchema).describe('One entry per fact name (statedCondition may repeat). Include a name with an empty value and a reason when the fact is not stated.'),
  dateBasis: z.enum(['source_confirmed', 'user_expected', 'unknown']),
  missingFactsForActionableIntent: z.array(z.string()),
  notes: z.string().describe('Free text; empty string when none'),
});
export type AnnouncementExtractionWire = z.infer<typeof AnnouncementExtractionWireSchema>;

type DomainFact<T> = { value: T | null; evidenceId: string | null; span: string | null; reason: string | null };

function toFact<T>(w: FactWire | undefined, evidenceId: string | null, parse: (s: string) => T | null): DomainFact<T> {
  if (!w) return { value: null, evidenceId: null, span: null, reason: 'not stated' };
  const value = w.value === '' ? null : parse(w.value);
  return {
    value,
    evidenceId: value === null ? null : evidenceId,
    span: w.span === '' ? null : w.span,
    reason: w.reason === '' ? (value === null ? 'not stated' : null) : w.reason,
  };
}

const asString = (s: string): string => s;
const asInt = (s: string): number | null => {
  const n = Number.parseInt(s, 10);
  return Number.isInteger(n) ? n : null;
};
const asPackaging = (s: string): PackagingCondition | null => (PackagingConditionSchema.safeParse(s).success ? (s as PackagingCondition) : null);

/** Converts the wire form into the domain extraction, attributing known facts to `evidenceId`. Throws (via Zod) if invalid. */
export function announcementFromWire(w: AnnouncementExtractionWire, evidenceId: string | null): AnnouncementExtraction {
  const first = (name: FactName): FactWire | undefined => w.facts.find((f) => f.name === name);
  return AnnouncementExtractionSchema.parse({
    productFormat: toFact(first('productFormat'), evidenceId, asString),
    productName: toFact(first('productName'), evidenceId, asString),
    language: toFact(first('language'), evidenceId, asString),
    market: toFact(first('market'), evidenceId, asString),
    releaseDateLocal: toFact(first('releaseDateLocal'), evidenceId, (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)),
    releaseTimeLocal: toFact(first('releaseTimeLocal'), evidenceId, (s) => (/^\d{2}:\d{2}$/.test(s) ? s : null)),
    timezone: toFact(first('timezone'), evidenceId, asString),
    sellerOrChannel: toFact(first('sellerOrChannel'), evidenceId, asString),
    purchaseLimit: toFact(first('purchaseLimit'), evidenceId, asInt),
    statedConditions: w.facts.filter((f) => f.name === 'statedCondition' && f.value !== '').map((f) => toFact(f, evidenceId, asString)),
    packagingCondition: toFact(first('packagingCondition'), evidenceId, asPackaging),
    relativeAge: toFact(first('relativeAge'), evidenceId, asString),
    dateBasis: w.dateBasis,
    missingFactsForActionableIntent: w.missingFactsForActionableIntent,
    notes: w.notes === '' ? null : w.notes,
  });
}
