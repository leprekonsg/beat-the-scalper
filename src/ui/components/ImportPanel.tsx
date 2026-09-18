import { useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { api, ApiError } from '../api.ts';
import type { ImportPrefill, ImportResult } from '../types.ts';
import { Chip, provenanceTone } from './Chip.tsx';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function ImportPanel({ onUseInMission }: { onUseInMission: (prefill: ImportPrefill) => void }): ReactElement {
  const [text, setText] = useState('');
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [expectedTime, setExpectedTime] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageName(file.name);
    setImageData(await fileToBase64(file));
  }

  async function doImport(): Promise<void> {
    setBusy(true);
    setError(null);
    setFetchMessage(null);
    try {
      const res = await api.importAnnouncement({
        text: text.trim() || undefined,
        imagePngBase64: imageData ?? undefined,
        sourceUrl: sourceUrl.trim() || null,
        userExpectedTimeLocal: expectedTime.trim() || null,
      });
      setResult(res as ImportResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doFetchUrl(): Promise<void> {
    setBusy(true);
    setError(null);
    setFetchMessage(null);
    try {
      const res = await api.importAnnouncement({ sourceUrl: sourceUrl.trim() || null, fetch: true });
      setResult(res as ImportResult);
    } catch (err) {
      setFetchMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function useInMission(): void {
    if (!result) return;
    const x = result.extraction;
    onUseInMission({
      productFormat: x.productFormat.value ?? undefined,
      language: x.language.value ?? undefined,
      launchDateLocal: x.releaseDateLocal.value,
      launchTimeLocal: x.releaseTimeLocal.value ?? (expectedTime.trim() || null),
      launchBasis: result.launchPlan.launchBasis,
      packagingPolicy: x.packagingCondition.value === 'stated_removed' ? 'ask' : undefined,
    });
  }

  const facts = result
    ? ([
        ['Product format', result.extraction.productFormat],
        ['Product name', result.extraction.productName],
        ['Language', result.extraction.language],
        ['Market', result.extraction.market],
        ['Release date', result.extraction.releaseDateLocal],
        ['Release time', result.extraction.releaseTimeLocal],
        ['Timezone', result.extraction.timezone],
        ['Seller / channel', result.extraction.sellerOrChannel],
        ['Purchase limit', result.extraction.purchaseLimit],
        ['Packaging condition', result.extraction.packagingCondition],
        ['Relative age (verbatim)', result.extraction.relativeAge],
      ] as const)
    : [];

  return (
    <div data-testid="import-panel">
      <div className="field">
        <label>Paste announcement text</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the release announcement or listing text" data-testid="import-field-text" />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Upload screenshot (PNG/JPEG)</label>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg" onChange={(e) => void onFileChange(e)} data-testid="import-field-image" />
          {imageName ? <div className="field-note">Attached: {imageName}</div> : null}
        </div>
        <div className="field">
          <label>Source URL (stored as provenance only)</label>
          <input type="text" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://..." data-testid="import-field-source-url" />
        </div>
        <div className="field">
          <label>I expect launches around (HH:mm)</label>
          <input type="time" value={expectedTime} onChange={(e) => setExpectedTime(e.target.value)} data-testid="import-field-expected-time" />
        </div>
      </div>

      {error ? (
        <div className="banner banner-error" data-testid="import-error">
          {error}
        </div>
      ) : null}
      {fetchMessage ? (
        <div className="banner banner-info" data-testid="import-fetch-message">
          {fetchMessage}
        </div>
      ) : null}

      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void doImport()} data-testid="import-submit">
          Import
        </button>
        <button disabled={busy || !sourceUrl.trim()} onClick={() => void doFetchUrl()} data-testid="import-fetch-url">
          Fetch URL
        </button>
      </div>

      {result ? (
        <div style={{ marginTop: 16 }} data-testid="import-result">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <Chip tone={provenanceTone(result.provenance)} data-testid="import-provenance">
              {result.label}
            </Chip>
            <span className="field-note" data-testid="import-evidence-id">
              Evidence {result.evidenceId}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Fact</th>
                <th>Value</th>
                <th>Evidence</th>
                <th>Span</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {facts.map(([label, fact]) => (
                <tr key={label} data-testid={`import-fact-${label}`}>
                  <td>{label}</td>
                  <td>{fact.value === null ? 'Unknown' : String(fact.value)}</td>
                  <td>{fact.evidenceId ?? '-'}</td>
                  <td>{fact.span ?? '-'}</td>
                  <td>{fact.reason ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <strong>Launch plan:</strong> {result.launchPlan.message}
          </p>
          {result.missingFacts.length > 0 ? (
            <p className="field-note" data-testid="import-missing-facts">
              Missing: {result.missingFacts.join('; ')}
            </p>
          ) : null}
          <div className="button-row">
            <button className="primary" onClick={useInMission} data-testid="import-use-in-mission">
              Use in mission
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
