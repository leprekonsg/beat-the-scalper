/**
 * Restock alert decision and packaging-assessment cache. Pure; owned by code, never by the model.
 *
 * Why this exists: restocks on the target listing typically sell out within a minute, and on live
 * retailers the human does the buying. The alert therefore fires on the CANDIDATE observation from
 * deterministic checks alone (milliseconds), never after a model call. Checks that are still
 * `unknown` at that instant (delivered total, packaging not yet interpreted) are printed as "check
 * before paying" instead of delaying the alert; only a definite mismatch suppresses it.
 *
 * The packaging cache moves the model call off the restock path: while the item is out of stock the
 * worker interprets the listing artwork once and records the stated condition here, so a candidate
 * whose page text cannot show packaging (artwork-only notice) is resolved from that record in
 * milliseconds. The cache resolves `unreadable` only; code re-runs eligibility on the result.
 */
import type { Observation, PackagingCondition, Provenance, PurchaseIntent } from './types.ts';
import type { EligibilityResult } from './policy.ts';
import { formatMinor } from './money.ts';

export interface RestockAlertDecision {
  /** True: tell the user to buy now. False: a definite mismatch was found; do not alert. */
  go: boolean;
  headline: string;
  productUrl: string | null;
  itemPriceMinor: number | null;
  /** Checks still `unknown` at alert time, as readable details. The user verifies these before paying. */
  checkBeforePaying: string[];
  /** Definite mismatches (verdict `ineligible`, or item price alone over budget). Non-empty iff `go` is false. */
  blockers: string[];
}

/** Checks that do not describe the offer itself; an `unknown` here is not worth the user's seconds. */
const NON_OFFER_CHECKS = new Set(['freshness']);

export function restockAlertDecision(intent: PurchaseIntent, obs: Observation, result: EligibilityResult): RestockAlertDecision {
  const offer = obs.offer;
  const blockers = result.checks.filter((c) => c.verdict === 'ineligible').map((c) => c.detail);
  const itemPriceMinor = offer?.itemPriceMinor ?? null;
  // Delivered total is unknown on Lazada without an address, so policy leaves it `unknown` even when the
  // item price alone already exceeds the budget. That case can never become eligible: block it here.
  if (itemPriceMinor !== null && itemPriceMinor > intent.maxDeliveredPriceMinor && !result.checks.some((c) => c.check === 'deliveredTotal' && c.verdict === 'ineligible')) {
    blockers.push(`Item price ${formatMinor(itemPriceMinor)} alone exceeds budget ${formatMinor(intent.maxDeliveredPriceMinor)}`);
  }
  const checkBeforePaying = result.checks.filter((c) => c.verdict === 'unknown' && !NON_OFFER_CHECKS.has(c.check)).map((c) => c.detail);
  const title = offer?.title ?? intent.target.description;
  const seller = offer?.sellerLabel ?? offer?.sellerRef ?? 'seller unknown';
  const go = blockers.length === 0 && obs.availability === 'AVAILABLE';
  const headline = go ? `In stock now: ${title}, ${formatMinor(itemPriceMinor)}, ${seller}` : `In stock but not a match: ${title}`;
  return { go, headline, productUrl: intent.target.productUrl, itemPriceMinor, checkBeforePaying, blockers };
}

/** One interpreted packaging condition for a listing, recorded while watching. */
export interface PackagingCacheEntry {
  condition: PackagingCondition;
  /** Evidence the interpreter read; bound into the assessment when the entry is applied. */
  evidenceId: string;
  observationId: string;
  assessedAt: string;
  retailerProductId: string;
  variantId: string;
  /** Listing artwork reference at assessment time (e.g. og:image without query), or null when the page exposed none. */
  artworkRef: string | null;
  provenance: Provenance;
}

export type PackagingCacheCheck = { applies: true; ageMs: number } | { applies: false; reason: string };

/**
 * Whether `entry` may resolve the packaging of `obs`. Same product and variant, same artwork reference
 * (null matches only null), younger than `maxAgeMs`, and the observation must actually need it
 * (`unreadable`); a condition the page stated itself is never overridden.
 */
export function packagingCacheApplies(entry: PackagingCacheEntry | null, obs: Observation, now: Date, maxAgeMs: number): PackagingCacheCheck {
  if (!entry) return { applies: false, reason: 'no cached packaging assessment' };
  const offer = obs.offer;
  if (!offer) return { applies: false, reason: 'observation has no offer' };
  if (offer.packagingCondition !== 'unreadable') return { applies: false, reason: `page stated packaging itself (${offer.packagingCondition})` };
  if (offer.retailerProductId !== entry.retailerProductId || offer.variantId !== entry.variantId) {
    return { applies: false, reason: `cached for ${entry.retailerProductId}/${entry.variantId}, page is ${String(offer.retailerProductId)}/${String(offer.variantId)}` };
  }
  const artworkRef = offer.artworkRef ?? null;
  if (artworkRef !== entry.artworkRef) return { applies: false, reason: 'listing artwork changed since the cached assessment' };
  const ageMs = now.getTime() - Date.parse(entry.assessedAt);
  if (!(ageMs >= 0 && ageMs <= maxAgeMs)) return { applies: false, reason: `cached assessment is ${Math.round(ageMs / 1000)}s old; limit ${Math.round(maxAgeMs / 1000)}s` };
  return { applies: true, ageMs };
}

/**
 * Whether a watching observation should trigger a background re-assessment: the page cannot show
 * packaging and the cache would not apply, or is past half its life (so it never expires exactly
 * when a restock lands).
 */
export function packagingCacheNeedsRefresh(entry: PackagingCacheEntry | null, obs: Observation, now: Date, maxAgeMs: number): boolean {
  const offer = obs.offer;
  if (!offer || offer.packagingCondition !== 'unreadable' || !offer.retailerProductId || !offer.variantId) return false;
  const check = packagingCacheApplies(entry, obs, now, maxAgeMs);
  if (!check.applies) return true;
  return check.ageMs > maxAgeMs / 2;
}
