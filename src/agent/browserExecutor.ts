/**
 * RestrictedBrowserExecutor: application-owned enforcement of the browser toolset's
 * mode-specific action surface (BTS_FABLE_BUILD_PLAN.md sections 8-9).
 *
 * The executor rejects disallowed actions regardless of what the model requests
 * (A17) -- a disabled `configs` entry keeps a member out of the served schema, but
 * `dispatch()` enforces the same restriction again in code, because a model is not
 * guaranteed to respect its own served schema. Submission (A18, A26) is rejected in
 * every mode: the demo controller submits through `DemoStoreExecutor.submitDemoOrder`
 * after durably persisting `SUBMISSION_STARTED`, never through a model-issued click.
 * Coordinate-target clicks are rejected in every mode; only `ref` targets resolved
 * from `read_page`/`find` are accepted.
 */
import type { Frame, Locator, Page } from 'playwright';
import type {
  BrowserStateBlockParam,
  BrowserStateTabEntry,
  BrowserToolset20260801,
  BrowserToolsetConfigs,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';

export type BrowserExecutorMode = 'demo' | 'lazada_observe' | 'lazada_prepare';

export type IncidentKind =
  | 'member_not_enabled'
  | 'submission_attempt_blocked'
  | 'coordinate_click_blocked'
  | 'navigation_blocked'
  | 'unexpected_navigation'
  | 'dispatch_error';

export interface RestrictedBrowserExecutorOptions {
  page: Page;
  mode: BrowserExecutorMode;
  /** Origins the executor may navigate/observe. Ignored for loopback/private hosts unless they equal demoStoreOrigin. */
  allowedOrigins: string[];
  /** The only loopback origin ever permitted, and only in 'demo' mode. */
  demoStoreOrigin: string | null;
  onIncident: (kind: IncidentKind, detail: string) => void;
}

type BrowserMemberName = keyof BrowserToolsetConfigs;

/** Every member of browser_toolset_20260801, as of this SDK version. */
const ALL_MEMBERS: BrowserMemberName[] = [
  'close_tab',
  'double_click',
  'file_upload',
  'find',
  'form_input',
  'get_page_text',
  'hold_key',
  'hover',
  'javascript_exec',
  'key',
  'left_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'list_tabs',
  'middle_click',
  'mouse_move',
  'navigate',
  'new_tab',
  'read_console',
  'read_network',
  'read_page',
  'right_click',
  'screenshot',
  'scroll',
  'scroll_to',
  'switch_tab',
  'triple_click',
  'type',
  'wait',
  'zoom',
];

/** Read/observe surface available in every mode, including lazada_observe. */
const OBSERVE_MEMBERS: BrowserMemberName[] = ['screenshot', 'zoom', 'read_page', 'get_page_text', 'find', 'scroll', 'wait', 'navigate'];
/** demo additionally allows preparing and submitting a simulated purchase (submission is still guarded, see below). */
const DEMO_EXTRA_MEMBERS: BrowserMemberName[] = ['left_click', 'type', 'form_input'];
/** lazada_prepare allows only ref-based clicks on individually validated, non-submitting controls. */
const PREPARE_EXTRA_MEMBERS: BrowserMemberName[] = ['left_click'];

function enabledMembersFor(mode: BrowserExecutorMode): Set<BrowserMemberName> {
  const set = new Set<BrowserMemberName>(OBSERVE_MEMBERS);
  if (mode === 'demo') for (const m of DEMO_EXTRA_MEMBERS) set.add(m);
  if (mode === 'lazada_prepare') for (const m of PREPARE_EXTRA_MEMBERS) set.add(m);
  // 'key' is deliberately never enabled in any mode: an Enter keystroke can submit a
  // form exactly like a click on a submit control, so it stays disabled everywhere.
  return set;
}

const SUBMIT_TEXT_RE = /place order|buy now|pay now|checkout|submit order|confirm order|place simulated order/i;
const SUBMIT_FORM_ACTION_RE = /submit|order|pay|checkout/i;
/**
 * Paths that submit a purchase by navigation alone (section 9: a disabled submit
 * function is not sufficient if a URL can submit the same order). Deliberately
 * narrow -- a plain `/checkout` or `/cart` review page stays readable.
 */
const SUBMIT_URL_PATH_RE =
  /(^|\/)(place[-_]?order|submit[-_]?order|confirm[-_]?order|order[-_]?submit|buy[-_]?now|pay[-_]?now)(\/|$)|\/(checkout|cart|order|payment)\/(submit|pay|confirm|place)(\/|$)/i;

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // URL.hostname keeps IPv6 literals bracketed ("[::1]", "[::ffff:7f00:1]"), so the
  // textual forms never match an unbracketed compare and IPv4-mapped forms cannot be
  // range-matched reliably. A raw IPv6 literal is never a legitimate retailer
  // destination here, so every one of them is treated as local/private and can only
  // be reached when it is exactly the demo store origin.
  if (host.startsWith('[') || host === '::1' || host === '::') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

interface RefEntry {
  locator: Locator;
  label: string;
  role: string;
}

/**
 * Sequential, ordered, halt-on-first-failure execution of a browser toolset member
 * batch, with the mode's action surface enforced at every step regardless of model
 * compliance. One `Page` per executor instance (single-tab; multi-tab members are
 * always disabled).
 */
export class RestrictedBrowserExecutor {
  private readonly page: Page;
  readonly mode: BrowserExecutorMode;
  private readonly allowedOrigins: Set<string>;
  private readonly demoStoreOrigin: string | null;
  private readonly onIncident: (kind: IncidentKind, detail: string) => void;
  private readonly enabledMembers: Set<BrowserMemberName>;
  private refs = new Map<string, RefEntry>();
  private nextRefId = 1;

  constructor(opts: RestrictedBrowserExecutorOptions) {
    this.page = opts.page;
    this.mode = opts.mode;
    this.allowedOrigins = new Set(opts.allowedOrigins);
    this.demoStoreOrigin = opts.demoStoreOrigin;
    this.onIncident = opts.onIncident;
    this.enabledMembers = enabledMembersFor(opts.mode);

    this.page.on('framenavigated', (frame: Frame) => {
      if (frame !== this.page.mainFrame()) return;
      // Refs are stable only until navigation/material DOM change; drop them all so a
      // stale ref reliably reports the documented error instead of clicking something new.
      this.refs.clear();
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      try {
        const origin = new URL(url).origin;
        if (!this.originAllowed(origin)) {
          this.onIncident('unexpected_navigation', `Page navigated to disallowed origin ${origin}`);
        }
      } catch {
        // Non-navigable/opaque URL; nothing to check.
      }
    });
  }

  private originAllowed(origin: string): boolean {
    if (this.mode === 'demo') return this.demoStoreOrigin !== null && origin === this.demoStoreOrigin;
    return this.allowedOrigins.has(origin);
  }

  /** Per-member configs enabling only what this mode implements; every other member is explicitly disabled. */
  toolsetDefinition(): BrowserToolset20260801 {
    const configs = {} as Record<BrowserMemberName, { enabled: boolean }>;
    for (const name of ALL_MEMBERS) {
      configs[name] = { enabled: this.enabledMembers.has(name) };
    }
    return {
      type: 'browser_toolset_20260801',
      cache_control: { type: 'ephemeral' },
      configs: configs as BrowserToolsetConfigs,
    };
  }

  /**
   * Execute a batch in order; after the first `is_error`, every later call in the
   * batch gets `is_error: true` with the documented halt text (A15). Every tool_use
   * gets exactly one tool_result.
   */
  async executeBatch(toolUses: ToolUseBlock[]): Promise<ToolResultBlockParam[]> {
    const results: ToolResultBlockParam[] = [];
    let halted = false;
    for (const toolUse of toolUses) {
      if (halted) {
        results.push(this.errorResult(toolUse.id, 'Not executed: an earlier action in this turn failed.'));
        continue;
      }
      const result = await this.dispatch(toolUse);
      results.push(result);
      if (result.is_error) halted = true;
    }
    return results;
  }

  /** Dispatch one browser toolset member call. A member not enabled in this mode is rejected here too (A17). */
  async dispatch(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const name = toolUse.name as BrowserMemberName;
    if (!this.enabledMembers.has(name)) {
      const detail = `Member ${name} is not enabled in mode ${this.mode}`;
      this.onIncident('member_not_enabled', detail);
      return this.errorResult(toolUse.id, detail);
    }
    try {
      switch (name) {
        case 'navigate':
          return await this.doNavigate(toolUse);
        case 'screenshot':
          return await this.doScreenshot(toolUse);
        case 'zoom':
          return await this.doZoom(toolUse);
        case 'read_page':
          return await this.doReadPage(toolUse);
        case 'get_page_text':
          return await this.doGetPageText(toolUse);
        case 'find':
          return await this.doFind(toolUse);
        case 'scroll':
          return await this.doScroll(toolUse);
        case 'wait':
          return await this.doWait(toolUse);
        case 'left_click':
          return await this.doLeftClick(toolUse);
        case 'type':
          return await this.doType(toolUse);
        case 'form_input':
          return await this.doFormInput(toolUse);
        default:
          // Reachable only for a member that is enabled-by-config but has no executor
          // implementation. Unknown/unimplemented capabilities fail explicitly (section 8).
          return this.errorResult(toolUse.id, `Member ${name} has no executor implementation in this build`);
      }
    } catch (err) {
      const detail = `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
      this.onIncident('dispatch_error', detail);
      return this.errorResult(toolUse.id, detail);
    }
  }

  private errorResult(toolUseId: string, message: string): ToolResultBlockParam {
    return { type: 'tool_result', tool_use_id: toolUseId, toolset_name: 'browser', is_error: true, content: message };
  }

  private textResult(toolUseId: string, text: string, browserState?: BrowserStateBlockParam): ToolResultBlockParam {
    const content: NonNullable<ToolResultBlockParam['content']> = browserState ? [{ type: 'text', text }, browserState] : text;
    return { type: 'tool_result', tool_use_id: toolUseId, toolset_name: 'browser', content };
  }

  private imageResult(toolUseId: string, text: string, pngBase64: string, browserState?: BrowserStateBlockParam): ToolResultBlockParam {
    const content: NonNullable<ToolResultBlockParam['content']> = [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
    ];
    if (browserState) content.push(browserState);
    return { type: 'tool_result', tool_use_id: toolUseId, toolset_name: 'browser', content };
  }

  private async browserState(): Promise<BrowserStateBlockParam> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    const tabs: BrowserStateTabEntry[] = [{ tab_id: 'tab_1', title, url, active: true }];
    return { type: 'browser_state', tabs };
  }

  // ---------- navigate ----------
  private async doNavigate(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { url?: unknown };
    const raw = typeof input.url === 'string' ? input.url : null;
    if (!raw) return this.errorResult(toolUse.id, 'navigate requires a string url');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return this.errorResult(toolUse.id, `navigate: "${raw}" is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      this.onIncident('navigation_blocked', `Rejected non-http(s) scheme: ${raw}`);
      return this.errorResult(toolUse.id, 'Navigation rejected: only http/https destinations are permitted');
    }
    if (SUBMIT_URL_PATH_RE.test(url.pathname)) {
      this.onIncident('submission_attempt_blocked', `Blocked a navigation to a purchase-submission URL ${url.origin}${url.pathname}`);
      return this.errorResult(toolUse.id, 'Submission is controller-owned; the model may not navigate to a purchase-submission URL');
    }
    if (isLoopbackOrPrivateHost(url.hostname) && url.origin !== this.demoStoreOrigin) {
      this.onIncident('navigation_blocked', `Rejected loopback/private destination ${url.origin}`);
      return this.errorResult(toolUse.id, 'Navigation rejected: loopback/private destinations are only permitted for the demo store origin');
    }
    if (!this.originAllowed(url.origin)) {
      this.onIncident('navigation_blocked', `Rejected navigation to disallowed origin ${url.origin}`);
      return this.errorResult(toolUse.id, `Navigation rejected: ${url.origin} is not an allowed origin in mode ${this.mode}`);
    }
    await this.page.goto(url.toString());
    this.refs.clear();
    return this.textResult(toolUse.id, `Navigated to ${url.toString()}`, await this.browserState());
  }

  // ---------- screenshot / zoom ----------
  private async doScreenshot(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const buf = await this.page.screenshot({ type: 'png' });
    return this.imageResult(toolUse.id, 'Screenshot of the current page.', buf.toString('base64'), await this.browserState());
  }

  private async doZoom(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { region?: unknown };
    const region = Array.isArray(input.region) ? input.region.map(Number) : null;
    if (!region || region.length !== 4 || region.some((n) => !Number.isFinite(n))) {
      return this.errorResult(toolUse.id, 'zoom requires region:[x0,y0,x1,y1] in pixels');
    }
    const [x0, y0, x1, y1] = region as [number, number, number, number];
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const buf = await this.page.screenshot({ type: 'png', clip: { x: x0, y: y0, width, height } });
    return this.imageResult(
      toolUse.id,
      `Cropped screenshot of region [${x0},${y0},${x1},${y1}]. This is a crop of the page's native rendering, not upscaled.`,
      buf.toString('base64'),
    );
  }

  // ---------- read_page / find (no model call; local accessible-name inventory) ----------
  private readonly interactiveRoles = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'img'] as const;

  private async accessibleLabel(locator: Locator, role: string): Promise<string> {
    const ariaLabel = await locator.getAttribute('aria-label').catch(() => null);
    if (ariaLabel) return ariaLabel;
    if (role === 'img') {
      const alt = await locator.getAttribute('alt').catch(() => null);
      return alt ?? '';
    }
    const text = await locator.textContent().catch(() => null);
    if (text && text.trim()) return text.trim();
    const value = await locator.getAttribute('value').catch(() => null);
    return value ?? '';
  }

  private async buildInventory(): Promise<{ role: string; label: string; locator: Locator }[]> {
    const out: { role: string; label: string; locator: Locator }[] = [];
    for (const role of this.interactiveRoles) {
      const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0]);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        const label = await this.accessibleLabel(item, role);
        out.push({ role, label, locator: item });
      }
    }
    return out;
  }

  /** Assigns fresh ref_N ids; ids are never reused within a page lifetime so a dropped ref reliably reports stale. */
  private async refreshRefs(matches?: (role: string, label: string) => boolean): Promise<{ ref: string; role: string; label: string }[]> {
    const inventory = await this.buildInventory();
    const filtered = matches ? inventory.filter((e) => matches(e.role, e.label)) : inventory;
    const rows: { ref: string; role: string; label: string }[] = [];
    for (const entry of filtered) {
      const ref = `ref_${this.nextRefId++}`;
      this.refs.set(ref, { locator: entry.locator, label: entry.label, role: entry.role });
      rows.push({ ref, role: entry.role, label: entry.label });
    }
    return rows;
  }

  private async doReadPage(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { filter?: unknown };
    const filter = typeof input.filter === 'string' && input.filter.trim() ? input.filter.trim().toLowerCase() : null;
    const rows = await this.refreshRefs(filter ? (_role, label) => label.toLowerCase().includes(filter) : undefined);
    const lines = rows.map((r) => `${r.role} "${r.label}" [${r.ref}]`);
    return this.textResult(toolUse.id, lines.length > 0 ? lines.join('\n') : 'No interactive elements found.', await this.browserState());
  }

  private async doFind(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { query?: unknown };
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    if (!query) return this.errorResult(toolUse.id, 'find requires a string query');
    const rows = await this.refreshRefs((_role, label) => label.toLowerCase().includes(query));
    const lines = rows.map((r) => `${r.role} "${r.label}" [${r.ref}]`);
    return this.textResult(toolUse.id, lines.length > 0 ? lines.join('\n') : `No elements matched "${query}".`);
  }

  // ---------- get_page_text ----------
  private async doGetPageText(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const text = await this.page.innerText('body').catch(() => '');
    const truncated = text.length > 20000 ? `${text.slice(0, 20000)}\n...[truncated at 20000 characters]` : text;
    return this.textResult(toolUse.id, truncated || '(page has no visible text)');
  }

  // ---------- scroll ----------
  private async resolveScrollPoint(target: unknown): Promise<{ x: number; y: number }> {
    const t = target as { type?: string; ref?: string; x?: number; y?: number } | undefined;
    if (t?.type === 'ref' && t.ref) {
      const entry = this.refs.get(t.ref);
      const box = entry ? await entry.locator.boundingBox().catch(() => null) : null;
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (t?.type === 'coordinate' && typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y };
    const viewport = this.page.viewportSize();
    return { x: (viewport?.width ?? 800) / 2, y: (viewport?.height ?? 600) / 2 };
  }

  private async doScroll(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { target?: unknown; scroll_direction?: unknown; scroll_amount?: unknown };
    const direction = typeof input.scroll_direction === 'string' ? input.scroll_direction : 'down';
    const amount = typeof input.scroll_amount === 'number' && Number.isFinite(input.scroll_amount) ? input.scroll_amount : 400;
    const { x, y } = await this.resolveScrollPoint(input.target);
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    await this.page.mouse.move(x, y);
    await this.page.mouse.wheel(dx, dy);
    return this.textResult(toolUse.id, `Scrolled ${direction} by ${amount}.`);
  }

  // ---------- wait ----------
  private async doWait(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { duration?: unknown };
    const requested = typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : 1;
    const seconds = Math.max(0, Math.min(10, requested));
    await this.page.waitForTimeout(seconds * 1000);
    return this.textResult(toolUse.id, requested > 10 ? `Waited ${seconds}s (capped from requested ${requested}s; wait is bounded to 10s).` : `Waited ${seconds}s.`);
  }

  // ---------- submission guard (A18, A26) ----------
  /** Returns null when the click/form_input may proceed; otherwise an error-result builder to apply. */
  private async checkSubmissionGuard(entry: RefEntry): Promise<((toolUseId: string) => ToolResultBlockParam) | null> {
    const looksLikeSubmit = SUBMIT_TEXT_RE.test(entry.label);
    let formActionMatches = false;
    if (!looksLikeSubmit) {
      const formAction = await entry.locator
        .evaluate((el) => (el as HTMLElement).closest('form')?.getAttribute('action') ?? null)
        .catch(() => null);
      if (formAction && SUBMIT_FORM_ACTION_RE.test(formAction)) formActionMatches = true;
    }
    if (!looksLikeSubmit && !formActionMatches) return null;

    const rejection = (id: string): ToolResultBlockParam => this.errorResult(id, 'Submission is controller-owned; the model may not click purchase controls');

    if (this.mode === 'demo') {
      let currentOrigin: string | null = null;
      try {
        currentOrigin = new URL(this.page.url()).origin;
      } catch {
        currentOrigin = null;
      }
      if (currentOrigin !== null && currentOrigin === this.demoStoreOrigin) {
        // Expected path: the model may surface a checkout-ready state, but only the
        // controller submits, via DemoStoreExecutor.submitDemoOrder, after persisting
        // SUBMISSION_STARTED durably. This is not itself an anomaly, so no incident.
        return rejection;
      }
    }
    this.onIncident('submission_attempt_blocked', `Blocked an action on "${entry.label}" that resembles a purchase-submission control`);
    return rejection;
  }

  // ---------- left_click / form_input ----------
  private async doLeftClick(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { target?: { type?: string; ref?: string } };
    const target = input.target;
    if (!target || target.type !== 'ref' || !target.ref) {
      this.onIncident('coordinate_click_blocked', 'Rejected a non-ref (coordinate) left_click target');
      return this.errorResult(toolUse.id, 'Coordinate clicks are disabled; use a ref from read_page/find');
    }
    const entry = this.refs.get(target.ref);
    if (!entry) return this.errorResult(toolUse.id, `Error: ${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);

    const guard = await this.checkSubmissionGuard(entry);
    if (guard) return guard(toolUse.id);

    await entry.locator.click();
    return this.textResult(toolUse.id, `Clicked ${entry.label || target.ref}.`, await this.browserState());
  }

  private async doFormInput(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { target?: { type?: string; ref?: string }; value?: unknown };
    const target = input.target;
    if (!target || target.type !== 'ref' || !target.ref) {
      this.onIncident('coordinate_click_blocked', 'Rejected a non-ref (coordinate) form_input target');
      return this.errorResult(toolUse.id, 'Coordinate clicks are disabled; use a ref from read_page/find');
    }
    const entry = this.refs.get(target.ref);
    if (!entry) return this.errorResult(toolUse.id, `Error: ${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);

    const guard = await this.checkSubmissionGuard(entry);
    if (guard) return guard(toolUse.id);

    const value = typeof input.value === 'string' ? input.value : '';
    await entry.locator.fill(value);
    return this.textResult(toolUse.id, `Set ${entry.label || target.ref} to the provided value.`, await this.browserState());
  }

  // ---------- type (keyboard input into the currently focused element) ----------
  private async doType(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const input = toolUse.input as { text?: unknown };
    const text = typeof input.text === 'string' ? input.text : null;
    if (text === null) return this.errorResult(toolUse.id, 'type requires a string text');
    // A newline inside `type` is an Enter keystroke (Playwright maps "\n" to Enter),
    // which submits a form exactly like a click on a submit control -- the same reason
    // `key` is disabled in every mode. Reject it rather than stripping it silently.
    if (/[\r\n]/.test(text)) {
      this.onIncident('submission_attempt_blocked', 'Blocked a type containing Enter/newline, which can submit a form');
      return this.errorResult(toolUse.id, 'type rejected: Enter/newline is not permitted; keyboard submission is disabled in every mode');
    }
    await this.page.keyboard.type(text);
    return this.textResult(toolUse.id, `Typed ${text.length} character(s).`);
  }
}
