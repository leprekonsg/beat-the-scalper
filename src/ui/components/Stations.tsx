import type { ReactElement } from 'react';
import type { MissionState } from '../types.ts';

const MAIN_LINE: { state: MissionState; short: string }[] = [
  { state: 'DRAFT', short: 'Draft' },
  { state: 'WATCHING', short: 'Watch' },
  { state: 'CANDIDATE', short: 'Cand.' },
  { state: 'VALIDATING', short: 'Valid.' },
  { state: 'PREPARING', short: 'Prep.' },
  { state: 'CHECKOUT_READY', short: 'Ready' },
  { state: 'HANDOFF_LOCKED', short: 'Handoff' },
  { state: 'SUBMISSION_STARTED', short: 'Submit' },
  { state: 'ORDER_OBSERVED', short: 'Order' },
  { state: 'COMPLETED', short: 'Done' },
];

const SIDE_TRACKS: Partial<Record<MissionState, string>> = {
  PAUSED: 'Paused: holding at the last station until resumed',
  UNKNOWN: 'Unknown: a submission started and the outcome is unresolved',
  CANCELLED: 'Cancelled by the user',
  EXPIRED: 'Expired: the watch period ended',
};

/** The whole state graph as an accessible stations diagram; the current station is marked. */
export function Stations({ state }: { state: MissionState }): ReactElement {
  const currentIdx = MAIN_LINE.findIndex((s) => s.state === state);
  const side = SIDE_TRACKS[state];
  const width = 400;
  const pad = 18;
  const step = (width - pad * 2) / (MAIN_LINE.length - 1);
  const y = 16;

  return (
    <div className="stations" data-testid="stations" data-current={state}>
      <svg viewBox={`0 0 ${width} 64`} role="img" aria-labelledby="stations-title">
        <title id="stations-title">
          Mission path. Current state: {state}. {side ?? ''}
        </title>
        <line x1={pad} y1={y} x2={width - pad} y2={y} stroke="var(--grout-strong)" strokeWidth="2" />
        {currentIdx > 0 ? <line x1={pad} y1={y} x2={pad + step * currentIdx} y2={y} stroke="var(--pine)" strokeWidth="2" /> : null}
        {MAIN_LINE.map((s, i) => {
          const x = pad + step * i;
          const passed = currentIdx >= 0 && i < currentIdx;
          const current = i === currentIdx;
          const fill = current ? 'var(--cobalt)' : passed ? 'var(--pine)' : 'var(--slab)';
          const stroke = current ? 'var(--cobalt)' : passed ? 'var(--pine)' : 'var(--ink-3)';
          return (
            <g key={s.state}>
              <circle cx={x} cy={y} r={current ? 6.5 : 4.5} fill={fill} stroke={stroke} strokeWidth="1.5" />
              {current ? <circle cx={x} cy={y} r="10" fill="none" stroke="var(--cobalt)" strokeOpacity="0.35" strokeWidth="1" /> : null}
              <text x={x} y={y + 22} fontSize="10.5" textAnchor="middle" fontFamily="var(--sans)" fontWeight={current ? 700 : 400} fill={current ? 'var(--cobalt-deep)' : 'var(--ink-3)'}>
                {s.short}
              </text>
            </g>
          );
        })}
        {side ? (
          <g>
            <line x1={width / 2} y1={y + 30} x2={width / 2} y2={y + 36} stroke="var(--amber-deep)" strokeWidth="1" />
            <rect x={width / 2 - 34} y={y + 36} width="68" height="4" rx="2" fill="var(--amber-tint)" stroke="var(--amber-deep)" strokeWidth="1" />
          </g>
        ) : null}
      </svg>
      <ol className="visually-hidden">
        {MAIN_LINE.map((s, i) => (
          <li key={s.state} aria-current={i === currentIdx ? 'step' : undefined}>
            {s.state}
            {i === currentIdx ? ' (current)' : i < currentIdx ? ' (passed)' : ''}
          </li>
        ))}
      </ol>
      <div className="stations-legend" aria-hidden="true">
        <span className="lg-passed">passed</span>
        <span className="lg-current">current</span>
        <span className="lg-ahead">ahead</span>
        {side ? <span className="lg-side">{state}</span> : null}
      </div>
    </div>
  );
}
