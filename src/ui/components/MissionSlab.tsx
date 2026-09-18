import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api, ApiError } from '../api.ts';
import { ageLabel, formatMinor } from '../format.ts';
import type { HealthResponse, MissionView } from '../types.ts';
import { Chip, provenanceLabel, provenanceTone, verdictTone } from './Chip.tsx';
import { Stations } from './Stations.tsx';
import { SunriseArc } from './SunriseArc.tsx';

const LOCKED = new Set(['HANDOFF_LOCKED', 'SUBMISSION_STARTED', 'ORDER_OBSERVED', 'UNKNOWN']);
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED']);

function stateTone(state: string): 'teal' | 'amber' | 'brick' | 'blue' | 'charcoal' | 'neutral' {
  if (state === 'COMPLETED') return 'teal';
  if (state === 'CANCELLED' || state === 'EXPIRED') return 'brick';
  if (state === 'PAUSED' || LOCKED.has(state)) return 'amber';
  if (state === 'DRAFT') return 'neutral';
  return 'blue';
}

function packagingLabel(condition: string | null | undefined): string {
  switch (condition) {
    case 'stated_intact':
      return 'Stated intact';
    case 'stated_removed':
      return 'Stated removed (outer wrap)';
    case 'unreadable':
      return 'Unreadable';
    case 'not_stated':
    case null:
    case undefined:
      return 'Not stated';
    default:
      return String(condition);
  }
}

/**
 * The card in the centre pocket: slab label, mission facts, sunrise arc, stations, and the stub row of controls.
 * Every fact on it comes from the server; this component never computes money or state.
 */
export function MissionSlab({ view, health, nowMs, onChanged }: { view: MissionView; health: HealthResponse; nowMs: number; onChanged: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [merchantOrderRef, setMerchantOrderRef] = useState('');
  const [dedupeKey, setDedupeKey] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (!confirmCancel) return;
    const id = window.setTimeout(() => setConfirmCancel(false), 6000);
    return () => window.clearTimeout(id);
  }, [confirmCancel]);

  const obs = view.lastObservation;
  const offer = obs?.offer ?? null;
  const state = view.state;
  const packagingCheck = view.eligibility?.checks.find((c) => c.check === 'packaging') ?? null;
  const requiresUserReview = state === 'PAUSED' && (view.mission.pauseReason === 'user_review_required' || packagingCheck?.verdict === 'unknown');

  const canHandoff = state === 'HANDOFF_LOCKED' || state === 'UNKNOWN';
  const canPause = !TERMINAL.has(state) && state !== 'PAUSED' && !LOCKED.has(state);
  const canResume = state === 'PAUSED';
  const canCancel = !TERMINAL.has(state) && !LOCKED.has(state);
  const isLocked = LOCKED.has(state);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function scrollToObservation(): void {
    document.getElementById('observation-pocket')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const title = (offer?.title ?? view.intent.target.description) || 'Unknown item';
  const variant = offer?.variantLabel ?? offer?.variantId ?? view.intent.target.variantId ?? null;
  const seller = offer?.sellerLabel ?? offer?.sellerRef ?? view.intent.target.sellerRef ?? null;
  const provenance = obs?.provenance ?? null;
  const budget = formatMinor(view.intent.maxDeliveredPriceMinor);
  const delivered = offer?.deliveredTotalMinor ?? null;
  const withinBudget = delivered !== null && delivered <= view.intent.maxDeliveredPriceMinor;

  return (
    <article className="pocket pocket-card" id="candidate-card" data-testid="candidate-card" aria-label="Mission card">
      <div className="slab-label">
        <div className="slab-cell">
          <span className="cell-label">State</span>
          <span className="cell-value">
            <Chip tone={stateTone(state)} data-testid="mission-state">
              {state}
            </Chip>
          </span>
        </div>
        <div className="slab-cell">
          <span className="cell-label">Provenance</span>
          <span className="cell-value">
            {provenance ? (
              <Chip tone={provenanceTone(provenance)} data-testid="observation-provenance">
                {provenanceLabel(provenance)}
              </Chip>
            ) : (
              <Chip tone="neutral" data-testid="observation-provenance">
                No observation
              </Chip>
            )}
          </span>
        </div>
        <div className="slab-cell">
          <span className="cell-label">Evidence age</span>
          <span className="cell-value" data-testid="evidence-age">
            {obs ? ageLabel(obs.capturedAt, nowMs) : 'Unknown'}
          </span>
        </div>
      </div>

      <div className="slab-body">
        <h2 className="slab-title" data-testid="candidate-product">
          {title}
        </h2>
        <p className="slab-subtitle">
          {[view.intent.target.productFormat, view.intent.target.language].filter(Boolean).join(', ') || 'Format and language unknown'}
          {variant && variant !== view.intent.target.language && variant !== offer?.language ? (
            <>
              {' '}
              <span className="muted">variant</span>{' '}
              <span className="num" data-testid="candidate-variant">
                {variant}
              </span>
            </>
          ) : (
            <span className="visually-hidden" data-testid="candidate-variant">
              Unknown
            </span>
          )}
        </p>

        <div className="facts">
          <div className="fact">
            <span className="fact-label">Availability</span>
            <span className="fact-value">
              <Chip tone={obs?.availability === 'AVAILABLE' ? 'teal' : obs?.availability === 'UNAVAILABLE' ? 'neutral' : 'amber'} data-testid="availability">
                {obs?.availability ?? 'UNKNOWN'}
              </Chip>
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Eligibility</span>
            <span className="fact-value">
              {view.eligibility ? (
                <Chip tone={verdictTone(view.eligibility.verdict)} data-testid="eligibility-verdict">
                  {view.eligibility.verdict}
                </Chip>
              ) : (
                <span className="muted" data-testid="eligibility-verdict">
                  Not assessed yet
                </span>
              )}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Seller</span>
            <span className="fact-value" data-testid="candidate-seller">
              {seller ?? 'Unknown'}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Packaging</span>
            <span className="fact-value" data-testid="packaging-condition" data-condition={offer?.packagingCondition ?? 'not_stated'}>
              {packagingLabel(offer?.packagingCondition)}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Item price</span>
            <span className="fact-value num" data-testid="item-price">
              {formatMinor(offer?.itemPriceMinor ?? null)}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Delivered total vs budget</span>
            <span className="fact-value num" data-testid="delivered-total" data-within-budget={delivered === null ? 'unknown' : withinBudget ? 'true' : 'false'}>
              {formatMinor(delivered)} <span className="muted">/ {budget}</span>
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Purchase limit</span>
            <span className="fact-value num" data-testid="purchase-limit">
              {offer?.purchaseLimit ?? 'Unknown'}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Delivery fee</span>
            <span className="fact-value num" data-testid="delivery-fee">
              {formatMinor(offer?.deliveryFeeMinor ?? null)}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Quantity</span>
            <span className="fact-value num" data-testid="quantity">
              1 <span className="muted">fixed</span>
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Mode</span>
            <span className="fact-value" data-testid="mission-mode">
              {view.intent.mode === 'demo' ? 'Demo, owned storefront' : 'Lazada assist, human submits'}
            </span>
          </div>
        </div>
      </div>

      <div className="slab-section">
        <h3>Restock window</h3>
        <SunriseArc clockNowIso={health.health.clock.now} window={view.intent.restockWindow} />
      </div>

      <div className="slab-section">
        <h3>Path</h3>
        <Stations state={state} />
      </div>

      {requiresUserReview && obs ? (
        <div className="slab-section">
          <div className="banner banner-review" data-testid="review-banner">
            The listing states a packaging change ({packagingLabel(offer?.packagingCondition)}). Your preference is to ask first. Accept to continue, or cancel.
          </div>
          <div className="button-row">
            <button className="amber" disabled={busy} onClick={() => void run(() => api.acceptCondition(view.mission.id, obs.evidenceId))} data-testid="accept-condition">
              Accept this stated condition
            </button>
            <button onClick={scrollToObservation}>See the evidence</button>
          </div>
        </div>
      ) : null}

      {canHandoff ? (
        <div className="slab-section" data-testid="handoff-section">
          <h3>Handoff</h3>
          <div className="banner banner-review">
            {state === 'UNKNOWN' ? 'A submission started and its outcome is unresolved. Check the retailer order page, then report what you see.' : 'The cart is ready. Complete the purchase yourself, then report the outcome here.'}
          </div>
          <div className="field">
            <label htmlFor="handoff-ref">Merchant order reference (if known)</label>
            <input id="handoff-ref" type="text" value={merchantOrderRef} onChange={(e) => setMerchantOrderRef(e.target.value)} data-testid="handoff-merchant-order-ref" />
          </div>
          <div className="button-row">
            <button
              className="amber"
              disabled={busy}
              onClick={() => void run(() => api.handoff(view.mission.id, { result: 'ordered', merchantOrderRef: merchantOrderRef.trim() || null }))}
              data-testid="handoff-ordered"
            >
              I placed the order
            </button>
            <button disabled={busy} onClick={() => void run(() => api.handoff(view.mission.id, { result: 'not_ordered', merchantOrderRef: null }))} data-testid="handoff-not-ordered">
              I did not order
            </button>
            <button disabled={busy} onClick={() => void run(() => api.handoff(view.mission.id, { result: 'unknown', merchantOrderRef: merchantOrderRef.trim() || null }))} data-testid="handoff-unknown">
              Still unknown
            </button>
          </div>
        </div>
      ) : null}

      <div className="stub" data-testid="controls">
        {error ? (
          <div className="banner banner-error" data-testid="controls-error">
            {error}
          </div>
        ) : null}
        {isLocked ? (
          <p className="note" data-testid="locked-note">
            Pause and cancel are unavailable while a submission is in progress. Report the outcome above instead.
          </p>
        ) : null}
        <div className="stub-row">
          {canResume ? (
            <button className="primary" disabled={busy} onClick={() => void run(() => api.resume(view.mission.id))} data-testid="control-resume">
              Resume watching
            </button>
          ) : (
            <button className={canPause ? 'primary' : undefined} disabled={busy || !canPause} onClick={() => void run(() => api.pause(view.mission.id, pauseReason.trim() || 'Paused by user'))} data-testid="control-pause">
              Pause
            </button>
          )}
          <button onClick={scrollToObservation} data-testid="control-review">
            Review conditions
          </button>
          <span className="spacer" />
          {confirmCancel ? (
            <button className="danger" disabled={busy || !canCancel} onClick={() => void run(() => api.cancel(view.mission.id)).then(() => setConfirmCancel(false))} data-testid="control-cancel-confirm">
              Confirm cancel
            </button>
          ) : (
            <button className="danger" disabled={busy || !canCancel} onClick={() => setConfirmCancel(true)} data-testid="control-cancel">
              Cancel mission
            </button>
          )}
        </div>
        <div className="stub-fields">
          <div className="field">
            <label htmlFor="pause-reason">Pause reason (optional)</label>
            <input id="pause-reason" type="text" value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} data-testid="pause-reason" />
          </div>
          <div className="field">
            <label htmlFor="signal-key">Shared restock alert key</label>
            <div className="stub-row">
              <input id="signal-key" type="text" value={dedupeKey} onChange={(e) => setDedupeKey(e.target.value)} placeholder="alert id or time" data-testid="signal-dedupe-key" />
              <button
                disabled={busy || !dedupeKey.trim()}
                onClick={() => void run(() => api.signal(view.mission.id, { kind: 'restock_alert', dedupeKey: dedupeKey.trim(), evidenceId: null }))}
                data-testid="signal-import"
              >
                Import alert
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
