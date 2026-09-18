import type { ReactElement } from 'react';
import { currentOrNextWindow } from '../../domain/time.ts';
import { formatHmSgt, formatLocalSgt } from '../format.ts';
import type { RestockWindow } from '../types.ts';

/**
 * The restock window drawn as a sunrise: the amber sun travels the arc from window start to window end
 * according to the server clock. Outside the window the sun rests below the horizon in graphite.
 * Position is a rendering of the clock, never evidence that anything restocked.
 */
export function SunriseArc({ clockNowIso, window: spec }: { clockNowIso: string; window: RestockWindow }): ReactElement {
  const now = new Date(clockNowIso);
  const w = currentOrNextWindow(now, spec);
  const start = Date.parse(w.startAt);
  const end = Date.parse(w.endAt);
  const t = now.getTime();
  const inWindow = spec.enabled && t >= start && t < end;

  // A shallow arc segment: full section width, capped height so the stub row stays in the first viewport.
  const W = 320;
  const H = 110;
  const cx = W / 2;
  const cy = 88; // horizon
  const half = 150; // half chord
  const sag = 66; // arc height above the horizon
  const R = (half * half + sag * sag) / (2 * sag);
  const arcCy = cy + R - sag;
  const theta0 = Math.asin(half / R);
  const onArc = (frac: number, radius = R): { x: number; y: number } => {
    const a = -theta0 + 2 * theta0 * frac;
    return { x: cx + radius * Math.sin(a), y: arcCy - radius * Math.cos(a) };
  };
  const sunR = 12;
  const restBefore = !inWindow && t < start;
  let sunX: number;
  let sunY: number;
  if (inWindow) {
    const frac = Math.min(1, Math.max(0, (t - start) / (end - start)));
    ({ x: sunX, y: sunY } = onArc(frac));
  } else if (restBefore) {
    // Resting sun sits exactly at the window-start end of the horizon, never at a position that reads as a time.
    sunX = cx - half;
    sunY = cy + 17;
  } else {
    sunX = cx + half;
    sunY = cy + 17;
  }
  const leftLabelX = cx - half + (restBefore ? sunR * 2 + 2 : 0);
  const rightLabelX = cx + half - (!inWindow && !restBefore ? sunR * 2 + 2 : 0);

  let state: string;
  let detail: string;
  if (!spec.enabled) {
    state = 'Window not watched';
    detail = 'Enable the 13:00-14:00 SGT window on the draft to prioritise checks there.';
  } else if (inWindow) {
    state = 'In window now';
    detail = `Until ${formatHmSgt(w.endAt)} SGT. Priority cadence applies.`;
  } else {
    state = `Next window ${formatHmSgt(w.startAt)} SGT`;
    detail = formatLocalSgt(w.startAt);
  }

  // tick marks every 15 minutes along the arc
  const ticks = [0.25, 0.5, 0.75].map((f) => {
    const inner = onArc(f, R - 5);
    const outer = onArc(f, R + 5);
    return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
  });
  const arcStart = onArc(0);
  const arcEnd = onArc(1);

  return (
    <div className="sunrise" data-testid="sunrise-arc" data-in-window={inWindow ? 'true' : 'false'}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Restock window ${spec.startLocal} to ${spec.endLocal} Singapore time. ${state}.`}>
        <defs>
          <clipPath id="sunrise-sky">
            <rect x="0" y="0" width={W} height={cy} />
          </clipPath>
          <radialGradient id="sunrise-glow">
            <stop offset="0%" stopColor="var(--amber)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--amber)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {inWindow ? <circle cx={sunX} cy={sunY} r={sunR * 3.2} fill="url(#sunrise-glow)" clipPath="url(#sunrise-sky)" /> : null}
        <path d={`M ${arcStart.x} ${arcStart.y} A ${R} ${R} 0 0 1 ${arcEnd.x} ${arcEnd.y}`} fill="none" stroke="var(--grout-strong)" strokeWidth="1.25" strokeDasharray="3 4" />
        {ticks.map((tk, i) => (
          <line key={i} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--terracotta)" strokeWidth="1" />
        ))}
        <line x1="6" y1={cy} x2={W - 6} y2={cy} stroke="var(--terracotta)" strokeWidth="1.25" />
        <g clipPath="url(#sunrise-sky)">
          <circle cx={sunX} cy={sunY} r={sunR} fill={inWindow ? 'var(--amber)' : 'var(--graphite)'} />
        </g>
        {!inWindow ? <circle cx={sunX} cy={sunY} r={sunR} fill="var(--paper-deep)" stroke="var(--graphite)" strokeWidth="1.25" strokeDasharray="3 3" /> : null}
        <text x={leftLabelX} y={cy + 20} fontSize="11" fontFamily="var(--mono)" fill="var(--ink-2)" textAnchor="start">
          {spec.startLocal}
        </text>
        <text x={rightLabelX} y={cy + 20} fontSize="11" fontFamily="var(--mono)" fill="var(--ink-2)" textAnchor="end">
          {spec.endLocal}
        </text>
        {inWindow ? (
          <text x={cx} y={cy + 20} fontSize="10" fontFamily="var(--sans)" fill="var(--ink-3)" textAnchor="middle">
            sun travels with the clock
          </text>
        ) : null}
      </svg>
      <div className="sunrise-text">
        <span className="sunrise-state" data-testid="restock-status">
          {state}
        </span>
        <span className="sunrise-detail">{detail}</span>
      </div>
    </div>
  );
}
