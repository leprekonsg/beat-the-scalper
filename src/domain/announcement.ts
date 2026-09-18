/**
 * Announcement/notification interpretation rules that must hold regardless of what the model proposes.
 */
import type { AnnouncementExtraction, LaunchBasis } from './types.ts';
import { planLaunch, type LaunchPlan } from './scheduling.ts';

export interface RelativeAgeResolution {
  absoluteAt: string | null;
  reason: string | null;
  preservedText: string;
}

/**
 * A06: "42 minutes ago" can only become an absolute instant when a trustworthy capture instant exists.
 * Upload time, filesystem timestamps, and the phone's visible clock are not anchors.
 */
export function resolveRelativeAge(text: string, anchor: { capturedAt: string | null; anchorBasis: 'source_metadata' | 'user_stated' | 'none' }): RelativeAgeResolution {
  const m = /(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\s*ago/i.exec(text);
  if (!m) return { absoluteAt: null, reason: 'No relative age pattern found', preservedText: text };
  if (!anchor.capturedAt || anchor.anchorBasis === 'none') {
    return { absoluteAt: null, reason: 'Capture date/time unknown; relative age preserved without an absolute instant', preservedText: m[0] };
  }
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms = unit.startsWith('min') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : n * 86_400_000;
  return { absoluteAt: new Date(Date.parse(anchor.capturedAt) - ms).toISOString(), reason: `Anchored to ${anchor.anchorBasis} capture instant; delivery delay still unknown`, preservedText: m[0] };
}

/** Derive a launch plan from an extraction. Code, not the model, decides `source_confirmed`. */
export function launchFromExtraction(x: AnnouncementExtraction, userExpectedTime: string | null): LaunchPlan {
  const date = x.releaseDateLocal.value;
  const time = x.releaseTimeLocal.value;
  let basis: LaunchBasis = 'unknown';
  if (x.dateBasis === 'source_confirmed' && date && time && x.releaseDateLocal.evidenceId) basis = 'source_confirmed';
  else if (userExpectedTime || time) basis = 'user_expected';
  return planLaunch({ dateLocal: basis === 'source_confirmed' ? date : null, timeLocal: time ?? userExpectedTime, basis });
}

/** The facts still needed before a draft can arm automatic preparation. */
export function missingFactsForArming(t: { productUrl: string | null; retailerProductId: string | null; variantId: string | null; sellerRef: string | null; maxDeliveredPriceMinor: number | null; expiresAt: string | null }): string[] {
  const missing: string[] = [];
  if (!t.productUrl) missing.push('exact product URL');
  if (!t.retailerProductId) missing.push('retailer product identifier as exposed by the page');
  if (!t.variantId) missing.push('selected variant identifier');
  if (!t.sellerRef) missing.push('approved seller identity mapped from the first-party Pokemon SG link');
  if (t.maxDeliveredPriceMinor === null) missing.push('maximum delivered price in SGD');
  if (!t.expiresAt) missing.push('accepted watch expiry');
  return missing;
}
