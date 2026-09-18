/**
 * Deterministic policy checks owned by code. The model may propose; these functions decide.
 */
import type { MonitorPolicy, Observation, PackagingCondition, PackagingPolicy, PurchaseIntent, Mode } from './types.ts';
import { DEMO_MONITOR_POLICY, MonitorPolicySchema } from './types.ts';
import { deliveredTotalMinor } from './money.ts';

export type Verdict = 'eligible' | 'ineligible' | 'unknown';

export interface CheckResult {
  check: string;
  verdict: Verdict;
  detail: string;
}

export interface EligibilityResult {
  verdict: Verdict;
  checks: CheckResult[];
  /** True when the offer may be prepared (cart add) even though final eligibility is not established. */
  preparationPermitted: boolean;
  requiresUserReview: boolean;
}

export interface FreshnessOptions {
  now: Date;
  maxEvidenceAgeMs: number;
}

function check(name: string, verdict: Verdict, detail: string): CheckResult {
  return { check: name, verdict, detail };
}

function identityCheck(name: string, expected: string | null, actual: string | null): CheckResult {
  if (expected === null) return check(name, 'unknown', `Intent has no approved ${name}; draft cannot arm`);
  if (actual === null) return check(name, 'unknown', `Page did not expose ${name}`);
  if (expected !== actual) return check(name, 'ineligible', `Expected ${name} "${expected}", page shows "${actual}"`);
  return check(name, 'eligible', `${name} matches "${actual}"`);
}

function normalise(s: string | null): string | null {
  return s === null ? null : s.trim().toLowerCase();
}

export function packagingCheck(policy: PackagingPolicy, condition: PackagingCondition): CheckResult {
  switch (policy) {
    case 'must_be_intact':
      if (condition === 'stated_intact') return check('packaging', 'eligible', 'Wrapping stated intact');
      if (condition === 'stated_removed') return check('packaging', 'ineligible', 'Listing states outer wrapping will be removed; intent requires intact');
      return check('packaging', 'unknown', `Wrapping condition ${condition}; must_be_intact cannot pass without stated evidence`);
    case 'removed_allowed':
      if (condition === 'unreadable') return check('packaging', 'unknown', 'Packaging notice unreadable; needs zoom or user review');
      return check('packaging', 'eligible', `Wrapping ${condition} accepted under removed_allowed`);
    case 'ask':
      if (condition === 'stated_removed') return check('packaging', 'unknown', 'Listing states a packaging change; policy is ask, user review required');
      if (condition === 'unreadable') return check('packaging', 'unknown', 'Packaging notice unreadable; user review required');
      return check('packaging', 'eligible', `No stated change (${condition})`);
  }
}

/** Evaluate a fresh observation against the approved intent. Never mutates. */
export function evaluateEligibility(intent: PurchaseIntent, obs: Observation, opts: FreshnessOptions): EligibilityResult {
  const checks: CheckResult[] = [];

  const ageMs = opts.now.getTime() - Date.parse(obs.capturedAt);
  if (ageMs > opts.maxEvidenceAgeMs) checks.push(check('freshness', 'unknown', `Evidence is ${Math.round(ageMs / 1000)}s old; limit ${opts.maxEvidenceAgeMs / 1000}s`));
  else checks.push(check('freshness', 'eligible', `Evidence age ${Math.round(ageMs / 1000)}s`));

  if (obs.accessControl !== 'none') checks.push(check('access', 'unknown', `Access control present: ${obs.accessControl}`));

  if (obs.availability === 'AVAILABLE') checks.push(check('availability', 'eligible', 'Observed AVAILABLE'));
  else if (obs.availability === 'UNAVAILABLE') checks.push(check('availability', 'ineligible', 'Observed UNAVAILABLE'));
  else checks.push(check('availability', 'unknown', 'Availability UNKNOWN (failed or ambiguous check)'));

  const offer = obs.offer;
  if (!offer) {
    checks.push(check('offer', 'unknown', 'No offer details observed'));
  } else {
    checks.push(identityCheck('retailerProductId', intent.target.retailerProductId, offer.retailerProductId));
    checks.push(identityCheck('variantId', intent.target.variantId, offer.variantId));
    checks.push(identityCheck('sellerRef', intent.target.sellerRef, offer.sellerRef));

    const fmtExpected = normalise(intent.target.productFormat);
    const fmtActual = normalise(offer.productFormat);
    if (fmtActual === null) checks.push(check('productFormat', 'unknown', 'Page did not expose product format'));
    else if (fmtActual !== fmtExpected) checks.push(check('productFormat', 'ineligible', `Format mismatch: want "${intent.target.productFormat}", offered "${offer.productFormat}" (quantity one does not override a bundle)`));
    else checks.push(check('productFormat', 'eligible', `Format "${offer.productFormat}"`));

    const langExpected = normalise(intent.target.language);
    const langActual = normalise(offer.language);
    if (langActual === null) checks.push(check('language', 'unknown', 'Page did not expose language'));
    else if (langActual !== langExpected) checks.push(check('language', 'ineligible', `Language mismatch: want ${intent.target.language}, offered ${offer.language}`));
    else checks.push(check('language', 'eligible', `Language ${offer.language}`));

    checks.push(packagingCheck(intent.packagingPolicy, offer.packagingCondition));

    const total = offer.deliveredTotalMinor ?? deliveredTotalMinor(offer.itemPriceMinor, offer.deliveryFeeMinor);
    if (total === null) {
      const itemNote = offer.itemPriceMinor !== null && offer.itemPriceMinor <= intent.maxDeliveredPriceMinor ? ' (item price alone is under budget but delivery is unknown)' : '';
      checks.push(check('deliveredTotal', 'unknown', `Delivered total unknown${itemNote}`));
    } else if (total > intent.maxDeliveredPriceMinor) {
      checks.push(check('deliveredTotal', 'ineligible', `Delivered total ${total} exceeds budget ${intent.maxDeliveredPriceMinor} (minor units)`));
    } else {
      checks.push(check('deliveredTotal', 'eligible', `Delivered total ${total} within budget ${intent.maxDeliveredPriceMinor}`));
    }

    if (offer.purchaseLimit !== null && offer.purchaseLimit < 1) checks.push(check('purchaseLimit', 'ineligible', 'Purchase limit below one'));
  }

  if (intent.quantity !== 1) checks.push(check('quantity', 'ineligible', 'Quantity must be exactly one'));

  const anyIneligible = checks.some((c) => c.verdict === 'ineligible');
  const anyUnknown = checks.some((c) => c.verdict === 'unknown');
  const verdict: Verdict = anyIneligible ? 'ineligible' : anyUnknown ? 'unknown' : 'eligible';

  // Preparation (e.g. add to cart before delivery total is known) is permitted only when every check other than
  // deliveredTotal is eligible. It is never called purchase eligibility.
  const nonTotal = checks.filter((c) => c.check !== 'deliveredTotal');
  const preparationPermitted = !anyIneligible && nonTotal.every((c) => c.verdict === 'eligible');

  const requiresUserReview = checks.some((c) => c.check === 'packaging' && c.verdict === 'unknown' && intent.packagingPolicy !== 'must_be_intact');

  return { verdict, checks, preparationPermitted, requiresUserReview };
}

/** Assessment binding (A13): stale if intent revision or page revision changed. */
export interface AssessmentBinding {
  intentRevision: number;
  pageRevision: string;
  evidenceIds: string[];
}

export function assessmentIsCurrent(binding: AssessmentBinding, current: { intentRevision: number; pageRevision: string; evidenceId: string }): { current: boolean; reason: string | null } {
  if (binding.intentRevision !== current.intentRevision) return { current: false, reason: `Intent revision changed ${binding.intentRevision} -> ${current.intentRevision}` };
  if (binding.pageRevision !== current.pageRevision) return { current: false, reason: `Page revision changed ${binding.pageRevision} -> ${current.pageRevision}` };
  if (!binding.evidenceIds.includes(current.evidenceId)) return { current: false, reason: `Assessment does not reference current evidence ${current.evidenceId}` };
  return { current: true, reason: null };
}

/** Cart plan (A14): detect existing target quantity; never delete unrelated items; never increment to two. */
export interface CartLine {
  retailerProductId: string;
  variantId: string;
  quantity: number;
}
export type CartPlan = { action: 'add_one'; reason: string } | { action: 'none'; reason: string } | { action: 'user_review'; reason: string };

export function planCart(intent: PurchaseIntent, cart: CartLine[]): CartPlan {
  const target = cart.filter((l) => l.retailerProductId === intent.target.retailerProductId && l.variantId === intent.target.variantId);
  const targetQty = target.reduce((n, l) => n + l.quantity, 0);
  const unrelated = cart.filter((l) => !(l.retailerProductId === intent.target.retailerProductId && l.variantId === intent.target.variantId));
  if (targetQty > 1) return { action: 'user_review', reason: `Cart already holds ${targetQty} of the target; BTS will not reduce or increase it` };
  if (unrelated.length > 0) return { action: 'user_review', reason: `Cart holds ${unrelated.length} unrelated line(s); BTS will not remove them and checkout would include them` };
  if (targetQty === 1) return { action: 'none', reason: 'Target already in cart at quantity one; no duplicate addition' };
  return { action: 'add_one', reason: 'Cart empty of target; add exactly one' };
}

/** MonitorPolicy validation. Live mode never inherits demo cadence, and live cadence must be explicit. */
export function validateMonitorPolicy(input: unknown): { ok: true; policy: MonitorPolicy } | { ok: false; error: string } {
  const parsed = MonitorPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const p = parsed.data;
  if (p.mode === 'lazada_assist') {
    if (p.label === 'demo_defaults') return { ok: false, error: 'Live mode cannot use demo_defaults cadence' };
    if (p.baselineIntervalSeconds === DEMO_MONITOR_POLICY.baselineIntervalSeconds && p.priorityIntervalSeconds === DEMO_MONITOR_POLICY.priorityIntervalSeconds) {
      return { ok: false, error: 'Live cadence equals the demo defaults (30s/2s); set a reviewed policy explicitly or leave live monitoring disabled' };
    }
    if (p.liveObserveEnabled && (p.baselineIntervalSeconds === null || p.maxObservationsPerOriginPerMinute === null)) {
      return { ok: false, error: 'Live observation requires explicit baselineIntervalSeconds and maxObservationsPerOriginPerMinute' };
    }
    if (p.livePrepareEnabled && !p.liveObserveEnabled) return { ok: false, error: 'Live preparation requires live observation' };
  }
  return { ok: true, policy: p };
}

/** Build the effective policy from environment-like inputs. */
export function monitorPolicyFromConfig(cfg: {
  mode: Mode;
  liveObserveEnabled: boolean;
  livePrepareEnabled: boolean;
  baselineIntervalSeconds: number | null;
  priorityIntervalSeconds: number | null;
}): MonitorPolicy {
  if (cfg.mode === 'demo') return { ...DEMO_MONITOR_POLICY, liveObserveEnabled: false, livePrepareEnabled: false };
  const enabled = cfg.liveObserveEnabled;
  return {
    mode: 'lazada_assist',
    baselineIntervalSeconds: cfg.baselineIntervalSeconds,
    priorityIntervalSeconds: cfg.priorityIntervalSeconds,
    maxObservationsPerOriginPerMinute: enabled && cfg.baselineIntervalSeconds ? Math.max(1, Math.floor(60 / cfg.baselineIntervalSeconds)) : null,
    liveObserveEnabled: enabled,
    livePrepareEnabled: cfg.livePrepareEnabled,
    label: enabled ? 'reviewed_live' : 'disabled',
  };
}
