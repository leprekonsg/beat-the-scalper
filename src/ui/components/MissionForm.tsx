import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { missingFactsForArming } from '../../domain/announcement.ts';
import { api, ApiError } from '../api.ts';
import type { Authority, ImportPrefill, LaunchBasis, MissionDraftInput, MissionView, Mode, PackagingPolicy } from '../types.ts';

function defaultExpiryDate(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function expiryDateToIso(dateLocal: string): string {
  return new Date(`${dateLocal}T23:59:00+08:00`).toISOString();
}

interface FormState {
  mode: Mode;
  description: string;
  productUrl: string;
  productFormat: string;
  language: string;
  retailerProductId: string;
  variantId: string;
  sellerRef: string;
  sellerEvidenceId: string;
  maxDeliveredPriceSgd: string;
  packagingPolicy: PackagingPolicy;
  launchDateLocal: string;
  launchTimeLocal: string;
  launchBasis: LaunchBasis;
  restockWindowEnabled: boolean;
  expiryDateLocal: string;
  authority: Authority;
}

function initialFormState(existing: MissionView | null, prefill?: ImportPrefill): FormState {
  const t = existing?.intent.target;
  return {
    mode: existing?.intent.mode ?? 'demo',
    description: t?.description ?? '',
    productUrl: t?.productUrl ?? '',
    productFormat: t?.productFormat ?? prefill?.productFormat ?? '',
    language: t?.language ?? prefill?.language ?? 'English',
    retailerProductId: t?.retailerProductId ?? '',
    variantId: t?.variantId ?? '',
    sellerRef: t?.sellerRef ?? '',
    sellerEvidenceId: t?.sellerEvidenceId ?? '',
    maxDeliveredPriceSgd: existing ? (existing.intent.maxDeliveredPriceMinor / 100).toFixed(2) : '',
    packagingPolicy: existing?.intent.packagingPolicy ?? prefill?.packagingPolicy ?? 'ask',
    launchDateLocal: prefill?.launchDateLocal ?? '',
    launchTimeLocal: prefill?.launchTimeLocal ?? '',
    launchBasis: existing?.intent.launchBasis ?? prefill?.launchBasis ?? 'unknown',
    restockWindowEnabled: existing?.intent.restockWindow.enabled ?? false,
    expiryDateLocal: existing ? existing.intent.expiresAt.slice(0, 10) : defaultExpiryDate(),
    authority: existing?.intent.authority ?? 'observe',
  };
}

export function MissionForm({ existing, prefill, onSaved }: { existing: MissionView | null; prefill?: ImportPrefill; onSaved: (view: MissionView) => void }): ReactElement {
  const [form, setForm] = useState<FormState>(() => initialFormState(existing, prefill));
  const [acceptExpiry, setAcceptExpiry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>(existing ? computeMissing(existing) : []);

  useEffect(() => {
    setForm(initialFormState(existing, prefill));
    if (existing) setMissing(computeMissing(existing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.mission.id, prefill]);

  function computeMissing(view: MissionView): string[] {
    return missingFactsForArming({
      productUrl: view.intent.target.productUrl,
      retailerProductId: view.intent.target.retailerProductId,
      variantId: view.intent.target.variantId,
      sellerRef: view.intent.target.sellerRef,
      maxDeliveredPriceMinor: view.intent.maxDeliveredPriceMinor,
      expiresAt: view.intent.expiresAt,
    });
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function draftBody(): MissionDraftInput {
    return {
      mode: form.mode,
      description: form.description,
      productUrl: form.productUrl.trim() || null,
      retailerProductId: form.retailerProductId.trim() || null,
      variantId: form.variantId.trim() || null,
      sellerRef: form.sellerRef.trim() || null,
      sellerEvidenceId: form.sellerEvidenceId.trim() || null,
      productFormat: form.productFormat,
      language: form.language,
      maxDeliveredPriceSgd: form.maxDeliveredPriceSgd,
      packagingPolicy: form.packagingPolicy,
      launch: { dateLocal: form.launchDateLocal || null, timeLocal: form.launchTimeLocal || null, basis: form.launchBasis },
      restockWindowEnabled: form.restockWindowEnabled,
      expiresAt: expiryDateToIso(form.expiryDateLocal),
      authority: form.authority,
    };
  }

  async function saveDraft(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        const result = await api.revise(existing.mission.id, {
          productUrl: form.productUrl.trim() || null,
          retailerProductId: form.retailerProductId.trim() || null,
          variantId: form.variantId.trim() || null,
          sellerRef: form.sellerRef.trim() || null,
          sellerEvidenceId: form.sellerEvidenceId.trim() || null,
          productFormat: form.productFormat,
          language: form.language,
          description: form.description,
          maxDeliveredPriceSgd: form.maxDeliveredPriceSgd,
          packagingPolicy: form.packagingPolicy,
          reason: 'Edited from mission form',
        });
        setMissing(computeMissing(result.mission));
        onSaved(result.mission);
      } else {
        const result = await api.createMission(draftBody());
        setMissing(result.missingFactsForArming);
        onSaved(result.mission);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function arm(): Promise<void> {
    if (!existing || !acceptExpiry) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.approve(existing.mission.id, { expiresAt: expiryDateToIso(form.expiryDateLocal), authority: form.authority });
      onSaved(result.mission);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const canArm = Boolean(existing) && missing.length === 0 && acceptExpiry;

  return (
    <div id="mission-form" data-testid="mission-form">
      <div className="pocket-title">
        <span>{existing ? 'Draft card' : 'New card'}</span>
        <span className="pocket-title-right">quantity fixed at 1</span>
      </div>
      {error ? (
        <div className="banner banner-error" data-testid="mission-form-error">
          {error}
        </div>
      ) : null}

      <div className="field-row">
        <div className="field">
          <label>Mode</label>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Mode)} disabled={Boolean(existing)} data-testid="mission-field-mode">
            <option value="demo">Demo (simulated purchase)</option>
            <option value="lazada_assist">Lazada assist (observe/prepare only)</option>
          </select>
        </div>
        <div className="field">
          <label>Product format</label>
          <input type="text" placeholder="e.g. Booster Box" value={form.productFormat} onChange={(e) => set('productFormat', e.target.value)} data-testid="mission-field-product-format" />
        </div>
        <div className="field">
          <label>Language</label>
          <input type="text" value={form.language} onChange={(e) => set('language', e.target.value)} data-testid="mission-field-language" />
        </div>
      </div>

      <div className="field">
        <label>Product URL</label>
        <input type="text" placeholder="https://s.lazada.sg/..." value={form.productUrl} onChange={(e) => set('productUrl', e.target.value)} data-testid="mission-field-product-url" />
      </div>

      <div className="field">
        <label>Description / announcement text</label>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Paste or type what you know about this release" data-testid="mission-field-description" />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Retailer product ID</label>
          <input type="text" value={form.retailerProductId} onChange={(e) => set('retailerProductId', e.target.value)} data-testid="mission-field-retailer-product-id" />
        </div>
        <div className="field">
          <label>Variant ID</label>
          <input type="text" value={form.variantId} onChange={(e) => set('variantId', e.target.value)} data-testid="mission-field-variant-id" />
        </div>
        <div className="field">
          <label>Seller ref</label>
          <input type="text" value={form.sellerRef} onChange={(e) => set('sellerRef', e.target.value)} data-testid="mission-field-seller-ref" />
          <div className="field-note">Approved seller must map to the first-party Pokemon SG link: Pokemon Store Online Singapore.</div>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Max delivered price (SGD)</label>
          <input type="text" placeholder="120.00" value={form.maxDeliveredPriceSgd} onChange={(e) => set('maxDeliveredPriceSgd', e.target.value)} data-testid="mission-field-max-delivered-price" />
        </div>
        <div className="field">
          <label>Quantity</label>
          <input type="text" value="1" readOnly disabled data-testid="mission-field-quantity" />
        </div>
        <div className="field">
          <label>Packaging preference</label>
          <select value={form.packagingPolicy} onChange={(e) => set('packagingPolicy', e.target.value as PackagingPolicy)} data-testid="mission-field-packaging-policy">
            <option value="ask">Ask about stated changes</option>
            <option value="must_be_intact">Must be intact</option>
            <option value="removed_allowed">Removed allowed</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Launch date</label>
          <input type="date" value={form.launchDateLocal} onChange={(e) => set('launchDateLocal', e.target.value)} data-testid="mission-field-launch-date" />
        </div>
        <div className="field">
          <label>Launch time (SGT)</label>
          <input type="time" value={form.launchTimeLocal} onChange={(e) => set('launchTimeLocal', e.target.value)} data-testid="mission-field-launch-time" />
        </div>
        <div className="field">
          <label>Launch basis</label>
          <select value={form.launchBasis} onChange={(e) => set('launchBasis', e.target.value as LaunchBasis)} data-testid="mission-field-launch-basis">
            <option value="unknown">Not yet known</option>
            <option value="source_confirmed">Source-confirmed</option>
            <option value="user_expected">Expected by user</option>
          </select>
        </div>
      </div>

      <div className="field field-check">
        <input
          id="restock-toggle"
          type="checkbox"
          checked={form.restockWindowEnabled}
          onChange={(e) => set('restockWindowEnabled', e.target.checked)}
          data-testid="mission-field-restock-window-enabled"
        />
        <label htmlFor="restock-toggle">Watch 13:00-14:00 SGT restock window (user-observed window, not a schedule)</label>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Watch expiry (editable proposal, default 7 days)</label>
          <input type="date" value={form.expiryDateLocal} onChange={(e) => set('expiryDateLocal', e.target.value)} data-testid="mission-field-expiry-date" />
        </div>
        <div className="field">
          <label>Authority</label>
          <select value={form.authority} onChange={(e) => set('authority', e.target.value as Authority)} data-testid="mission-field-authority">
            <option value="observe">Observe only</option>
            <option value="prepare">Prepare</option>
            {form.mode === 'demo' ? <option value="demo_purchase">Demo purchase</option> : null}
          </select>
        </div>
      </div>

      {missing.length > 0 ? (
        <div className="banner banner-info" data-testid="mission-missing-facts">
          Missing before arming: {missing.join('; ')}
        </div>
      ) : null}

      <div className="field field-check">
        <input id="accept-expiry" type="checkbox" checked={acceptExpiry} onChange={(e) => setAcceptExpiry(e.target.checked)} disabled={!existing} data-testid="mission-accept-expiry" />
        <label htmlFor="accept-expiry">I accept this expiry</label>
      </div>

      <div className="button-row">
        <button disabled={saving} onClick={() => void saveDraft()} data-testid="mission-save-draft">
          Save draft
        </button>
        <button className="primary" disabled={saving || !canArm} onClick={() => void arm()} data-testid="mission-arm">
          Arm mission
        </button>
      </div>
    </div>
  );
}
