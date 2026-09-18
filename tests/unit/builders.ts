/**
 * Small builders for the deterministic unit suite. Every builder parses through the real Zod
 * contracts so a test can never assert against a shape the domain would reject.
 */
import {
  AnnouncementExtractionSchema,
  ObservationSchema,
  PurchaseIntentSchema,
  type AnnouncementExtraction,
  type Observation,
  type OfferedItem,
  type PurchaseIntent,
  type Target,
} from '../../src/domain/types.ts';

export const NOW_IN_WINDOW = new Date('2026-09-25T05:27:00.000Z'); // 13:27 Asia/Singapore

export function makeIntent(over: Partial<PurchaseIntent> = {}, target: Partial<Target> = {}): PurchaseIntent {
  const base = {
    id: 'msn_001',
    revision: 1,
    fulfillmentKey: 'fk_pokemon_etb_sv10_001',
    mode: 'demo' as const,
    accountRef: 'local_demo_profile',
    target: {
      productUrl: 'http://127.0.0.1:4310/product/etb-sv10',
      retailerProductId: 'pk-etb-sv10',
      variantId: 'var-sv10-en',
      sellerRef: 'seller-pokemon-sg-official',
      sellerEvidenceId: 'ev_seller_firstparty_link',
      productFormat: 'Elite Trainer Box',
      language: 'English',
      description: 'Scarlet & Violet Elite Trainer Box, English, one unit',
    },
    quantity: 1 as const,
    currency: 'SGD' as const,
    maxDeliveredPriceMinor: 12000,
    packagingPolicy: 'ask' as const,
    allowedConditionEvidenceIds: [],
    launchAt: null,
    launchBasis: 'unknown' as const,
    launchEvidenceId: null,
    restockWindow: {
      timezone: 'Asia/Singapore' as const,
      startLocal: '13:00' as const,
      endLocal: '14:00' as const,
      basis: 'user_observation' as const,
      enabled: true,
    },
    expiresAt: '2026-10-02T02:00:00.000Z',
    authority: 'demo_purchase' as const,
  };
  return PurchaseIntentSchema.parse({ ...base, ...over, target: { ...base.target, ...target } });
}

export function makeOffer(over: Partial<OfferedItem> = {}): OfferedItem {
  return {
    retailerProductId: 'pk-etb-sv10',
    variantId: 'var-sv10-en',
    variantLabel: 'English / single box',
    sellerRef: 'seller-pokemon-sg-official',
    sellerLabel: 'Pokemon Official Store SG',
    productFormat: 'Elite Trainer Box',
    language: 'English',
    title: 'Pokemon TCG Scarlet & Violet Elite Trainer Box',
    itemPriceMinor: 9990,
    deliveryFeeMinor: 2000,
    deliveredTotalMinor: 11990,
    packagingCondition: 'not_stated',
    packagingEvidenceRegion: '120,340,480,520',
    purchaseLimit: 1,
    ...over,
  };
}

export function makeObservation(over: Partial<Observation> = {}, offer: Partial<OfferedItem> | null = {}): Observation {
  const base = {
    observationId: 'obs_001',
    missionId: 'msn_001',
    evidenceId: 'ev_obs_001',
    provenance: 'demo' as const,
    capturedAt: '2026-09-25T05:26:59.000Z',
    pageRevision: 'rev-1',
    availability: 'AVAILABLE' as const,
    offer: offer === null ? null : makeOffer(offer),
    accessControl: 'none' as const,
    retryAfterSeconds: null,
    error: null,
  };
  return ObservationSchema.parse({ ...base, ...over });
}

type FactOver = { evidenceId?: string | null; span?: string | null; reason?: string | null };

export function fact<T>(value: T | null, over: FactOver = {}): { value: T | null; evidenceId: string | null; span: string | null; reason: string | null } {
  return { value, evidenceId: over.evidenceId ?? null, span: over.span ?? null, reason: over.reason ?? null };
}

export function makeExtraction(over: Partial<AnnouncementExtraction> = {}): AnnouncementExtraction {
  const base = {
    productFormat: fact('Elite Trainer Box', { evidenceId: 'ev_ann_001', span: 'Elite Trainer Box' }),
    productName: fact('Scarlet & Violet Elite Trainer Box', { evidenceId: 'ev_ann_001' }),
    language: fact('English', { evidenceId: 'ev_ann_001' }),
    market: fact('Singapore', { evidenceId: 'ev_ann_001' }),
    releaseDateLocal: fact<string>(null, { reason: 'No date stated in the source' }),
    releaseTimeLocal: fact<string>(null, { reason: 'No time stated in the source' }),
    timezone: fact('Asia/Singapore', { evidenceId: 'ev_ann_001' }),
    sellerOrChannel: fact('Pokemon Official Store SG (Lazada)', { evidenceId: 'ev_ann_001' }),
    purchaseLimit: fact<number>(null, { reason: 'Not stated' }),
    statedConditions: [],
    packagingCondition: fact<'stated_intact' | 'stated_removed' | 'not_stated' | 'unreadable'>('not_stated'),
    relativeAge: fact<string>(null),
    dateBasis: 'unknown' as const,
    missingFactsForActionableIntent: ['release date'],
    notes: null,
  };
  return AnnouncementExtractionSchema.parse({ ...base, ...over });
}
