import { describe, expect, it } from 'vitest';
import {
  assessmentIsCurrent,
  evaluateEligibility,
  monitorPolicyFromConfig,
  planCart,
  validateMonitorPolicy,
  type CartLine,
  type CheckResult,
  type Verdict,
} from '../../src/domain/policy.ts';
import { DEMO_MONITOR_POLICY, type MonitorPolicy, type OfferedItem, type PackagingPolicy } from '../../src/domain/types.ts';
import { makeIntent, makeObservation } from './builders.ts';

const NOW = new Date('2026-09-25T05:27:00.000Z'); // 13:27 Asia/Singapore
const FRESH = { now: NOW, maxEvidenceAgeMs: 20_000 };

function named(checks: CheckResult[], name: string): CheckResult {
  const found = checks.find((c) => c.check === name);
  if (!found) throw new Error(`No check named "${name}" in ${checks.map((c) => c.check).join(', ')}`);
  return found;
}

describe('evaluateEligibility', () => {
  it('A05: an already-available first observation is eligible with no prior sold-out sample', () => {
    const result = evaluateEligibility(makeIntent(), makeObservation(), FRESH);
    expect(result.verdict).toBe('eligible');
    expect(result.preparationPermitted).toBe(true);
    expect(result.requiresUserReview).toBe(false);
    expect(named(result.checks, 'availability').verdict).toBe('eligible');
    expect(named(result.checks, 'freshness').verdict).toBe('eligible');
    expect(result.checks.every((c) => c.verdict === 'eligible')).toBe(true);
  });

  it.each([
    { field: 'variantId', offer: { variantId: 'var-sv10-jp' } as Partial<OfferedItem>, check: 'variantId' },
    { field: 'sellerRef', offer: { sellerRef: 'seller-third-party-reseller' } as Partial<OfferedItem>, check: 'sellerRef' },
    { field: 'language', offer: { language: 'Japanese' } as Partial<OfferedItem>, check: 'language' },
  ])('A07: an AVAILABLE offer with the wrong $field is ineligible', ({ offer, check }) => {
    const result = evaluateEligibility(makeIntent(), makeObservation({}, offer), FRESH);
    expect(result.verdict).toBe('ineligible');
    expect(named(result.checks, check).verdict).toBe('ineligible');
    expect(result.preparationPermitted).toBe(false);
  });

  it('A08: a two-box bundle is a format mismatch that quantity one does not override', () => {
    const obs = makeObservation({}, { productFormat: 'Bundle (2 x Elite Trainer Box)' });
    const result = evaluateEligibility(makeIntent(), obs, FRESH);
    expect(result.verdict).toBe('ineligible');
    const format = named(result.checks, 'productFormat');
    expect(format.verdict).toBe('ineligible');
    expect(format.detail).toMatch(/bundle/i);
    expect(format.detail).toMatch(/format mismatch/i);
    expect(result.preparationPermitted).toBe(false);
  });

  it.each([
    { packagingPolicy: 'must_be_intact' as PackagingPolicy, verdict: 'ineligible' as Verdict, requiresUserReview: false },
    { packagingPolicy: 'ask' as PackagingPolicy, verdict: 'unknown' as Verdict, requiresUserReview: true },
    { packagingPolicy: 'removed_allowed' as PackagingPolicy, verdict: 'eligible' as Verdict, requiresUserReview: false },
  ])('A09: a stated wrapping removal under $packagingPolicy gives $verdict', ({ packagingPolicy, verdict, requiresUserReview }) => {
    const obs = makeObservation({}, { packagingCondition: 'stated_removed' });
    const result = evaluateEligibility(makeIntent({ packagingPolicy }), obs, FRESH);
    expect(result.verdict).toBe(verdict);
    expect(named(result.checks, 'packaging').verdict).toBe(verdict);
    expect(result.requiresUserReview).toBe(requiresUserReview);
    // The crop region backing the finding stays attached to the offer for the evidence view.
    expect(obs.offer?.packagingEvidenceRegion).toBe('120,340,480,520');
  });

  it.each([{ condition: 'not_stated' as const }, { condition: 'unreadable' as const }])(
    'A10: wrapping $condition under must_be_intact is unknown, not eligible, and is not a user-review pause',
    ({ condition }) => {
      const obs = makeObservation({}, { packagingCondition: condition });
      const result = evaluateEligibility(makeIntent({ packagingPolicy: 'must_be_intact' }), obs, FRESH);
      expect(result.verdict).toBe('unknown');
      expect(named(result.checks, 'packaging').verdict).toBe('unknown');
      expect(result.requiresUserReview).toBe(false);
      expect(result.preparationPermitted).toBe(false);
    },
  );

  it('A11: an item under budget with an unknown delivery fee is unknown but may still be prepared', () => {
    const obs = makeObservation({}, { itemPriceMinor: 9990, deliveryFeeMinor: null, deliveredTotalMinor: null });
    const result = evaluateEligibility(makeIntent({ maxDeliveredPriceMinor: 12000 }), obs, FRESH);
    expect(result.verdict).toBe('unknown');
    expect(result.preparationPermitted).toBe(true);
    const total = named(result.checks, 'deliveredTotal');
    expect(total.verdict).toBe('unknown');
    expect(total.detail).toMatch(/delivery is unknown/i);
    expect(total.detail).toMatch(/under budget/i);
  });

  it('A11: an item under budget whose delivered total exceeds the budget is ineligible', () => {
    const obs = makeObservation({}, { itemPriceMinor: 9990, deliveryFeeMinor: 2500, deliveredTotalMinor: null });
    const result = evaluateEligibility(makeIntent({ maxDeliveredPriceMinor: 12000 }), obs, FRESH);
    expect(result.verdict).toBe('ineligible');
    const total = named(result.checks, 'deliveredTotal');
    expect(total.verdict).toBe('ineligible');
    expect(total.detail).toMatch(/12490 exceeds budget 12000/);
    expect(result.preparationPermitted).toBe(false);
  });

  it('A13: evidence older than the freshness limit downgrades the verdict to unknown', () => {
    const obs = makeObservation({ capturedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const result = evaluateEligibility(makeIntent(), obs, FRESH);
    expect(result.verdict).toBe('unknown');
    const freshness = named(result.checks, 'freshness');
    expect(freshness.verdict).toBe('unknown');
    expect(freshness.detail).toMatch(/60s old; limit 20s/);
    expect(result.preparationPermitted).toBe(false);
  });

  it('A03: an UNAVAILABLE observation is ineligible rather than unknown', () => {
    const result = evaluateEligibility(makeIntent(), makeObservation({ availability: 'UNAVAILABLE' }), FRESH);
    expect(result.verdict).toBe('ineligible');
    expect(named(result.checks, 'availability').verdict).toBe('ineligible');
  });

  it('A16: a CAPTCHA on the page makes the result unknown and blocks preparation', () => {
    const result = evaluateEligibility(makeIntent(), makeObservation({ accessControl: 'captcha' }), FRESH);
    expect(result.verdict).toBe('unknown');
    expect(named(result.checks, 'access').verdict).toBe('unknown');
    expect(named(result.checks, 'access').detail).toMatch(/captcha/i);
    expect(result.preparationPermitted).toBe(false);
  });

  it('A05: a draft intent without resolved identities cannot reach eligible', () => {
    const intent = makeIntent({}, { retailerProductId: null, variantId: null, sellerRef: null, productUrl: null });
    const result = evaluateEligibility(intent, makeObservation(), FRESH);
    expect(result.verdict).toBe('unknown');
    expect(named(result.checks, 'variantId').detail).toMatch(/draft cannot arm/);
    expect(result.preparationPermitted).toBe(false);
  });
});

describe('assessmentIsCurrent', () => {
  const binding = { intentRevision: 3, pageRevision: 'rev-7', evidenceIds: ['ev_obs_010'] };

  it('A13: an unchanged page and intent keep the assessment current', () => {
    expect(assessmentIsCurrent(binding, { intentRevision: 3, pageRevision: 'rev-7', evidenceId: 'ev_obs_010' })).toEqual({ current: true, reason: null });
  });

  it.each([
    { what: 'intent revision', current: { intentRevision: 4, pageRevision: 'rev-7', evidenceId: 'ev_obs_010' }, reason: /Intent revision changed 3 -> 4/ },
    { what: 'page revision', current: { intentRevision: 3, pageRevision: 'rev-8', evidenceId: 'ev_obs_010' }, reason: /Page revision changed rev-7 -> rev-8/ },
    { what: 'evidence binding', current: { intentRevision: 3, pageRevision: 'rev-7', evidenceId: 'ev_obs_011' }, reason: /does not reference current evidence ev_obs_011/ },
  ])('A13: a changed $what invalidates the assessment with a stated reason', ({ current, reason }) => {
    const result = assessmentIsCurrent(binding, current);
    expect(result.current).toBe(false);
    expect(result.reason).toMatch(reason);
  });
});

describe('planCart', () => {
  const intent = makeIntent();
  const targetLine: CartLine = { retailerProductId: 'pk-etb-sv10', variantId: 'var-sv10-en', quantity: 1 };

  it('A14: an empty cart adds exactly one', () => {
    expect(planCart(intent, [])).toEqual({ action: 'add_one', reason: 'Cart empty of target; add exactly one' });
  });

  it('A14: the target already in the cart at quantity one is not added again', () => {
    const plan = planCart(intent, [targetLine]);
    expect(plan.action).toBe('none');
    expect(plan.reason).toMatch(/no duplicate addition/i);
  });

  it('A14: an existing target quantity of two needs user review and is never adjusted', () => {
    const plan = planCart(intent, [{ ...targetLine, quantity: 2 }]);
    expect(plan.action).toBe('user_review');
    expect(plan.reason).toMatch(/already holds 2 of the target/);
    expect(plan.reason).toMatch(/will not reduce or increase it/);
  });

  it('A14: unrelated cart lines need user review and are never removed', () => {
    const plan = planCart(intent, [targetLine, { retailerProductId: 'pk-other-plush', variantId: 'var-plush', quantity: 3 }]);
    expect(plan.action).toBe('user_review');
    expect(plan.reason).toMatch(/1 unrelated line/);
    expect(plan.reason).toMatch(/will not remove them/);
  });
});

describe('validateMonitorPolicy', () => {
  const live = (over: Partial<MonitorPolicy> = {}): MonitorPolicy => ({
    mode: 'lazada_assist',
    baselineIntervalSeconds: 300,
    priorityIntervalSeconds: 60,
    maxObservationsPerOriginPerMinute: 2,
    liveObserveEnabled: true,
    livePrepareEnabled: false,
    label: 'reviewed_live',
    ...over,
  });

  it('A16: live mode cannot carry the demo_defaults label', () => {
    const result = validateMonitorPolicy(live({ label: 'demo_defaults' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : '').toMatch(/demo_defaults/);
  });

  it('A16: live mode cannot silently reuse the 30s/2s demo intervals', () => {
    const result = validateMonitorPolicy(live({ baselineIntervalSeconds: 30, priorityIntervalSeconds: 2 }));
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : '').toMatch(/demo defaults \(30s\/2s\)/);
  });

  it('A16: live observation without an explicit baseline interval is rejected', () => {
    const result = validateMonitorPolicy(live({ baselineIntervalSeconds: null, priorityIntervalSeconds: null, maxObservationsPerOriginPerMinute: null }));
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : '').toMatch(/requires explicit baselineIntervalSeconds/);
  });

  it('A16: live preparation without live observation is rejected', () => {
    const result = validateMonitorPolicy(live({ liveObserveEnabled: false, livePrepareEnabled: true }));
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : '').toMatch(/Live preparation requires live observation/);
  });

  it('A16: the demo defaults are accepted for the owned demo store', () => {
    const result = validateMonitorPolicy(DEMO_MONITOR_POLICY);
    expect(result.ok).toBe(true);
    expect(result.ok === true ? result.policy : null).toEqual(DEMO_MONITOR_POLICY);
  });

  it('A16: a reviewed live policy with explicit intervals is accepted', () => {
    expect(validateMonitorPolicy(live()).ok).toBe(true);
  });

  it('A16: a malformed policy is rejected by the schema, not coerced', () => {
    expect(validateMonitorPolicy({ mode: 'demo', baselineIntervalSeconds: 0, label: 'demo_defaults' }).ok).toBe(false);
  });
});

describe('monitorPolicyFromConfig', () => {
  it('A16: lazada_assist with every live flag off yields a disabled policy with null cadence', () => {
    const policy = monitorPolicyFromConfig({ mode: 'lazada_assist', liveObserveEnabled: false, livePrepareEnabled: false, baselineIntervalSeconds: null, priorityIntervalSeconds: null });
    expect(policy).toEqual({
      mode: 'lazada_assist',
      baselineIntervalSeconds: null,
      priorityIntervalSeconds: null,
      maxObservationsPerOriginPerMinute: null,
      liveObserveEnabled: false,
      livePrepareEnabled: false,
      label: 'disabled',
    });
    expect(validateMonitorPolicy(policy).ok).toBe(true);
  });

  it('A16: demo mode always carries the demo label and never enables live flags', () => {
    const policy = monitorPolicyFromConfig({ mode: 'demo', liveObserveEnabled: true, livePrepareEnabled: true, baselineIntervalSeconds: 1, priorityIntervalSeconds: 1 });
    expect(policy.label).toBe('demo_defaults');
    expect(policy.liveObserveEnabled).toBe(false);
    expect(policy.livePrepareEnabled).toBe(false);
    expect(policy.baselineIntervalSeconds).toBe(30);
    expect(policy.priorityIntervalSeconds).toBe(2);
  });
});
