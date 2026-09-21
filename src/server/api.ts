/**
 * Local HTTP API (brief Section 12). Bind 127.0.0.1 only (enforced by the caller in index.ts).
 * Every request needs `X-BTS-Token` except the two session-bootstrap GETs; Origin is validated against
 * `config.uiOrigins` for every request; CORS is never permissive; bodies are capped at 5 MB.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MissionRow, Store } from '../storage/db.ts';
import type { WorkerApi } from '../worker/types.ts';
import type { AppConfig } from '../config.ts';
import type { Clock } from '../domain/time.ts';
import { addMs } from '../domain/time.ts';
import type { Authority, LaunchBasis, Mode, PackagingPolicy, PurchaseIntent } from '../domain/types.ts';
import { PurchaseIntentSchema } from '../domain/types.ts';
import { parseSgdToMinor } from '../domain/money.ts';
import { planLaunch } from '../domain/scheduling.ts';
import { missingFactsForArming } from '../domain/announcement.ts';

type Json = Record<string, unknown>;

export type ImportAnnouncementFn = (input: {
  text?: string;
  imagePngBase64?: string;
  sourceUrl?: string | null;
  userExpectedTimeLocal?: string | null;
}) => Promise<{
  evidenceId: string;
  extraction: unknown;
  provenance: string;
  label: string;
  launchPlan: unknown;
  missingFacts: string[];
  usage: unknown;
}>;

export interface ApiDeps {
  store: Store;
  worker: WorkerApi;
  config: AppConfig;
  sessionToken: string;
  clock: Clock;
  importAnnouncement: ImportAnnouncementFn;
  /** Presenter-only origin; the agent never reaches it. Reference-only here (see BTS_FABLE_BUILD_PLAN.md S4/S12). */
  demoAdmin?: { origin: string };
  /**
   * Addition beyond the literal brief signature (documented in the build report): surfaces the
   * concurrent-module capability map straight from wiring.ts so /api/health never has to guess.
   * Optional; defaults to all-missing so the handler is still usable without it.
   */
  capabilities?: { extraction: 'ready' | 'missing'; interpreter: 'ready' | 'missing'; demoBrowser: 'ready' | 'missing' };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Constant-time-ish token compare. Unequal lengths still run a comparison to avoid an obvious length leak. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    try {
      timingSafeEqual(ab, ab);
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function statusForError(err: unknown): number {
  const msg = errMsg(err);
  if (/not found/i.test(msg)) return 404;
  if (/unavailable/i.test(msg)) return 503;
  if (/stale generation|stop requested|illegal .*transition|execution lock held|unresolved prior attempt|one active mission/i.test(msg)) return 409;
  return 400;
}

function send(res: ServerResponse, status: number, body: Json): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  send(res, status, { error });
}

function readJsonBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new BodyTooLargeError('Request body exceeds the 5 MB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise(text.trim() === '' ? {} : (JSON.parse(text) as Json));
      } catch {
        rejectPromise(new InvalidJsonError('Invalid JSON body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

/** Only echo Access-Control-Allow-Origin for an allowed origin; no wildcard CORS. */
function applyCors(req: IncomingMessage, res: ServerResponse, uiOrigins: string[]): boolean {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin header: not a cross-origin browser request
  if (!uiOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-BTS-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

function accountRefFor(mode: Mode): string {
  return mode === 'demo' ? 'local-demo-account' : 'local-lazada-account';
}

/** Stable across edits/restarts: hash of mode + account + product identity + variant, first 32 hex chars. */
function computeFulfillmentKey(mode: Mode, accountRef: string, productUrlOrDescription: string, variantId: string | null): string {
  return createHash('sha256')
    .update(`${mode}|${accountRef}|${productUrlOrDescription}|${variantId ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof BodyTooLargeError) return sendError(res, 413, err.message);
      if (err instanceof InvalidJsonError) return sendError(res, 400, err.message);
      sendError(res, 500, `Internal error: ${errMsg(err)}`);
    });
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal.invalid');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (!applyCors(req, res, deps.config.uiOrigins)) {
    sendError(res, 403, `Origin not allowed: ${String(req.headers.origin)}`);
    return;
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const tokenExempt = method === 'GET' && (path === '/api/health' || path === '/api/session-check');
  if (!tokenExempt) {
    const provided = req.headers['x-bts-token'];
    if (typeof provided !== 'string' || !safeEqual(provided, deps.sessionToken)) {
      sendError(res, 401, 'Missing or invalid X-BTS-Token header');
      return;
    }
  }

  await route(method, path, url, req, res, deps);
}

async function route(method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'api') return sendError(res, 404, `No such route: ${method} ${path}`);

  if (method === 'GET' && segs.length === 2 && segs[1] === 'health') return getHealth(res, deps);
  if (method === 'GET' && segs.length === 2 && segs[1] === 'session-check') return getSessionCheck(req, res, deps);
  if (method === 'GET' && segs.length === 2 && segs[1] === 'state') return getState(res, deps);
  if (method === 'POST' && segs.length === 2 && segs[1] === 'imports') return postImports(req, res, deps);
  if (method === 'POST' && segs.length === 2 && segs[1] === 'missions') return postMissions(req, res, deps);

  if (segs[1] === 'missions' && segs.length === 3) {
    const id = segs[2]!;
    if (method === 'GET') return getMission(res, deps, id);
  }

  if (segs[1] === 'missions' && segs.length === 4) {
    const id = segs[2]!;
    const action = segs[3]!;
    if (method === 'GET' && action === 'events') return getMissionEvents(res, deps, id, url);
    if (method === 'POST') {
      switch (action) {
        case 'approve':
          return postApprove(req, res, deps, id);
        case 'pause':
          return postPause(req, res, deps, id);
        case 'resume':
          return postResume(res, deps, id);
        case 'cancel':
          return postCancel(res, deps, id);
        case 'handoff':
          return postHandoff(req, res, deps, id);
        case 'accept-condition':
          return postAcceptCondition(req, res, deps, id);
        case 'signal':
          return postSignal(req, res, deps, id);
        case 'revise':
          return postRevise(req, res, deps, id);
        default:
          break;
      }
    }
  }

  if (segs[1] === 'evidence' && segs.length === 3 && method === 'GET') return getEvidence(res, deps, segs[2]!);
  if (segs[1] === 'evidence' && segs.length === 4 && method === 'GET') {
    if (segs[3] === 'image') return getEvidenceImage(res, deps, segs[2]!);
    if (segs[3] === 'crop') return getEvidenceCrop(res, deps, segs[2]!, url);
  }

  if (segs[1] === 'clock' && segs.length === 3 && method === 'POST') {
    if (segs[2] === 'advance') return postClockAdvance(req, res, deps);
    if (segs[2] === 'set') return postClockSet(req, res, deps);
  }

  sendError(res, 404, `No such route: ${method} ${path}`);
}

// ---------- handlers ----------

function getHealth(res: ServerResponse, deps: ApiDeps): void {
  send(res, 200, {
    ok: true,
    health: deps.worker.health(),
    mode: deps.config.mode,
    modelPath: deps.config.modelPath,
    modelProvider: deps.config.modelProvider,
    model: deps.config.model,
    effort: deps.config.effort,
    monitorPolicy: deps.config.monitorPolicy,
    liveStatus: {
      observe: deps.config.liveObserveEnabled ? 'enabled' : 'blocked',
      prepare: deps.config.livePrepareEnabled ? 'enabled' : 'blocked',
      feasibilityNote: 'See docs/lazada-feasibility.md',
    },
    capabilities: deps.capabilities ?? { extraction: 'missing', interpreter: 'missing', demoBrowser: 'missing' },
    // Addition beyond the literal brief signature (documented in the build report): the footer needs to
    // name the demo storefront origin and note that presenter controls are a separate, agent-unreachable origin.
    demoStoreOrigin: deps.config.demoStoreOrigin,
    demoAdminOrigin: deps.demoAdmin?.origin ?? deps.config.demoAdminOrigin,
  });
}

function getSessionCheck(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): void {
  const provided = req.headers['x-bts-token'];
  if (typeof provided === 'string' && safeEqual(provided, deps.sessionToken)) send(res, 200, { ok: true });
  else sendError(res, 401, 'Invalid or missing token');
}

function getState(res: ServerResponse, deps: ApiDeps): void {
  const active = deps.store.activeMission();
  const mission = active ? deps.worker.missionView(active.id) : null;
  send(res, 200, {
    mission,
    missions: deps.store.listMissions(),
    health: deps.worker.health(),
    recentEvents: deps.store.listEvents(null, 50),
  });
}

async function postImports(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (body.fetch === true) {
    sendError(res, 501, 'URL fetch is not enabled: no permitted fetch method is configured (see docs/lazada-feasibility.md). Paste the text or upload a screenshot instead.');
    return;
  }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text : undefined;
  const imagePngBase64 = typeof body.imagePngBase64 === 'string' && body.imagePngBase64.trim() ? body.imagePngBase64 : undefined;
  if (!text && !imagePngBase64) {
    sendError(res, 400, 'Provide "text" or "imagePngBase64" to import');
    return;
  }
  const sourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl : null;
  const userExpectedTimeLocal = typeof body.userExpectedTimeLocal === 'string' && body.userExpectedTimeLocal.trim() ? body.userExpectedTimeLocal : null;
  const result = await deps.importAnnouncement({ text, imagePngBase64, sourceUrl, userExpectedTimeLocal });
  send(res, 200, result as unknown as Json);
}

async function postMissions(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);

  const mode = body.mode as Mode;
  if (mode !== 'demo' && mode !== 'lazada_assist') {
    sendError(res, 400, 'mode must be "demo" or "lazada_assist"');
    return;
  }

  const authorityRequested = ((body.authority as Authority | undefined) ?? 'observe') as Authority;
  if (mode === 'lazada_assist' && authorityRequested === 'demo_purchase') {
    sendError(res, 400, 'demo_purchase authority is only valid in demo mode; lazada_assist supports observe or prepare only');
    return;
  }

  let maxDeliveredPriceMinor: number;
  try {
    maxDeliveredPriceMinor = parseSgdToMinor(String(body.maxDeliveredPriceSgd ?? ''));
  } catch (err) {
    sendError(res, 400, errMsg(err));
    return;
  }

  const launchInput = (body.launch ?? {}) as { dateLocal?: string | null; timeLocal?: string | null; basis?: LaunchBasis };
  const launchPlan = planLaunch({ dateLocal: launchInput.dateLocal ?? null, timeLocal: launchInput.timeLocal ?? null, basis: launchInput.basis ?? 'unknown' });

  const now = deps.clock.now().toISOString();
  const expiresAt = typeof body.expiresAt === 'string' && body.expiresAt ? body.expiresAt : addMs(now, SEVEN_DAYS_MS);

  const accountRef = accountRefFor(mode);
  const productUrl = typeof body.productUrl === 'string' && body.productUrl ? body.productUrl : null;
  const description = typeof body.description === 'string' ? body.description : '';
  const variantId = typeof body.variantId === 'string' && body.variantId ? body.variantId : null;
  const fulfillmentKey = computeFulfillmentKey(mode, accountRef, productUrl ?? description, variantId);

  const intent: PurchaseIntent = {
    id: `mis_${randomUUID()}`,
    revision: 1,
    fulfillmentKey,
    mode,
    accountRef,
    target: {
      productUrl,
      retailerProductId: typeof body.retailerProductId === 'string' && body.retailerProductId ? body.retailerProductId : null,
      variantId,
      sellerRef: typeof body.sellerRef === 'string' && body.sellerRef ? body.sellerRef : null,
      sellerEvidenceId: typeof body.sellerEvidenceId === 'string' && body.sellerEvidenceId ? body.sellerEvidenceId : null,
      productFormat: typeof body.productFormat === 'string' ? body.productFormat : '',
      language: typeof body.language === 'string' ? body.language : '',
      description,
    },
    quantity: 1,
    currency: 'SGD',
    maxDeliveredPriceMinor,
    packagingPolicy: ((body.packagingPolicy as PackagingPolicy | undefined) ?? 'ask') as PackagingPolicy,
    allowedConditionEvidenceIds: [],
    launchAt: launchPlan.launchAt,
    launchBasis: launchPlan.launchBasis,
    launchEvidenceId: null,
    restockWindow: { timezone: 'Asia/Singapore', startLocal: '13:00', endLocal: '14:00', basis: 'user_observation', enabled: Boolean(body.restockWindowEnabled) },
    expiresAt,
    authority: authorityRequested,
  };

  const parsed = PurchaseIntentSchema.safeParse(intent);
  if (!parsed.success) {
    send(res, 400, { error: 'Invalid mission intent', issues: parsed.error.issues });
    return;
  }

  let row: MissionRow;
  try {
    row = deps.store.createMission(parsed.data, now);
  } catch (err) {
    const msg = errMsg(err);
    if (/fulfillment_key/.test(msg)) {
      sendError(res, 409, 'A mission already exists for this product and variant in this mode. Cancel it or resume it; one mission per product is a Section 9 guarantee.');
      return;
    }
    sendError(res, statusForError(err), msg);
    return;
  }

  send(res, 201, {
    mission: deps.worker.missionView(row.id),
    missingFactsForArming: missingFactsForArming({
      productUrl: intent.target.productUrl,
      retailerProductId: intent.target.retailerProductId,
      variantId: intent.target.variantId,
      sellerRef: intent.target.sellerRef,
      maxDeliveredPriceMinor: intent.maxDeliveredPriceMinor,
      expiresAt: intent.expiresAt,
    }),
  });
}

async function postApprove(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const expiresAt = typeof body.expiresAt === 'string' && body.expiresAt ? body.expiresAt : null;
  if (!expiresAt) {
    sendError(res, 400, 'expiresAt is required: the user must accept the watch expiry before arming');
    return;
  }
  const mission = deps.store.getMission(id);
  if (!mission) {
    sendError(res, 404, `Mission ${id} not found`);
    return;
  }
  const authority = ((body.authority as Authority | undefined) ?? mission.intent.authority) as Authority;
  if (mission.intent.mode === 'lazada_assist' && authority === 'demo_purchase') {
    sendError(res, 400, 'demo_purchase authority is only valid in demo mode; lazada_assist supports observe or prepare only');
    return;
  }
  try {
    deps.worker.approveIntent(id, { expiresAt, authority });
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

async function postPause(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'Paused by user';
  try {
    deps.worker.pauseMission(id, reason);
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

function postResume(res: ServerResponse, deps: ApiDeps, id: string): void {
  try {
    deps.worker.resumeMission(id);
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

function postCancel(res: ServerResponse, deps: ApiDeps, id: string): void {
  try {
    deps.worker.cancelMission(id);
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

async function postHandoff(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const result = body.result as 'ordered' | 'not_ordered' | 'unknown';
  if (!['ordered', 'not_ordered', 'unknown'].includes(result)) {
    sendError(res, 400, 'result must be one of "ordered", "not_ordered", "unknown"');
    return;
  }
  const merchantOrderRef = typeof body.merchantOrderRef === 'string' && body.merchantOrderRef ? body.merchantOrderRef : null;
  try {
    deps.worker.completeHandoff(id, { result, merchantOrderRef });
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

async function postAcceptCondition(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const evidenceId = typeof body.evidenceId === 'string' && body.evidenceId ? body.evidenceId : null;
  if (!evidenceId) {
    sendError(res, 400, 'evidenceId is required');
    return;
  }
  try {
    deps.worker.acceptCondition(id, evidenceId);
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

async function postSignal(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const kind = body.kind as 'restock_alert' | 'official_announcement' | 'user_note';
  if (!['restock_alert', 'official_announcement', 'user_note'].includes(kind)) {
    sendError(res, 400, 'kind must be one of "restock_alert", "official_announcement", "user_note"');
    return;
  }
  const dedupeKey = typeof body.dedupeKey === 'string' && body.dedupeKey ? body.dedupeKey : null;
  if (!dedupeKey) {
    sendError(res, 400, 'dedupeKey is required to dedupe repeated signals');
    return;
  }
  const evidenceId = typeof body.evidenceId === 'string' && body.evidenceId ? body.evidenceId : null;
  try {
    const result = deps.worker.importSignal({ missionId: id, kind, dedupeKey, evidenceId, receivedAt: deps.clock.now().toISOString() });
    send(res, 200, result as unknown as Json);
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
  }
}

const REVISABLE_TARGET_FIELDS = ['productUrl', 'retailerProductId', 'variantId', 'sellerRef', 'sellerEvidenceId', 'productFormat', 'language', 'description'] as const;

async function postRevise(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const mission = deps.store.getMission(id);
  if (!mission) {
    sendError(res, 404, `Mission ${id} not found`);
    return;
  }
  const current = mission.intent;

  let maxDeliveredPriceMinor = current.maxDeliveredPriceMinor;
  if (typeof body.maxDeliveredPriceSgd === 'string' && body.maxDeliveredPriceSgd) {
    try {
      maxDeliveredPriceMinor = parseSgdToMinor(body.maxDeliveredPriceSgd);
    } catch (err) {
      sendError(res, 400, errMsg(err));
      return;
    }
  }

  const targetPatch: Partial<PurchaseIntent['target']> = {};
  for (const field of REVISABLE_TARGET_FIELDS) {
    if (field in body) targetPatch[field] = body[field] as never;
  }

  const next: PurchaseIntent = {
    ...current,
    revision: current.revision + 1,
    target: { ...current.target, ...targetPatch },
    maxDeliveredPriceMinor,
    packagingPolicy: ((body.packagingPolicy as PackagingPolicy | undefined) ?? current.packagingPolicy) as PackagingPolicy,
  };

  const parsed = PurchaseIntentSchema.safeParse(next);
  if (!parsed.success) {
    send(res, 400, { error: 'Invalid revision', issues: parsed.error.issues });
    return;
  }

  try {
    deps.store.updateIntent(id, parsed.data, deps.clock.now().toISOString(), typeof body.reason === 'string' && body.reason ? body.reason : 'User revision');
  } catch (err) {
    sendError(res, statusForError(err), errMsg(err));
    return;
  }
  send(res, 200, { mission: deps.worker.missionView(id) });
}

function getMission(res: ServerResponse, deps: ApiDeps, id: string): void {
  const view = deps.worker.missionView(id);
  if (!view) {
    sendError(res, 404, `Mission ${id} not found`);
    return;
  }
  send(res, 200, view as unknown as Json);
}

function getMissionEvents(res: ServerResponse, deps: ApiDeps, id: string, url: URL): void {
  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
  send(res, 200, { events: deps.store.listEvents(id, limit) });
}

function getEvidence(res: ServerResponse, deps: ApiDeps, id: string): void {
  const evidence = deps.store.getEvidence(id);
  if (!evidence) {
    sendError(res, 404, `Evidence ${id} not found`);
    return;
  }
  send(res, 200, evidence as unknown as Json);
}

function getEvidenceImage(res: ServerResponse, deps: ApiDeps, id: string): void {
  const filePath = join(deps.config.dataDir, 'evidence', `${id}.png`);
  if (!existsSync(filePath)) {
    sendError(res, 404, `No stored image for evidence ${id}`);
    return;
  }
  const buf = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
  res.end(buf);
}

function getEvidenceCrop(res: ServerResponse, deps: ApiDeps, id: string, url: URL): void {
  const filePath = join(deps.config.dataDir, 'evidence', `${id}.png`);
  if (!existsSync(filePath)) {
    sendError(res, 404, `No stored image for evidence ${id}`);
    return;
  }
  const coords = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(url.searchParams.get(k)));
  if (coords.some((n) => !Number.isFinite(n))) {
    sendError(res, 400, 'x0, y0, x1, y1 query parameters are required and must be numbers');
    return;
  }
  const buf = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buf.length,
    'X-BTS-Crop-Region': coords.join(','),
    'X-BTS-Crop-Note': 'Full image returned; crop/zoom is rendered client-side',
  });
  res.end(buf);
}

async function postClockAdvance(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  if (deps.worker.health().clock.kind !== 'virtual') {
    sendError(res, 409, 'Clock is not virtual; cannot advance (start the server with BTS_VIRTUAL_CLOCK_START to enable the accelerated demo clock)');
    return;
  }
  const body = await readJsonBody(req);
  const ms = Number(body.ms);
  if (!Number.isFinite(ms) || ms < 0) {
    sendError(res, 400, 'ms must be a non-negative number');
    return;
  }
  const vc = deps.clock as unknown as { advanceMs?: (ms: number) => void };
  if (typeof vc.advanceMs !== 'function') {
    sendError(res, 409, 'Clock does not support advanceMs');
    return;
  }
  vc.advanceMs(ms);
  try {
    await deps.worker.tick();
  } catch {
    /* best-effort catch-up tick for the demo; failures surface on the next scheduled tick */
  }
  send(res, 200, { ok: true, health: deps.worker.health() });
}

async function postClockSet(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  if (deps.worker.health().clock.kind !== 'virtual') {
    sendError(res, 409, 'Clock is not virtual; cannot set (start the server with BTS_VIRTUAL_CLOCK_START to enable the accelerated demo clock)');
    return;
  }
  const body = await readJsonBody(req);
  const iso = typeof body.iso === 'string' ? body.iso : '';
  if (!iso || Number.isNaN(Date.parse(iso))) {
    sendError(res, 400, 'iso must be a valid ISO-8601 instant');
    return;
  }
  const vc = deps.clock as unknown as { set?: (iso: string) => void };
  if (typeof vc.set !== 'function') {
    sendError(res, 409, 'Clock does not support set');
    return;
  }
  try {
    vc.set(iso);
  } catch (err) {
    sendError(res, 400, errMsg(err));
    return;
  }
  try {
    await deps.worker.tick();
  } catch {
    /* best-effort catch-up tick for the demo */
  }
  send(res, 200, { ok: true, health: deps.worker.health() });
}
