import type { ReactElement } from 'react';
import { Chip, provenanceLabel, provenanceTone } from './Chip.tsx';

const PROVENANCES = ['live_verified', 'manual_input', 'demo', 'offline_replay', 'blocked'] as const;

/** The one legend held level, then the two facts every screen must state. */
export function Footer({ demoStoreOrigin }: { demoStoreOrigin: string | null }): ReactElement {
  return (
    <>
      <div className="legend" data-testid="provenance-legend" aria-label="Provenance legend">
        <span className="legend-title">Provenance</span>
        {PROVENANCES.map((p) => (
          <Chip key={p} tone={provenanceTone(p)}>
            {provenanceLabel(p)}
          </Chip>
        ))}
      </div>
      <footer className="app-footer" data-testid="app-footer">
        <p data-testid="footer-demo-store-note">Demo storefront: {demoStoreOrigin ?? 'unknown'}. Presenter controls run on a separate origin the agent cannot reach.</p>
        <p data-testid="footer-no-real-money-note">No real-money submission path exists in this build.</p>
      </footer>
    </>
  );
}
