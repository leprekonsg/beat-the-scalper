import type { ReactElement } from 'react';
import { formatLocalSgt } from '../format.ts';
import type { MissionView } from '../types.ts';
import { Chip } from './Chip.tsx';

function launchConfidenceLabel(view: MissionView): string {
  switch (view.intent.launchBasis) {
    case 'source_confirmed':
      return 'Source-confirmed';
    case 'user_expected':
      return 'Expected by user';
    default:
      return 'Unknown';
  }
}

function authorityLabel(a: string): string {
  switch (a) {
    case 'observe':
      return 'Observe only';
    case 'prepare':
      return 'Prepare, human submits';
    case 'demo_purchase':
      return 'Demo purchase';
    default:
      return a;
  }
}

/** Launch and source: what we believe about the release and why, plus the mission's own limits. */
export function LaunchPocket({ view }: { view: MissionView }): ReactElement {
  const intent = view.intent;
  const basisTone = intent.launchBasis === 'source_confirmed' ? 'teal' : intent.launchBasis === 'user_expected' ? 'amber' : 'neutral';
  return (
    <section className="pocket" aria-labelledby="launch-title">
      <div className="pocket-title">
        <span id="launch-title">Launch and source</span>
        <span className="pocket-title-right">rev {intent.revision}</span>
      </div>
      <dl className="kv">
        <dt>Confidence</dt>
        <dd>
          <Chip tone={basisTone} data-testid="launch-confidence">
            {launchConfidenceLabel(view)}
          </Chip>
        </dd>
        <dt>Launch</dt>
        <dd className="num" data-testid="launch-at">
          {intent.launchAt ? formatLocalSgt(intent.launchAt) : 'Unknown'}
        </dd>
        <dt>Source</dt>
        <dd className="num" data-testid="launch-evidence">
          {intent.launchEvidenceId ?? 'No source evidence'}
        </dd>
        <dt>Window</dt>
        <dd data-testid="restock-window-enabled">
          {intent.restockWindow.enabled ? `${intent.restockWindow.startLocal}-${intent.restockWindow.endLocal} SGT, ${intent.restockWindow.basis.replace('_', ' ')}` : 'Not watched'}
        </dd>
        <dt>Authority</dt>
        <dd data-testid="authority">{authorityLabel(intent.authority)}</dd>
        <dt>Expires</dt>
        <dd className="num" data-testid="expires-at">
          {formatLocalSgt(intent.expiresAt)}
        </dd>
        <dt>Packaging</dt>
        <dd data-testid="packaging-policy">{intent.packagingPolicy.replace(/_/g, ' ')}</dd>
        <dt>Target</dt>
        <dd className="num" data-testid="target-ids">
          {intent.target.retailerProductId ?? 'Unknown'} / {intent.target.variantId ?? 'Unknown'}
        </dd>
      </dl>
      {intent.target.productUrl ? (
        <p className="note" style={{ overflowWrap: 'anywhere' }}>
          {intent.target.productUrl}
        </p>
      ) : null}
    </section>
  );
}
