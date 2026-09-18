/**
 * Integer minor-unit money helpers. SGD only. No binary floating point.
 */

export const CURRENCY = 'SGD' as const;

/** Parse "12.50", "S$12.50", "SGD 12.5", "1,299.00" into integer cents. Throws on malformed input. */
export function parseSgdToMinor(input: string): number {
  const cleaned = input.replace(/S\$|SGD|\$|,|\s/gi, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`Cannot parse SGD amount "${input}". Use digits with at most two decimals, e.g. 89.90`);
  const sign = m[1] ? -1 : 1;
  const whole = Number.parseInt(m[2]!, 10);
  const fracRaw = m[3] ?? '';
  const frac = fracRaw.length === 0 ? 0 : Number.parseInt(fracRaw.padEnd(2, '0'), 10);
  return sign * (whole * 100 + frac);
}

export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return 'Unknown';
  if (!Number.isInteger(minor)) throw new Error(`Minor amount must be an integer, got ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}S$${whole}.${cents.toString().padStart(2, '0')}`;
}

export function addMinor(...parts: Array<number | null>): number | null {
  let total = 0;
  for (const p of parts) {
    if (p === null) return null;
    if (!Number.isInteger(p)) throw new Error(`Minor amount must be an integer, got ${p}`);
    total += p;
  }
  return total;
}

/** Delivered total = item + delivery. Null when either component is unknown. */
export function deliveredTotalMinor(itemMinor: number | null, deliveryMinor: number | null): number | null {
  return addMinor(itemMinor, deliveryMinor);
}
