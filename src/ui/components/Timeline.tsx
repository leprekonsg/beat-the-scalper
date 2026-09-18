import type { ReactElement } from 'react';
import { formatLedgerSgt, formatUtc } from '../format.ts';
import type { EventRecord } from '../types.ts';
import { Chip, provenanceLabel, provenanceTone } from './Chip.tsx';

function payloadSummary(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([k]) => k !== 'intent');
  if (entries.length === 0) return '';
  const text = entries
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

/** The ledger: every state change printed as a line with its time and provenance, newest first. Narration is never a success signal. */
export function Timeline({ events }: { events: EventRecord[] }): ReactElement {
  return (
    <section className="pocket sleeve" data-testid="timeline" aria-labelledby="ledger-title">
      <div className="pocket-title">
        <span id="ledger-title">Ledger</span>
        <span className="pocket-title-right">{events.length} entries, newest first</span>
      </div>
      {events.length === 0 ? <p className="note">No entries yet. The first line prints when a mission is saved.</p> : null}
      <ol className="ledger">
        {events.map((ev) => (
          <li key={ev.eventId} data-testid="event-item" data-event-type={ev.type}>
            <span className="ledger-time" title={formatUtc(ev.at)}>
              {formatLedgerSgt(ev.at)}
            </span>
            <span className="ledger-type">{ev.type}</span>
            <Chip tone={provenanceTone(ev.provenance)} data-testid="event-provenance">
              {provenanceLabel(ev.provenance)}
            </Chip>
            {payloadSummary(ev.payload) ? <span className="ledger-payload">{payloadSummary(ev.payload)}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
