/**
 * Lazada observation adapter. Blocked by default (brief Section 5/Phase 0 feasibility gate).
 *
 * `docs/lazada-feasibility.md` records the gate. Until BOTH `config.liveObserveEnabled` is true AND the
 * store setting `feasibility.observe` equals `'passed'`, every observation is a labelled `blocked` result
 * with no network access attempted. When the gate is recorded as passed, this build still has no validated
 * adapter implementation to register, so it throws `NotImplementedError` rather than fabricate a result.
 */
import { randomUUID } from 'node:crypto';
import type { Observation } from '../domain/types.ts';
import type { ObservationAdapter, ObserveRequest } from './types.ts';
import type { Store } from '../storage/db.ts';

export class NotImplementedError extends Error {}

export interface LazadaObservationAdapterDeps {
  store: Store;
  liveObserveEnabled: boolean;
  /** Origin this adapter would touch; used only for shared per-origin rate limiting bookkeeping. */
  origin?: string;
}

export const BLOCKED_MESSAGE = 'Live Lazada observation is blocked: feasibility gate not passed (docs/lazada-feasibility.md)';

export class LazadaObservationAdapter implements ObservationAdapter {
  readonly name = 'lazada_observation';
  readonly provenance = 'blocked' as const;
  readonly origin: string;

  constructor(private readonly deps: LazadaObservationAdapterDeps) {
    this.origin = deps.origin ?? 'https://www.lazada.sg';
  }

  private gatePassed(): boolean {
    return this.deps.liveObserveEnabled && this.deps.store.getSetting('feasibility.observe') === 'passed';
  }

  async observeTarget(req: ObserveRequest): Promise<Observation> {
    if (!this.gatePassed()) {
      const evidenceId = `evd_${randomUUID()}`;
      this.deps.store.putEvidence({
        evidenceId,
        sourceKind: 'retailer_page',
        provenance: 'blocked',
        sourceUrl: req.intent.target.productUrl,
        sourceMessageId: null,
        capturedAt: null,
        sourcePublishedAt: null,
        receivedAt: req.now,
        targetRef: req.intent.target.retailerProductId,
        variantRef: req.intent.target.variantId,
        pageRevision: null,
        observedFields: {},
        snapshotRef: null,
        contentHash: null,
      });
      return {
        observationId: `obs_${randomUUID()}`,
        missionId: req.missionId,
        evidenceId,
        provenance: 'blocked',
        capturedAt: req.now,
        pageRevision: 'blocked',
        availability: 'UNKNOWN',
        offer: null,
        accessControl: 'none',
        retryAfterSeconds: null,
        error: BLOCKED_MESSAGE,
      };
    }
    // Gate recorded as passed, but no validated adapter exists in this build. Fail loudly rather than
    // silently returning a fabricated observation.
    throw new NotImplementedError('validated Lazada observation adapter not registered');
  }
}
