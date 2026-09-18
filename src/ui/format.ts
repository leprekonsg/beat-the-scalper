/** Display-only formatting helpers. Money/state truth lives on the server; this file never computes it. */

export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return 'Unknown';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}S$${whole}.${cents.toString().padStart(2, '0')}`;
}

export function formatLocalSgt(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    return (
      new Intl.DateTimeFormat('en-SG', {
        timeZone: 'Asia/Singapore',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso)) + ' SGT'
    );
  } catch {
    return iso;
  }
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace('Z', ' UTC');
  } catch {
    return iso;
  }
}

export function ageLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'Unknown';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Unknown';
  // A virtual server clock only moves on demand, so a stamp can sit a few ms ahead of the derived "now".
  if (ms < -60_000) return 'Unknown';
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** HH:mm:ss in Asia/Singapore for the band clock. */
export function formatClockSgt(iso: string | null | undefined): string {
  if (!iso) return '--:--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
  } catch {
    return '--:--:--';
  }
}

/** HH:mm in Asia/Singapore. */
export function formatHmSgt(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch {
    return 'Unknown';
  }
}

/** Countdown from `nowIso` to `targetIso`, e.g. "in 0:16" or "due". */
export function countdownLabel(targetIso: string | null | undefined, nowIso: string | null | undefined): string {
  if (!targetIso || !nowIso) return 'Not scheduled';
  const ms = Date.parse(targetIso) - Date.parse(nowIso);
  if (!Number.isFinite(ms)) return 'Not scheduled';
  if (ms <= 0) return 'due';
  const s = Math.round(ms / 1000);
  if (s < 3600) return `in ${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `in ${h}h ${m.toString().padStart(2, '0')}m`;
}

/** Compact ledger stamp in Asia/Singapore with seconds, e.g. "18 Sep 12:58:00". */
export function formatLedgerSgt(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short' }).format(d);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    return `${day} ${time}`;
  } catch {
    return iso;
  }
}
