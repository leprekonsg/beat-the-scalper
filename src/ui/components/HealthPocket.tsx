import { useState } from 'react';
import type { ReactElement } from 'react';
import { api, ApiError } from '../api.ts';
import { ageLabel, formatLocalSgt, formatUtc } from '../format.ts';
import type { HealthResponse } from '../types.ts';
import { Chip, healthTone } from './Chip.tsx';

function readinessTone(v: string): 'teal' | 'amber' | 'brick' | 'charcoal' | 'neutral' {
  switch (v) {
    case 'live':
    case 'ready':
      return 'teal';
    case 'offline_replay':
      return 'charcoal';
    case 'not_started':
      return 'amber';
    case 'blocked':
    case 'failed':
      return 'brick';
    default:
      return 'neutral';
  }
}

/** Monitor health: heartbeat, readiness, cadence, and the clock (with demo-only acceleration controls). */
export function HealthPocket({ health, nowMs, onChanged }: { health: HealthResponse; nowMs: number; onChanged: () => void }): ReactElement {
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const h = health.health;
  const isVirtual = h.clock.kind === 'virtual';

  async function clock(action: () => Promise<unknown>): Promise<void> {
    setClockBusy(true);
    setClockError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setClockError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setClockBusy(false);
    }
  }

  function advanceTo1300(): Promise<unknown> {
    const now = new Date(h.clock.now);
    const target = new Date(now);
    target.setUTCHours(5, 0, 0, 0); // 13:00 Asia/Singapore is 05:00 UTC
    if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
    return api.clockSet(target.toISOString());
  }

  return (
    <section className="pocket" aria-labelledby="health-title">
      <div className="pocket-title">
        <span id="health-title">Monitor</span>
        <span className="pocket-title-right" data-testid="cadence">
          {h.cadence ?? 'no cadence'}
        </span>
      </div>
      <dl className="kv">
        <dt>Health</dt>
        <dd>
          <Chip tone={healthTone(h.health)} pulse={h.health === 'Healthy'} data-testid="monitor-health">
            {h.health}
          </Chip>
        </dd>
        <dt>Heartbeat</dt>
        <dd className="num" data-testid="worker-heartbeat">
          {ageLabel(h.workerHeartbeatAt, nowMs)}
        </dd>
        <dt>Last good read</dt>
        <dd className="num" data-testid="last-successful-observation">
          {ageLabel(h.lastSuccessfulObservationAt, nowMs)}
        </dd>
        <dt>Next check</dt>
        <dd className="num" data-testid="next-check">
          {h.nextCheckAt ? formatLocalSgt(h.nextCheckAt) : 'Not scheduled'}
        </dd>
        <dt>Missed</dt>
        <dd className="num" data-testid="missed-checks">
          {h.missedChecks}
        </dd>
        <dt>Model</dt>
        <dd>
          <Chip tone={readinessTone(h.apiReadiness)} data-testid="api-readiness">
            {h.apiReadiness}
          </Chip>
        </dd>
        <dt>Browser</dt>
        <dd>
          <Chip tone={readinessTone(h.browserReadiness)} data-testid="browser-readiness">
            {h.browserReadiness}
          </Chip>
        </dd>
      </dl>
      {h.cadenceLabels.length > 0 ? (
        <p className="note" data-testid="cadence-labels">
          {h.cadenceLabels.join(' / ')}
        </p>
      ) : null}

      <div className="pocket-title" style={{ marginTop: 18 }}>
        <span>{isVirtual ? 'Virtual clock' : 'System clock'}</span>
      </div>
      <p className="num" data-testid="clock-now" style={{ fontSize: 'var(--fs-0)' }}>
        {formatLocalSgt(h.clock.now)}
        <br />
        <span style={{ color: 'var(--ink-3)' }}>{formatUtc(h.clock.now)}</span>
      </p>
      {isVirtual ? (
        <div className="button-row">
          <button disabled={clockBusy} onClick={() => void clock(() => api.clockAdvance(60_000))} data-testid="clock-advance-1m">
            +1 min
          </button>
          <button disabled={clockBusy} onClick={() => void clock(() => api.clockAdvance(600_000))} data-testid="clock-advance-10m">
            +10 min
          </button>
          <button disabled={clockBusy} onClick={() => void clock(advanceTo1300)} data-testid="clock-advance-1300">
            To 13:00 SGT
          </button>
        </div>
      ) : null}
      {clockError ? (
        <div className="banner banner-error" data-testid="clock-error" style={{ marginTop: 10 }}>
          {clockError}
        </div>
      ) : null}
    </section>
  );
}
