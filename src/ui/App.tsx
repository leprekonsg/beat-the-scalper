import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api, ApiError, getToken, clearToken } from './api.ts';
import type { HealthResponse, ImportPrefill, MissionView, StateResponse } from './types.ts';
import { Band } from './components/Band.tsx';
import { MissionForm } from './components/MissionForm.tsx';
import { ImportPanel } from './components/ImportPanel.tsx';
import { MissionSlab } from './components/MissionSlab.tsx';
import { HealthPocket } from './components/HealthPocket.tsx';
import { LaunchPocket } from './components/LaunchPocket.tsx';
import { ObservationPocket } from './components/ObservationPocket.tsx';
import { ActionPocket } from './components/ActionPocket.tsx';
import { Timeline } from './components/Timeline.tsx';
import { Footer } from './components/Footer.tsx';
import { RestockAlert } from './components/RestockAlert.tsx';

const POLL_MS = 1500;

export function App(): ReactElement {
  const [connected, setConnected] = useState(false);
  const [checkedInitial, setCheckedInitial] = useState(false);
  const [healthResp, setHealthResp] = useState<HealthResponse | null>(null);
  const [stateResp, setStateResp] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [importPrefill, setImportPrefill] = useState<ImportPrefill | undefined>(undefined);
  // Server clock minus browser clock. Ages and countdowns must follow the server's clock, which may be virtual in demo.
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setCheckedInitial(true);
      return;
    }
    api
      .sessionCheck()
      .then(() => setConnected(true))
      .catch(() => clearToken())
      .finally(() => setCheckedInitial(true));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [h, s] = await Promise.all([api.health(), api.state()]);
      setHealthResp(h);
      setStateResp(s);
      const serverNow = Date.parse(h.health.clock.now);
      if (Number.isFinite(serverNow)) setClockOffsetMs(serverNow - Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [connected, refresh]);

  function handleMissionSaved(view: MissionView): void {
    setStateResp((prev) => (prev ? { ...prev, mission: view } : prev));
    void refresh();
  }

  const activeView = stateResp?.mission ?? null;
  const isDraft = !activeView || activeView.state === 'DRAFT';
  const serverNowMs = nowMs + clockOffsetMs;

  return (
    <>
      <Band connected={connected} health={healthResp} view={activeView} onTokenSaved={() => setConnected(true)} />

      <main className="page">
        {error ? (
          <div className="banner banner-error" data-testid="app-error">
            {error}
          </div>
        ) : null}

        {connected ? <RestockAlert events={stateResp?.recentEvents ?? null} nowMs={serverNowMs} /> : null}

        {!connected ? (
          checkedInitial ? (
            <section className="pocket connect-pocket">
              <div className="pocket-title">
                <span>Connect to the local API</span>
              </div>
              <p data-testid="connect-prompt">
                Paste the session token printed in the server console, or read it from <code>&lt;dataDir&gt;/session-token</code>, into the field in the band above. The token
                lives in this tab only.
              </p>
            </section>
          ) : null
        ) : healthResp ? (
          <div className="binder">
            <div className="col-left stack">
            <HealthPocket health={healthResp} nowMs={serverNowMs} onChanged={refresh} />

            {activeView ? (
              <LaunchPocket view={activeView} />
            ) : (
              <section className="pocket" aria-labelledby="guide-title">
                <div className="pocket-title">
                  <span id="guide-title">How a card gets filled</span>
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, fontSize: 'var(--fs-0)' }}>
                  <li>Import an announcement or shared alert, or type the facts you already have.</li>
                  <li>Save the draft. Missing facts are listed until the card can be armed.</li>
                  <li>Accept the expiry and arm. The monitor watches, the ledger prints every step.</li>
                  <li>Act from the card stub: pause, review conditions, cancel, or report the handoff.</li>
                </ol>
              </section>
            )}
            </div>

            {isDraft ? (
              <article className="pocket pocket-card" data-testid="mission-form-pocket">
                <div className="slab-body">
                  {activeView ? (
                    <div className="slab-eyebrow-row">
                      <span className="chip chip-neutral" data-testid="mission-state">
                        DRAFT
                      </span>
                    </div>
                  ) : (
                    <p className="empty-pocket-note">No card in this pocket</p>
                  )}
                  <MissionForm existing={activeView} prefill={importPrefill} onSaved={handleMissionSaved} />
                </div>
              </article>
            ) : (
              <MissionSlab view={activeView} health={healthResp} nowMs={serverNowMs} onChanged={refresh} />
            )}

            <div className="col-right stack">
            {activeView && !isDraft ? (
              <ObservationPocket view={activeView} />
            ) : (
              <section className="pocket" aria-labelledby="import-title">
                <div className="pocket-title">
                  <span id="import-title">Import announcement</span>
                </div>
                <ImportPanel onUseInMission={(prefill) => setImportPrefill({ ...prefill })} />
              </section>
            )}

            {activeView && !isDraft ? (
              <>
                <ActionPocket view={activeView} health={healthResp} />
                <details className="pocket">
                  <summary>Import announcement</summary>
                  <ImportPanel onUseInMission={(prefill) => setImportPrefill({ ...prefill })} />
                </details>
              </>
            ) : activeView ? (
              <ActionPocket view={activeView} health={healthResp} />
            ) : null}
            </div>

            <Timeline events={stateResp?.recentEvents ?? []} />
          </div>
        ) : null}

        <Footer demoStoreOrigin={healthResp?.demoStoreOrigin ?? null} />
      </main>
    </>
  );
}
