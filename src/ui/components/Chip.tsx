/** Small status pill. Color is chosen by the caller from the fixed palette so meaning stays consistent. */
import type { ReactElement, ReactNode } from 'react';

export type ChipTone = 'teal' | 'amber' | 'brick' | 'charcoal' | 'blue' | 'neutral';

export function Chip({
  tone,
  children,
  pulse = false,
  'data-testid': testId,
}: {
  tone: ChipTone;
  children: ReactNode;
  pulse?: boolean;
  'data-testid'?: string;
}): ReactElement {
  return (
    <span className={`chip chip-${tone}`} data-testid={testId}>
      {pulse ? <span className="heartbeat-dot" /> : null}
      {children}
    </span>
  );
}

/** Maps the domain's MonitorHealth values to the brief's fixed color meaning. */
export function healthTone(health: string): ChipTone {
  switch (health) {
    case 'Healthy':
      return 'teal';
    case 'Degraded':
    case 'Starting':
      return 'amber';
    case 'Paused':
      return 'amber';
    case 'Expired':
    case 'Disabled':
      return 'brick';
    default:
      return 'neutral';
  }
}

export function provenanceLabel(provenance: string): string {
  switch (provenance) {
    case 'live_verified':
      return 'Live verified';
    case 'manual_input':
      return 'Manual input';
    case 'demo':
      return 'Demo';
    case 'offline_replay':
      return 'Offline replay';
    case 'blocked':
      return 'Blocked';
    default:
      return provenance;
  }
}

export function provenanceTone(provenance: string): ChipTone {
  switch (provenance) {
    case 'live_verified':
      return 'teal';
    case 'manual_input':
      return 'blue';
    case 'demo':
      return 'blue';
    case 'offline_replay':
      return 'charcoal';
    case 'blocked':
      return 'brick';
    default:
      return 'neutral';
  }
}

export function verdictTone(verdict: string): ChipTone {
  switch (verdict) {
    case 'eligible':
      return 'teal';
    case 'ineligible':
      return 'brick';
    case 'unknown':
    default:
      return 'amber';
  }
}
