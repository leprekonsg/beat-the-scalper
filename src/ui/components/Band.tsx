import { useState } from 'react';
import type { ReactElement } from 'react';
import { currentOrNextWindow, isWithinWindow } from '../../domain/time.ts';
import { api, setToken } from '../api.ts';
import { countdownLabel, formatClockSgt, formatHmSgt } from '../format.ts';
import type { HealthResponse, MissionView, Mode } from '../types.ts';
import { Chip } from './Chip.tsx';

/** The teal night band: logo, wordmark, mode and model chips, and the observatory clock. */
export function Band({
  connected,
  health,
  view,
  onTokenSaved,
}: {
  connected: boolean;
  health: HealthResponse | null;
  view: MissionView | null;
  onTokenSaved: () => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    if (!draft.trim()) return;
    setChecking(true);
    setError(null);
    setToken(draft.trim());
    try {
      await api.sessionCheck();
      onTokenSaved();
    } catch {
      setError('Token rejected by the server');
    } finally {
      setChecking(false);
    }
  }

  const mode: Mode | null = health?.mode ?? null;
  const modelPath = health?.modelPath ?? null;
  const clockNow = health?.health.clock.now ?? null;
  const isVirtual = health?.health.clock.kind === 'virtual';
  const nextCheckAt = health?.health.nextCheckAt ?? null;

  let windowState = 'Not enabled';
  let windowNote = 'user observation, not a schedule';
  if (view?.intent.restockWindow.enabled && clockNow) {
    const now = new Date(clockNow);
    if (isWithinWindow(now, view.intent.restockWindow)) {
      windowState = 'In window';
    } else {
      const w = currentOrNextWindow(now, view.intent.restockWindow);
      windowState = `Next ${formatHmSgt(w.startAt)}`;
      windowNote = `${view.intent.restockWindow.startLocal}-${view.intent.restockWindow.endLocal} SGT, user observation`;
    }
  }

  return (
    <header className="band">
      <div className="band-inner">
        <div className="band-brand">
          <img src="/bts_logo.png" alt="" width={56} height={56} />
          <div>
            <h1>Beat The Scalper</h1>
            <div className="band-sub">One item, one person, one honest board</div>
          </div>
        </div>

        <div className="band-badges">
          {mode ? (
            <Chip tone={mode === 'demo' ? 'blue' : 'amber'} data-testid="mode-badge">
              {mode === 'demo' ? 'Mode: demo' : 'Mode: Lazada assist'}
            </Chip>
          ) : null}
          {modelPath ? (
            <Chip tone={modelPath === 'live' ? 'teal' : 'charcoal'} data-testid="model-path-badge">
              {modelPath === 'live' ? `Model path: live (${health?.model ?? ''})` : 'Model path: offline replay'}
            </Chip>
          ) : null}
          {health?.liveStatus.observe === 'blocked' && mode === 'lazada_assist' ? <Chip tone="brick">Live observe blocked</Chip> : null}
        </div>

        <div className="band-right">
          {connected ? (
            <div className="clock-cells" role="group" aria-label="Observatory clock">
              <div className="clock-cell">
                <span className="clock-label">{isVirtual ? 'Now (virtual)' : 'Now'}</span>
                <span className="clock-value" data-testid="band-now">
                  {formatClockSgt(clockNow)}
                </span>
                <span className="clock-note">SGT</span>
              </div>
              <div className="clock-cell">
                <span className="clock-label">Next check</span>
                <span className={`clock-value${nextCheckAt ? '' : ' is-quiet'}`} data-testid="band-next-check">
                  {nextCheckAt ? formatClockSgt(nextCheckAt) : 'none'}
                </span>
                <span className="clock-note">{countdownLabel(nextCheckAt, clockNow)}</span>
              </div>
              <div className="clock-cell">
                <span className="clock-label">Window 13:00-14:00</span>
                <span className={`clock-value${view?.intent.restockWindow.enabled ? '' : ' is-quiet'}`} data-testid="band-window">
                  {windowState}
                </span>
                <span className="clock-note">{windowNote}</span>
              </div>
            </div>
          ) : (
            <div className="token-connect">
              <input
                type="password"
                placeholder="Paste session token"
                aria-label="Session token"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
                data-testid="token-input"
              />
              <button className="primary" disabled={checking} onClick={() => void connect()} data-testid="token-connect">
                Connect
              </button>
              {error ? (
                <span className="token-error" data-testid="token-error">
                  {error}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
