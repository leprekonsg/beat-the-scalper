import type { ReactElement } from 'react';
import { durationLabel, formatClockSgt, formatLocalSgt } from '../format.ts';
import type { HealthResponse, MissionView } from '../types.ts';

const LATENCY_LABELS: { key: keyof MissionView['latency']; label: string }[] = [
  { key: 'signalReceivedAt', label: 'Signal received' },
  { key: 'observationStartAt', label: 'Observation start' },
  { key: 'observationEndAt', label: 'Observation end' },
  { key: 'candidateAt', label: 'Candidate created' },
  { key: 'validationDoneAt', label: 'Validation done' },
  { key: 'checkoutReadyAt', label: 'Checkout ready' },
  { key: 'handoffAt', label: 'Handoff' },
  { key: 'submissionAt', label: 'Submission' },
  { key: 'orderObservedAt', label: 'Order observed' },
];

/** Current action and the measured latency marks. Marks are measured separately; none is invented. */
export function ActionPocket({ view, health }: { view: MissionView; health: HealthResponse }): ReactElement {
  const l = view.latency;
  const signalToReady = l.signalReceivedAt && l.checkoutReadyAt ? Date.parse(l.checkoutReadyAt) - Date.parse(l.signalReceivedAt) : null;
  const observationToReady = l.observationStartAt && l.checkoutReadyAt ? Date.parse(l.checkoutReadyAt) - Date.parse(l.observationStartAt) : null;
  return (
    <section className="pocket" aria-labelledby="action-title">
      <div className="pocket-title">
        <span id="action-title">Current action</span>
        <span className="pocket-title-right">{view.attempts.length} attempt{view.attempts.length === 1 ? '' : 's'}</span>
      </div>
      <p data-testid="current-action" style={{ fontWeight: 500, marginBottom: 14 }}>
        {health.health.currentAction ?? 'Idle'}
      </p>
      <table data-testid="latency-table">
        <thead>
          <tr>
            <th>Mark</th>
            <th className="num">SGT</th>
          </tr>
        </thead>
        <tbody>
          {LATENCY_LABELS.map(({ key, label }) => (
            <tr key={key} data-testid={`latency-row-${key}`}>
              <td>{label}</td>
              <td className="num" title={l[key] ? formatLocalSgt(l[key]) : undefined}>
                {l[key] ? formatClockSgt(l[key]) : <span style={{ color: 'var(--ink-3)' }}>not yet</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {signalToReady !== null ? (
        <p className="note num" data-testid="signal-to-ready">
          Signal to ready: {durationLabel(signalToReady)}
        </p>
      ) : observationToReady !== null ? (
        <p className="note num" data-testid="observation-to-ready">
          Observation to ready: {durationLabel(observationToReady)}
        </p>
      ) : null}
    </section>
  );
}
