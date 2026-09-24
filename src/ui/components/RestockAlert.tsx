import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { EventRecord } from '../types.ts';

/** How long a restock alert stays on the board. Restocks sell out within a minute; this only outlasts a glance away. */
const SHOW_FOR_MS = 10 * 60_000;

function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    /* audio blocked until the page has had a user gesture; the banner and notification still show */
  }
}

function notify(e: EventRecord): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const go = e.type === 'restock_alert.sent';
  const body = go ? [String(e.payload.headline ?? ''), ...((e.payload.checkBeforePaying as string[] | undefined) ?? []).map((c) => `Check: ${c}`)].join('\n') : ((e.payload.reasons as string[] | undefined) ?? []).join('\n');
  const n = new Notification(go ? 'BTS: in stock now' : 'BTS: do not buy', { body, tag: e.eventId, requireInteraction: go });
  const url = e.payload.productUrl;
  if (go && typeof url === 'string') n.onclick = () => window.open(url, '_blank', 'noopener');
}

/**
 * The restock alert on the board, plus a desktop notification and a tone for each new one. The worker
 * raises it on detection, before any model call; the listed checks are what the user verifies before paying.
 * `events` is null until the first state poll lands, so history is never mistaken for a new alert.
 */
export function RestockAlert({ events, nowMs }: { events: EventRecord[] | null; nowMs: number }): ReactElement | null {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const seen = useRef<Set<string> | null>(null);

  const alerts = (events ?? []).filter((e) => e.type === 'restock_alert.sent' || e.type === 'restock_alert.retracted');

  useEffect(() => {
    if (events === null) return;
    // Events already on the board when the page loads are history, not new alerts.
    if (seen.current === null) {
      seen.current = new Set(alerts.map((e) => e.eventId));
      return;
    }
    for (const e of alerts) {
      if (seen.current.has(e.eventId)) continue;
      seen.current.add(e.eventId);
      notify(e);
      beep();
    }
  }, [events, alerts]);

  const latest = alerts.reduce<EventRecord | null>((acc, e) => (acc === null || Date.parse(e.at) > Date.parse(acc.at) ? e : acc), null);
  const enable =
    permission === 'default' ? (
      <button type="button" onClick={() => void Notification.requestPermission().then(setPermission)} data-testid="enable-alerts">
        Enable desktop alerts
      </button>
    ) : null;

  if (!latest || nowMs - Date.parse(latest.at) > SHOW_FOR_MS) {
    return enable ? <div className="restock-alert-enable">{enable}</div> : null;
  }

  if (latest.type === 'restock_alert.retracted') {
    const reasons = (latest.payload.reasons as string[] | undefined) ?? [];
    return (
      <div className="banner banner-error" role="alert" data-testid="restock-alert">
        <strong>Do not buy.</strong> Validation found a mismatch after the alert: {reasons.join('; ')}
      </div>
    );
  }

  const checks = (latest.payload.checkBeforePaying as string[] | undefined) ?? [];
  const url = typeof latest.payload.productUrl === 'string' ? latest.payload.productUrl : null;
  return (
    <div className="banner banner-go" role="alert" data-testid="restock-alert">
      <strong>{String(latest.payload.headline ?? 'In stock now')}</strong>
      {url ? (
        <>
          {' '}
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open listing
          </a>
        </>
      ) : null}
      {checks.length > 0 ? (
        <ul className="restock-alert-checks">
          {checks.map((c) => (
            <li key={c}>Check before paying: {c}</li>
          ))}
        </ul>
      ) : null}
      {enable}
    </div>
  );
}
