import { describe, expect, it } from 'vitest';
import { launchFromExtraction, missingFactsForArming, resolveRelativeAge } from '../../src/domain/announcement.ts';
import { fact, makeExtraction } from './builders.ts';

describe('resolveRelativeAge', () => {
  it('A06: "42 minutes ago" with an unknown capture date yields no absolute instant', () => {
    const result = resolveRelativeAge('42 minutes ago', { capturedAt: null, anchorBasis: 'none' });
    expect(result.absoluteAt).toBeNull();
    expect(result.preservedText).toBe('42 minutes ago');
    expect(result.reason).toMatch(/capture date\/time unknown/i);
  });

  it('A06: an upload-time anchor labelled "none" is still not an anchor', () => {
    const result = resolveRelativeAge('Restocked 42 minutes ago', { capturedAt: '2026-09-18T10:00:00.000Z', anchorBasis: 'none' });
    expect(result.absoluteAt).toBeNull();
    expect(result.preservedText).toBe('42 minutes ago');
  });

  it('A06: with a source-metadata capture instant of 05:47Z the alert resolves to 05:05Z and delivery delay stays unknown', () => {
    const result = resolveRelativeAge('42 minutes ago', { capturedAt: '2026-09-18T05:47:00Z', anchorBasis: 'source_metadata' });
    expect(result.absoluteAt).toBe('2026-09-18T05:05:00.000Z');
    expect(result.preservedText).toBe('42 minutes ago');
    expect(result.reason).toMatch(/delivery delay still unknown/i);
  });

  it.each([
    { text: '2 hours ago', capturedAt: '2026-09-18T05:47:00Z', expected: '2026-09-18T03:47:00.000Z' },
    { text: '1 day ago', capturedAt: '2026-09-18T05:47:00Z', expected: '2026-09-17T05:47:00.000Z' },
  ])('A06: $text anchors to $expected', ({ text, capturedAt, expected }) => {
    expect(resolveRelativeAge(text, { capturedAt, anchorBasis: 'source_metadata' }).absoluteAt).toBe(expected);
  });

  it('A06: text without a relative age is preserved verbatim with a stated reason', () => {
    const result = resolveRelativeAge('Back in stock now', { capturedAt: '2026-09-18T05:47:00Z', anchorBasis: 'source_metadata' });
    expect(result.absoluteAt).toBeNull();
    expect(result.preservedText).toBe('Back in stock now');
    expect(result.reason).toMatch(/No relative age pattern/);
  });
});

describe('launchFromExtraction', () => {
  it('A02: a user_expected date basis never becomes source_confirmed even when a date value is present', () => {
    const extraction = makeExtraction({
      dateBasis: 'user_expected',
      releaseDateLocal: fact('2026-09-25'),
      releaseTimeLocal: fact('10:00'),
    });
    const plan = launchFromExtraction(extraction, null);
    expect(plan.launchBasis).toBe('user_expected');
    expect(plan.launchAt).toBeNull();
    expect(plan.preflightAt).toBeNull();
    expect(plan.message).toMatch(/Expected by user around 10:00/);
  });

  it('A02: a source_confirmed claim without an evidence ID is downgraded to a user expectation', () => {
    const extraction = makeExtraction({
      dateBasis: 'source_confirmed',
      releaseDateLocal: fact('2026-09-25'), // no evidenceId
      releaseTimeLocal: fact('10:00', { evidenceId: 'ev_ann_001' }),
    });
    const plan = launchFromExtraction(extraction, null);
    expect(plan.launchBasis).toBe('user_expected');
    expect(plan.launchAt).toBeNull();
  });

  it('A01: a source_confirmed, evidence-linked date and time schedules the exact instant', () => {
    const extraction = makeExtraction({
      dateBasis: 'source_confirmed',
      releaseDateLocal: fact('2026-09-25', { evidenceId: 'ev_ann_001', span: 'Launching 25 September' }),
      releaseTimeLocal: fact('10:00', { evidenceId: 'ev_ann_001', span: '10am SGT' }),
    });
    const plan = launchFromExtraction(extraction, null);
    expect(plan.launchBasis).toBe('source_confirmed');
    expect(plan.launchAt).toBe('2026-09-25T02:00:00.000Z');
    expect(plan.preflightAt).toBe('2026-09-25T01:50:00.000Z');
  });

  it('A02: only a user-stated time and no extracted date stays a user expectation', () => {
    const plan = launchFromExtraction(makeExtraction(), '10:00');
    expect(plan.launchBasis).toBe('user_expected');
    expect(plan.launchAt).toBeNull();
    expect(plan.message).toMatch(/release date needed/i);
  });
});

describe('missingFactsForArming', () => {
  it('A02: an empty draft lists every fact still needed before arming', () => {
    const missing = missingFactsForArming({ productUrl: null, retailerProductId: null, variantId: null, sellerRef: null, maxDeliveredPriceMinor: null, expiresAt: null });
    expect(missing).toEqual([
      'exact product URL',
      'retailer product identifier as exposed by the page',
      'selected variant identifier',
      'approved seller identity mapped from the first-party Pokemon SG link',
      'maximum delivered price in SGD',
      'accepted watch expiry',
    ]);
  });

  it('A02: a partially resolved draft lists only the null fields', () => {
    const missing = missingFactsForArming({
      productUrl: 'http://127.0.0.1:4310/product/etb-sv10',
      retailerProductId: 'pk-etb-sv10',
      variantId: null,
      sellerRef: 'seller-pokemon-sg-official',
      maxDeliveredPriceMinor: 12000,
      expiresAt: null,
    });
    expect(missing).toEqual(['selected variant identifier', 'accepted watch expiry']);
  });

  it('A05: a fully resolved intent needs nothing further to arm', () => {
    const missing = missingFactsForArming({
      productUrl: 'http://127.0.0.1:4310/product/etb-sv10',
      retailerProductId: 'pk-etb-sv10',
      variantId: 'var-sv10-en',
      sellerRef: 'seller-pokemon-sg-official',
      maxDeliveredPriceMinor: 12000,
      expiresAt: '2026-10-02T02:00:00.000Z',
    });
    expect(missing).toEqual([]);
  });
});
