/**
 * GeminiComputerUse: a supervised, observe-only path that lets `gemini-3.8-flash` drive a
 * real Playwright page through the `@google/genai` Interactions API `computer_use` tool, to
 * produce a structured observation report of a retailer product page. This is a feasibility
 * tool exercised from `scripts/lazada-gemini-observe.ts` and `tests/live/*`; it is never
 * wired into `src/worker/worker.ts` or any mission's runtime path.
 *
 * Why stateless (`store: false` + full history): the Interactions API's "stateless function
 * calling" mode requires the caller to resend, on every turn, the initial `user_input` step,
 * every model-generated step from the previous response verbatim, and the caller's own
 * `function_result` steps for that turn's function calls. This module never sends
 * `previous_interaction_id` -- exactly the same rule `geminiClient.ts` follows for why it
 * never continues a prior task's history.
 *
 * Why observe-only mirrors `lazada_observe` (`src/agent/browserExecutor.ts`): the served tool
 * surface is restricted to `OBSERVE_ONLY_FUNCTIONS` via `excluded_predefined_functions`, AND
 * every function_call the model emits is re-checked in code before execution (A17 parity) --
 * a model is never trusted to respect its own served schema. A disallowed action is rejected
 * without executing it; a `safety_decision: { decision: 'require_confirmation' }` halts the
 * run outright, because there is no human in this loop to grant that confirmation.
 *
 * Prompt injection detection is NOT enabled by default: a live probe (2026-09-19) showed
 * `enable_prompt_injection_detection: true` in the `computer_use` tool makes the Interactions
 * backend reject the very next turn with HTTP 400 ("Computer Use Model requires function
 * response to contain an image of mime_type image/png in the data.inline_data field.") on
 * `gemini-3.8-flash`, even though the function_result carries the documented
 * `[{type:'text',...},{type:'image',...,mime_type:'image/png'}]` shape. The identical payload
 * succeeds with the flag omitted. See `RunGeminiComputerUseObservationOptions.promptInjectionDetection`
 * and the comment at the tool object for the mitigation this path relies on instead.
 */
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { Clock } from '../domain/time.ts';
import { SystemClock } from '../domain/time.ts';
import type { TaskUsage } from './client.ts';
import { estimateGeminiCostUsd } from './geminiClient.ts';
import { describeError, zeroUsage } from './replay.ts';

/** Narrow, structural subset of `playwright.Page` this module needs; lets tests pass a fake with no cast. */
export interface ComputerUsePage {
  viewportSize(): { width: number; height: number } | null;
  screenshot(options?: { type?: 'png' }): Promise<Buffer>;
  url(): string;
  waitForLoadState(state?: 'load', options?: { timeout?: number }): Promise<void>;
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
}

/** Every predefined function of the browser `computer_use` environment (verified against the docs fetched 2026-09-19). */
const ALL_PREDEFINED_FUNCTIONS = [
  'click',
  'double_click',
  'triple_click',
  'middle_click',
  'right_click',
  'mouse_down',
  'mouse_up',
  'move',
  'type',
  'drag_and_drop',
  'wait',
  'press_key',
  'key_down',
  'key_up',
  'hotkey',
  'take_screenshot',
  'scroll',
  'go_back',
  'navigate',
  'go_forward',
  'open_web_browser',
] as const;

/** The only functions this observe-only session ever executes. */
export const OBSERVE_ONLY_FUNCTIONS = ['scroll', 'move', 'wait', 'take_screenshot'] as const;

/** Served to the model as `excluded_predefined_functions`: everything not in `OBSERVE_ONLY_FUNCTIONS`. */
export const EXCLUDED_PREDEFINED_FUNCTIONS: string[] = ALL_PREDEFINED_FUNCTIONS.filter(
  (name): name is Exclude<(typeof ALL_PREDEFINED_FUNCTIONS)[number], (typeof OBSERVE_ONLY_FUNCTIONS)[number]> =>
    !(OBSERVE_ONLY_FUNCTIONS as readonly string[]).includes(name),
);

/** A disallowed call that could itself submit/navigate/type is reported as a submission attempt, not a plain "not enabled". */
const SUBMISSION_FAMILY_RE = /click|type|key|hotkey|navigate|go_back|go_forward|drag|open_web_browser/i;

export const LazadaLiveObservationReportSchema = z.object({
  productTitle: z.string().nullable(),
  sellerName: z.string().nullable(),
  sellerBadges: z.array(z.string()),
  priceText: z.string().nullable(),
  availability: z.enum(['in_stock', 'out_of_stock', 'unknown']),
  addToCartVisible: z.boolean().nullable(),
  buyNowVisible: z.boolean().nullable(),
  purchaseLimitText: z.string().nullable(),
  packagingNotice: z.string().nullable(),
  packagingCondition: z.enum(['stated_removed', 'not_stated', 'unclear']),
  uncertainties: z.array(z.string()),
});

export type LazadaLiveObservationReport = z.infer<typeof LazadaLiveObservationReportSchema>;

export type ComputerUseIncidentKind = 'action_not_enabled' | 'submission_attempt_blocked' | 'safety_confirmation_required' | 'unexpected_navigation' | 'dispatch_error';

export interface ComputerUseIncident {
  kind: ComputerUseIncidentKind;
  detail: string;
}

export interface ComputerUseAction {
  turn: number;
  name: string;
  intent: string | null;
  executed: boolean;
}

export type ComputerUseFailureReason = 'api_error' | 'truncated' | 'invalid_output' | 'blocked' | 'limit_exceeded';

export type ComputerUseResult =
  | {
      ok: true;
      report: LazadaLiveObservationReport;
      turns: number;
      actions: ComputerUseAction[];
      incidents: ComputerUseIncident[];
      usage: TaskUsage;
      finalUrl: string;
      finalText: string;
    }
  | {
      ok: false;
      reason: ComputerUseFailureReason;
      detail: string;
      turns: number;
      actions: ComputerUseAction[];
      incidents: ComputerUseIncident[];
      usage: TaskUsage;
      finalUrl: string;
    };

export interface RunGeminiComputerUseObservationOptions {
  apiKey: string;
  model: string;
  thinkingLevel: 'low' | 'medium' | 'high';
  page: ComputerUsePage;
  goal: string;
  /** Hostnames the session may end each turn on; exact or suffix (`.host`) match. Off-host halts the run. */
  allowedHosts: string[];
  maxTurns?: number;
  maxSeconds?: number;
  /**
   * Default false: a verified live 400 (2026-09-19, see module header) means the
   * `computer_use` tool's `enable_prompt_injection_detection` flag cannot be turned on for
   * `gemini-3.8-flash` without breaking the very next turn. The mitigation for this
   * observe-only path is the restricted `OBSERVE_ONLY_FUNCTIONS` tool surface plus the A17
   * code-level re-check of every function_call, not this flag. Only set true once the
   * provider fixes the underlying bug and that has been re-verified live.
   */
  promptInjectionDetection?: boolean;
  clock?: Clock;
  /** Injectable for tests; defaults to `new GoogleGenAI({ apiKey }).interactions`. */
  interactions?: { create: (params: unknown) => Promise<unknown> };
  onIncident?: (kind: ComputerUseIncidentKind, detail: string) => void;
  onTurn?: (info: { turn: number; actions: string[]; url: string }) => void;
  screenshotSink?: (turn: number, png: Buffer) => void;
}

const SYSTEM_PROMPT = `You are running a supervised, OBSERVE-ONLY session on a live retailer product page. You are not shopping, not logging in, and not completing any transaction.

You may only take these actions: scroll, move, wait, take_screenshot. You must NEVER attempt to click anything, type anything, log in, add an item to a cart, buy anything, or navigate to a different page. If you are tempted to interact with a control, do not -- just describe what you see instead.

Report only what is visibly present on the page right now. Use null (not a guess) for any field you cannot actually see. If the product packaging or artwork prints a notice about the outer plastic wrap or packaging being removed for the product, quote or closely paraphrase it in packagingNotice and set packagingCondition to "stated_removed"; if no such notice is visible, use "not_stated"; if it is present but ambiguous, use "unclear".

When you are done observing (scroll as needed to see the seller info, price, purchase controls, and any packaging notice), finish your final turn with exactly one JSON object and nothing else in that turn's text, matching this shape exactly:
{
  "productTitle": string | null,
  "sellerName": string | null,
  "sellerBadges": string[],
  "priceText": string | null,
  "availability": "in_stock" | "out_of_stock" | "unknown",
  "addToCartVisible": boolean | null,
  "buyNowVisible": boolean | null,
  "purchaseLimitText": string | null,
  "packagingNotice": string | null,
  "packagingCondition": "stated_removed" | "not_stated" | "unclear",
  "uncertainties": string[]
}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function denormalize(coord: number, size: number): number {
  return Math.floor((coord / 1000) * size);
}

function scrollDelta(direction: string, magnitude: number): { dx: number; dy: number } {
  if (direction === 'up') return { dx: 0, dy: -magnitude };
  if (direction === 'left') return { dx: -magnitude, dy: 0 };
  if (direction === 'right') return { dx: magnitude, dy: 0 };
  return { dx: 0, dy: magnitude }; // 'down' and any unrecognized direction
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((h) => {
    const allowed = h.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/**
 * Up to 2 retries on 429/5xx and any connection-level throw, mirroring geminiClient.ts's
 * `isRetryableGeminiError`. The SDK throws error subclasses (e.g. `BadRequestError`) that are
 * NOT `instanceof` the exported `ApiError`, so this ducks-types a numeric `status` off the
 * thrown value instead of relying on `instanceof`: when a numeric status is present, only
 * 429/5xx are retryable; when absent, the throw is treated as connection-level and retried.
 */
function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true;
}

function defaultInteractions(apiKey: string): { create: (params: unknown) => Promise<unknown> } {
  const client = new GoogleGenAI({ apiKey });
  return client.interactions as unknown as { create: (params: unknown) => Promise<unknown> };
}

interface CUContentBlock {
  type: string;
  text?: string;
}

interface CUStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: CUContentBlock[];
  error?: { message?: string; code?: number };
  [k: string]: unknown;
}

interface CUUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
}

interface CUInteractionResponse {
  status: string;
  model?: string;
  steps?: CUStep[];
  output_text?: string;
  usage?: CUUsage;
}

function extractFinalText(response: CUInteractionResponse): string {
  if (response.output_text) return response.output_text;
  const steps = response.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.type === 'model_output' && step.content) {
      return step.content
        .filter((c): c is CUContentBlock & { text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    }
  }
  return '';
}

/** Strips ```json fences and takes the first `{`..last `}` span; never combined with `response_format` on this tool (untested per the API docs). */
function parseLenientJsonObject(text: string): unknown {
  let t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) t = fenced[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('final text contains no JSON object');
  }
  return JSON.parse(t.slice(first, last + 1));
}

async function executeObserveAction(page: ComputerUsePage, viewport: { width: number; height: number }, name: string, args: Record<string, unknown>): Promise<void> {
  switch (name) {
    case 'scroll': {
      const x = typeof args.x === 'number' ? denormalize(args.x, viewport.width) : viewport.width / 2;
      const y = typeof args.y === 'number' ? denormalize(args.y, viewport.height) : viewport.height / 2;
      const direction = typeof args.direction === 'string' ? args.direction : 'down';
      const magnitude = typeof args.magnitude_in_pixels === 'number' && Number.isFinite(args.magnitude_in_pixels) ? args.magnitude_in_pixels : 300;
      const { dx, dy } = scrollDelta(direction, magnitude);
      await page.mouse.move(x, y);
      await page.mouse.wheel(dx, dy);
      return;
    }
    case 'move': {
      const x = typeof args.x === 'number' ? denormalize(args.x, viewport.width) : viewport.width / 2;
      const y = typeof args.y === 'number' ? denormalize(args.y, viewport.height) : viewport.height / 2;
      await page.mouse.move(x, y);
      return;
    }
    case 'wait': {
      const requested = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? args.seconds : 1;
      await sleep(Math.max(0, Math.min(5, requested)) * 1000);
      return;
    }
    case 'take_screenshot':
      return; // no-op: this turn's screenshot is captured once, after the whole batch
    default:
      return;
  }
}

export async function runGeminiComputerUseObservation(opts: RunGeminiComputerUseObservationOptions): Promise<ComputerUseResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const maxSeconds = opts.maxSeconds ?? 180;
  const clock = opts.clock ?? new SystemClock();
  const interactions = opts.interactions ?? defaultInteractions(opts.apiKey);
  const viewport = opts.page.viewportSize() ?? { width: 1280, height: 900 };

  const usage = zeroUsage();
  const incidents: ComputerUseIncident[] = [];
  const actions: ComputerUseAction[] = [];
  const startMono = clock.monotonicMs();

  const elapsedSeconds = (): number => (clock.monotonicMs() - startMono) / 1000;
  const finalizeUsage = (): TaskUsage => {
    usage.elapsedMs = clock.monotonicMs() - startMono;
    usage.estimatedCostUsd = estimateGeminiCostUsd(opts.model, usage.inputTokens, usage.outputTokens);
    return usage;
  };
  const recordIncident = (kind: ComputerUseIncidentKind, detail: string): void => {
    incidents.push({ kind, detail });
    opts.onIncident?.(kind, detail);
  };
  const failure = (turns: number, reason: ComputerUseFailureReason, detail: string): ComputerUseResult => ({
    ok: false,
    reason,
    detail,
    turns,
    actions,
    incidents,
    usage: finalizeUsage(),
    finalUrl: opts.page.url(),
  });

  const initialPng = await opts.page.screenshot({ type: 'png' });
  opts.screenshotSink?.(0, initialPng);

  const history: Record<string, unknown>[] = [
    {
      type: 'user_input',
      content: [
        { type: 'text', text: opts.goal },
        { type: 'image', data: initialPng.toString('base64'), mime_type: 'image/png' },
      ],
    },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (elapsedSeconds() > maxSeconds) {
      return failure(turn - 1, 'limit_exceeded', `Elapsed ${elapsedSeconds().toFixed(1)}s exceeds maxSeconds=${maxSeconds}`);
    }

    const params: Record<string, unknown> = {
      model: opts.model,
      store: false,
      input: history,
      system_instruction: SYSTEM_PROMPT,
      generation_config: { thinking_level: opts.thinkingLevel, max_output_tokens: 8000 },
      tools: [
        {
          type: 'computer_use',
          environment: 'browser',
          // `enable_prompt_injection_detection` is verified (2026-09-19, live) to make the
          // Interactions backend reject the very next turn with HTTP 400 on gemini-3.8-flash,
          // even given a correctly-shaped image function_result -- see the module header. Only
          // include the key when explicitly opted into; omitting it entirely (not `false`) is
          // what avoids the 400. The mitigation for this observe-only path is the restricted
          // OBSERVE_ONLY_FUNCTIONS tool surface plus the A17 code-level re-check of every
          // function_call, not this flag.
          ...(opts.promptInjectionDetection ? { enable_prompt_injection_detection: true } : {}),
          excluded_predefined_functions: EXCLUDED_PREDEFINED_FUNCTIONS,
        },
      ],
    };

    let response: CUInteractionResponse;
    let retries = 0;
    for (;;) {
      try {
        response = (await interactions.create(params)) as CUInteractionResponse;
        break;
      } catch (err) {
        if (isRetryableError(err) && retries < 2) {
          retries += 1;
          continue;
        }
        return failure(turn - 1, 'api_error', describeError(err));
      }
    }

    const u = response.usage;
    if (u) {
      usage.inputTokens += u.total_input_tokens ?? 0;
      usage.outputTokens += (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
      usage.cacheReadInputTokens += u.total_cached_tokens ?? 0;
    }

    const steps = response.steps ?? [];
    for (const step of steps) history.push(step);

    const modelOutputError = [...steps].reverse().find((s): s is CUStep & { error: NonNullable<CUStep['error']> } => s.type === 'model_output' && !!s.error);
    if (modelOutputError) {
      return failure(turn, 'api_error', `model_output step reported an error: ${modelOutputError.error.message ?? JSON.stringify(modelOutputError.error)}`);
    }
    if (response.status === 'failed' || response.status === 'cancelled') {
      return failure(turn, 'api_error', `Interaction ended with status "${response.status}"`);
    }
    if (response.status === 'incomplete' || response.status === 'budget_exceeded') {
      return failure(turn, 'truncated', `Interaction ended with status "${response.status}" before completion; truncated output is never parsed as a result`);
    }
    // A turn that emits function_call steps comes back as `requires_action` (verified live
    // 2026-09-19); only the final, tool-free turn is `completed`. Anything else is an error.
    if (response.status !== 'completed' && response.status !== 'requires_action') {
      return failure(turn, 'api_error', `Unexpected interaction status "${response.status}"`);
    }

    if (!hostAllowed(new URL(opts.page.url()).hostname, opts.allowedHosts)) {
      recordIncident('unexpected_navigation', `Page is at disallowed host ${new URL(opts.page.url()).hostname}`);
      return failure(turn, 'blocked', 'Observation halted: the page navigated off an allowed host');
    }

    const functionCalls = steps.filter((s): s is CUStep & { id: string; name: string; arguments: Record<string, unknown> } => s.type === 'function_call' && typeof s.id === 'string' && typeof s.name === 'string');

    if (functionCalls.length === 0) {
      if (response.status === 'requires_action') {
        return failure(turn, 'api_error', 'Interaction status is "requires_action" but no function_call step was returned');
      }
      const finalText = extractFinalText(response);
      let parsed: unknown;
      try {
        parsed = parseLenientJsonObject(finalText);
      } catch (err) {
        return failure(turn, 'invalid_output', `Final text was not parseable as JSON: ${describeError(err)}`);
      }
      const validated = LazadaLiveObservationReportSchema.safeParse(parsed);
      if (!validated.success) {
        return failure(turn, 'invalid_output', `Final JSON failed schema validation: ${validated.error.message}`);
      }
      return {
        ok: true,
        report: validated.data,
        turns: turn,
        actions,
        incidents,
        usage: finalizeUsage(),
        finalUrl: opts.page.url(),
        finalText,
      };
    }

    usage.toolCalls += functionCalls.length;

    const results: { call_id: string; name: string; error: string | null }[] = [];
    let anyExecuted = false;
    const turnActionNames: string[] = [];

    for (const fc of functionCalls) {
      const args = fc.arguments;
      const safety = args.safety_decision as { decision?: string; explanation?: string } | undefined;
      if (safety?.decision === 'require_confirmation') {
        recordIncident('safety_confirmation_required', `Function "${fc.name}" required confirmation: ${safety.explanation ?? '(no explanation provided)'}`);
        return failure(turn, 'blocked', `Model requested a safety confirmation for "${fc.name}"; this observe-only session has no human in the loop to grant it`);
      }

      turnActionNames.push(fc.name);
      const intent = typeof args.intent === 'string' ? args.intent : null;

      if (!(OBSERVE_ONLY_FUNCTIONS as readonly string[]).includes(fc.name)) {
        const kind: ComputerUseIncidentKind = SUBMISSION_FAMILY_RE.test(fc.name) ? 'submission_attempt_blocked' : 'action_not_enabled';
        const detail = `Function "${fc.name}" is not enabled in observe-only mode`;
        recordIncident(kind, detail);
        actions.push({ turn, name: fc.name, intent, executed: false });
        results.push({ call_id: fc.id, name: fc.name, error: `action ${fc.name} is not enabled in observe-only mode` });
        continue;
      }

      try {
        await executeObserveAction(opts.page, viewport, fc.name, args);
        anyExecuted = true;
      } catch (err) {
        recordIncident('dispatch_error', `${fc.name} failed: ${describeError(err)}`);
        actions.push({ turn, name: fc.name, intent, executed: false });
        results.push({ call_id: fc.id, name: fc.name, error: `action ${fc.name} failed: ${describeError(err)}` });
        continue;
      }
      actions.push({ turn, name: fc.name, intent, executed: true });
      results.push({ call_id: fc.id, name: fc.name, error: null });
    }

    if (anyExecuted) {
      await opts.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await sleep(300); // small settle wait so the screenshot reflects the post-action state
    }
    const turnPng = await opts.page.screenshot({ type: 'png' });
    opts.screenshotSink?.(turn, turnPng);

    if (!hostAllowed(new URL(opts.page.url()).hostname, opts.allowedHosts)) {
      recordIncident('unexpected_navigation', `Page is at disallowed host ${new URL(opts.page.url()).hostname}`);
      return failure(turn, 'blocked', 'Observation halted: the page navigated off an allowed host');
    }

    opts.onTurn?.({ turn, actions: turnActionNames, url: opts.page.url() });

    const url = opts.page.url();
    for (const r of results) {
      history.push({
        type: 'function_result',
        name: r.name,
        call_id: r.call_id,
        result: [
          { type: 'text', text: JSON.stringify(r.error ? { url, error: r.error } : { url, ok: true }) },
          { type: 'image', data: turnPng.toString('base64'), mime_type: 'image/png' },
        ],
      });
    }

    if (elapsedSeconds() > maxSeconds) {
      return failure(turn, 'limit_exceeded', `Elapsed ${elapsedSeconds().toFixed(1)}s exceeds maxSeconds=${maxSeconds}`);
    }
  }

  return failure(maxTurns, 'limit_exceeded', `Observation did not finish within maxTurns=${maxTurns}`);
}
