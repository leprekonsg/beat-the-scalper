import type { ReactElement } from 'react';
import { formatLocalSgt } from '../format.ts';
import type { MissionView } from '../types.ts';
import { Chip, provenanceLabel, provenanceTone, verdictTone } from './Chip.tsx';
import { EvidenceViewer } from './EvidenceViewer.tsx';

function accessLabel(a: string): string {
  switch (a) {
    case 'none':
      return 'No access control';
    case 'captcha':
      return 'CAPTCHA shown';
    case 'queue':
      return 'Queue page';
    case 'rate_limited':
      return 'Rate limited';
    case 'login_expired':
      return 'Login expired';
    case 'unsupported_layout':
      return 'Unsupported layout';
    default:
      return a;
  }
}

/** Last observation: eligibility checks with detail, access control, and the evidence image. */
export function ObservationPocket({ view }: { view: MissionView }): ReactElement {
  const obs = view.lastObservation;
  return (
    <section className="pocket" id="observation-pocket" aria-labelledby="obs-title">
      <div className="pocket-title">
        <span id="obs-title">Last observation</span>
        <span className="pocket-title-right" data-testid="observation-captured-at">
          {obs ? formatLocalSgt(obs.capturedAt) : 'none yet'}
        </span>
      </div>

      {obs ? (
        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>Provenance</dt>
          <dd>
            <Chip tone={provenanceTone(obs.provenance)}>{provenanceLabel(obs.provenance)}</Chip>
          </dd>
          <dt>Access</dt>
          <dd data-testid="access-control">
            {accessLabel(obs.accessControl)}
            {obs.retryAfterSeconds !== null ? <span className="num"> (retry after {obs.retryAfterSeconds}s)</span> : null}
          </dd>
          <dt>Page rev</dt>
          <dd className="num" data-testid="page-revision">
            {obs.pageRevision}
          </dd>
          {obs.error ? (
            <>
              <dt>Error</dt>
              <dd data-testid="observation-error">{obs.error}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="note">No observation has been made yet. The first check runs at the next scheduled time.</p>
      )}

      {view.eligibility ? (
        <table data-testid="eligibility-checks">
          <thead>
            <tr>
              <th>Check</th>
              <th>Verdict</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {view.eligibility.checks.map((c) => (
              <tr key={c.check} data-testid={`check-${c.check}`}>
                <td>{c.check.replace(/_/g, ' ')}</td>
                <td>
                  <Chip tone={verdictTone(c.verdict)}>{c.verdict}</Chip>
                </td>
                <td>{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">No eligibility assessment yet.</p>
      )}

      {obs ? (
        <div style={{ marginTop: 14 }}>
          <div className="pocket-title">
            <span>Evidence</span>
            <span className="pocket-title-right">{obs.evidenceId}</span>
          </div>
          <EvidenceViewer evidenceId={obs.evidenceId} />
        </div>
      ) : null}
    </section>
  );
}
