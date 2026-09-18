import { describe, expect, it } from 'vitest';
import { addMinor, deliveredTotalMinor, formatMinor, parseSgdToMinor } from '../../src/domain/money.ts';

describe('money (integer minor units, no binary floating point)', () => {
  it.each([
    { input: '89.90', minor: 8990, formatted: 'S$89.90' },
    { input: 'S$1,299.00', minor: 129900, formatted: 'S$1299.00' },
    { input: '12', minor: 1200, formatted: 'S$12.00' },
  ])('A11: parseSgdToMinor round-trips $input through integer cents', ({ input, minor, formatted }) => {
    const parsed = parseSgdToMinor(input);
    expect(parsed).toBe(minor);
    expect(Number.isInteger(parsed)).toBe(true);
    expect(formatMinor(parsed)).toBe(formatted);
    expect(parseSgdToMinor(formatMinor(parsed))).toBe(minor);
  });

  it.each([
    { input: '12.345', why: 'three decimals' },
    { input: 'abc', why: 'not a number' },
  ])('A11: parseSgdToMinor rejects $input ($why) with an actionable message', ({ input }) => {
    let caught: unknown;
    try {
      parseSgdToMinor(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(input); // names the offending value
    expect(message).toMatch(/at most two decimals/); // states the rule
    expect(message).toMatch(/89\.90/); // shows an accepted example
  });

  it('A11: formatMinor renders an unknown amount as Unknown rather than zero', () => {
    expect(formatMinor(null)).toBe('Unknown');
    expect(formatMinor(undefined)).toBe('Unknown');
    expect(formatMinor(0)).toBe('S$0.00');
  });

  it('A11: deliveredTotalMinor is null when the delivery fee is unknown', () => {
    expect(deliveredTotalMinor(9990, null)).toBeNull();
    expect(deliveredTotalMinor(null, 2500)).toBeNull();
    expect(deliveredTotalMinor(9990, 2500)).toBe(12490);
    expect(addMinor(9990, 2500, 10)).toBe(12500);
  });
});
