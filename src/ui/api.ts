/**
 * Fetch wrapper for the local API. Adds `X-BTS-Token` from sessionStorage to every request; never
 * persists the token anywhere more durable than the tab (brief Section 12).
 */
import type { EventRecord, HealthResponse, ImportResult, MissionDraftInput, MissionView, StateResponse } from './types.ts';

const TOKEN_KEY = 'bts.sessionToken';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('X-BTS-Token', token);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch (err) {
    throw new ApiError(0, `Cannot reach the BTS API. Is "npm run server" running? (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** Fire-and-forget: records that the user zoomed into a crop region, for the evidentiary record. */
export async function recordCropView(evidenceId: string, region: { x0: number; y0: number; x1: number; y1: number }): Promise<void> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set('X-BTS-Token', token);
  const qs = `x0=${Math.round(region.x0)}&y0=${Math.round(region.y0)}&x1=${Math.round(region.x1)}&y1=${Math.round(region.y1)}`;
  try {
    await fetch(`/api/evidence/${evidenceId}/crop?${qs}`, { headers });
  } catch {
    /* best-effort */
  }
}

/** Loads a token-protected image as a blob URL. Caller must revoke it when done. */
export async function loadProtectedImage(path: string): Promise<string> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set('X-BTS-Token', token);
  const res = await fetch(`/api${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status, `Failed to load image (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  sessionCheck: () => request<{ ok: true }>('/session-check'),
  state: () => request<StateResponse>('/state'),

  importAnnouncement: (input: { text?: string; imagePngBase64?: string; sourceUrl?: string | null; userExpectedTimeLocal?: string | null; fetch?: boolean }) =>
    request<ImportResult | { error: string }>('/imports', { method: 'POST', body: JSON.stringify(input) }),

  createMission: (draft: MissionDraftInput) => request<{ mission: MissionView; missingFactsForArming: string[] }>('/missions', { method: 'POST', body: JSON.stringify(draft) }),

  getMission: (id: string) => request<MissionView>(`/missions/${id}`),
  getMissionEvents: (id: string, limit = 50) => request<{ events: EventRecord[] }>(`/missions/${id}/events?limit=${limit}`),

  approve: (id: string, body: { expiresAt: string; authority: string }) => request<{ mission: MissionView }>(`/missions/${id}/approve`, { method: 'POST', body: JSON.stringify(body) }),
  pause: (id: string, reason: string) => request<{ mission: MissionView }>(`/missions/${id}/pause`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resume: (id: string) => request<{ mission: MissionView }>(`/missions/${id}/resume`, { method: 'POST' }),
  cancel: (id: string) => request<{ mission: MissionView }>(`/missions/${id}/cancel`, { method: 'POST' }),
  handoff: (id: string, body: { result: 'ordered' | 'not_ordered' | 'unknown'; merchantOrderRef: string | null }) =>
    request<{ mission: MissionView }>(`/missions/${id}/handoff`, { method: 'POST', body: JSON.stringify(body) }),
  acceptCondition: (id: string, evidenceId: string) => request<{ mission: MissionView }>(`/missions/${id}/accept-condition`, { method: 'POST', body: JSON.stringify({ evidenceId }) }),
  signal: (id: string, body: { kind: string; dedupeKey: string; evidenceId: string | null }) =>
    request<{ queued: boolean; duplicate: boolean }>(`/missions/${id}/signal`, { method: 'POST', body: JSON.stringify(body) }),
  revise: (id: string, body: Record<string, unknown>) => request<{ mission: MissionView }>(`/missions/${id}/revise`, { method: 'POST', body: JSON.stringify(body) }),

  getEvidence: (id: string) => request<Record<string, unknown>>(`/evidence/${id}`),
  evidenceImagePath: (id: string) => `/evidence/${id}/image`,

  clockAdvance: (ms: number) => request<{ ok: true; health: HealthResponse['health'] }>('/clock/advance', { method: 'POST', body: JSON.stringify({ ms }) }),
  clockSet: (iso: string) => request<{ ok: true; health: HealthResponse['health'] }>('/clock/set', { method: 'POST', body: JSON.stringify({ iso }) }),
};
