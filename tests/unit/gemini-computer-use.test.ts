/**
 * Deterministic tests for src/agent/geminiComputerUse.ts. Every case injects a fake
 * `interactions: { create }` and a fake `ComputerUsePage`; no `GoogleGenAI` is constructed, no
 * browser is launched, and no network call is made. The fake `create` snapshots its params at
 * call time because the module passes its live `history` array as `input` on every call.
 */
import { ApiError } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXCLUDED_PREDEFINED_FUNCTIONS,
  OBSERVE_ONLY_FUNCTIONS,
  runGeminiComputerUseObservation,
  type ComputerUsePage,
  type LazadaLiveObservationReport,
  type RunGeminiComputerUseObservationOptions,
} from '../../src/agent/geminiComputerUse.ts';
import type { Clock } from '../../src/domain/time.ts';

const MODEL = 'gemini-3.8-flash';
const LAZADA_URL = 'https://www.lazada.sg/products/pokemon-etb-i123.html';
const GOAL = 'Observe the product page and report what is visible.';

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

interface FakePage extends ComputerUsePage {
  moves: [number, number][];
  wheels: [number, number][];
  screenshots: Buffer[];
  loadWaits: number;
  currentUrl: string;
  hooks: { onMove?: () => void; onWheel?: () => void };
}

function fakePage(over: { url?: string; viewport?: { width: number; height: number } | null } = {}): FakePage {
  const page: FakePage = {
    moves: [],
    wheels: [],
    screenshots: [],
    loadWaits: 0,
    currentUrl: over.url ?? LAZADA_URL,
    hooks: {},
    viewportSize: () => (over.viewport === undefined ? { width: 1280, height: 900 } : over.viewport),
    screenshot: async () => {
      // PNG signature plus a per-shot counter byte so each screenshot's base64 is distinct.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, page.screenshots.length]);
      page.screenshots.push(png);
      return png;
    },
    url: () => page.currentUrl,
    waitForLoadState: async () => {
      page.loadWaits += 1;
    },
    mouse: {
      move: async (x, y) => {
        page.moves.push([x, y]);
        page.hooks.onMove?.();
      },
      wheel: async (dx, dy) => {
        page.wheels.push([dx, dy]);
        page.hooks.onWheel?.();
      },
    },
  };
  return page;
}

interface FakeInteractions {
  create: (params: unknown) => Promise<unknown>;
  /** Live params objects (the `input` array is shared across calls and mutated by the module). */
  calls: Record<string, unknown>[];
  /** Deep copies taken at call time: the exact wire shape of each request. */
  snapshots: Record<string, unknown>[];
}

/** Replays the supplied responses/throws in order; the last entry repeats for any further call. */
function fakeCreate(...responses: (unknown | Error)[]): FakeInteractions {
  const calls: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  return {
    calls,
    snapshots,
    create: (params: unknown): Promise<unknown> => {
      const p = params as Record<string, unknown>;
      calls.push(p);
      snapshots.push(structuredClone(p));
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
}

function fixedClock(): Clock & { mono: number } {
  const clock = {
    mono: 0,
    now: () => new Date('2026-09-19T05:00:00.000Z'),
    monotonicMs: () => clock.mono,
  };
  return clock;
}

// ---------------------------------------------------------------------------------------------
// Response builders (Interactions API shapes)
// ---------------------------------------------------------------------------------------------

type Step = Record<string, unknown>;

function thought(): Step {
  return { type: 'thought', signature: 'x' };
}

function fc(name: string, args: Record<string, unknown>, id = 'call_1'): Step {
  return { type: 'function_call', id, name, arguments: args };
}

function scrollCall(id = 'call_1', over: Record<string, unknown> = {}): Step {
  return fc('scroll', { x: 500, y: 500, direction: 'down', magnitude_in_pixels: 400, intent: 'see more', ...over }, id);
}

const USAGE = { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 20, total_cached_tokens: 10 };

function toolTurn(calls: Step[], usage: Record<string, number> = USAGE): { status: string; steps: Step[]; usage: Record<string, number> } {
  // A turn that emits function calls arrives as `requires_action` (verified live 2026-09-19).
  return { status: 'requires_action', steps: [thought(), ...calls], usage };
}

function finalTurn(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    output_text: text,
    usage: USAGE,
    ...over,
  };
}

const VALID_REPORT: LazadaLiveObservationReport = {
  productTitle: 'Pokemon TCG Scarlet & Violet Elite Trainer Box',
  sellerName: 'Pokemon Official Store SG',
  sellerBadges: ['LazMall'],
  priceText: 'S$79.90',
  availability: 'in_stock',
  addToCartVisible: true,
  buyNowVisible: true,
  purchaseLimitText: 'Limit 1 per customer',
  packagingNotice: null,
  packagingCondition: 'not_stated',
  uncertainties: [],
};

function fenced(report: unknown): string {
  return '```json\n' + JSON.stringify(report, null, 2) + '\n```';
}

function finalReport(): Record<string, unknown> {
  return finalTurn(fenced(VALID_REPORT));
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

type Opts = RunGeminiComputerUseObservationOptions;

function run(over: Partial<Opts> & { interactions: Opts['interactions']; page: ComputerUsePage }) {
  return runGeminiComputerUseObservation({
    apiKey: 'test-key-not-a-real-credential',
    model: MODEL,
    thinkingLevel: 'low',
    goal: GOAL,
    allowedHosts: ['lazada.sg'],
    maxTurns: 8,
    maxSeconds: 180,
    clock: fixedClock(),
    ...over,
  });
}

function stepsOf(snapshot: Record<string, unknown>): Step[] {
  return snapshot.input as Step[];
}

function resultText(step: Step): Record<string, unknown> {
  const result = step.result as { type: string; text?: string }[];
  return JSON.parse(result[0]!.text!) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// 1. Request shape
// ---------------------------------------------------------------------------------------------

describe('request shape', () => {
  it('sends store:false, no previous_interaction_id, the observe-only computer_use tool, thinking level and model on every call', async () => {
    const create = fakeCreate(toolTurn([scrollCall()]), finalReport());
    const result = await run({ interactions: create, page: fakePage(), thinkingLevel: 'medium' });
    expect(result.ok).toBe(true);
    expect(create.snapshots).toHaveLength(2);

    for (const params of create.snapshots) {
      expect(Object.keys(params).sort()).toEqual(['generation_config', 'input', 'model', 'store', 'system_instruction', 'tools']);
      expect(params.model).toBe(MODEL);
      expect(params.store).toBe(false);
      expect(params).not.toHaveProperty('previous_interaction_id');
      expect(params).not.toHaveProperty('response_format');
      expect(params.generation_config).toEqual({ thinking_level: 'medium', max_output_tokens: 8000 });
      expect(typeof params.system_instruction).toBe('string');
      expect((params.system_instruction as string).length).toBeGreaterThan(0);
      expect(params.system_instruction).toMatch(/OBSERVE-ONLY/);
      const tools = params.tools as unknown[];
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        type: 'computer_use',
        environment: 'browser',
        excluded_predefined_functions: EXCLUDED_PREDEFINED_FUNCTIONS,
      });
    }
  });

  it('adds enable_prompt_injection_detection:true only when promptInjectionDetection is explicitly opted in', async () => {
    const create = fakeCreate(finalReport());
    const result = await run({ interactions: create, page: fakePage(), promptInjectionDetection: true });
    expect(result.ok).toBe(true);
    const params = create.snapshots[0]!;
    const tools = params.tools as unknown[];
    expect(tools[0]).toEqual({
      type: 'computer_use',
      environment: 'browser',
      enable_prompt_injection_detection: true,
      excluded_predefined_functions: EXCLUDED_PREDEFINED_FUNCTIONS,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Stateless history
// ---------------------------------------------------------------------------------------------

describe('stateless history', () => {
  it('resends the initial user_input, every prior model step verbatim, and one function_result per call; history only grows', async () => {
    const turn1 = toolTurn([scrollCall('call_1')]);
    const turn2 = toolTurn([fc('move', { x: 100, y: 200, intent: 'hover' }, 'call_2')]);
    const create = fakeCreate(turn1, turn2, finalReport());
    const page = fakePage();
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(true);
    expect(create.snapshots).toHaveLength(3);

    const initialPng = page.screenshots[0]!;
    const userInput = {
      type: 'user_input',
      content: [
        { type: 'text', text: GOAL },
        { type: 'image', data: initialPng.toString('base64'), mime_type: 'image/png' },
      ],
    };

    // Turn 1: only the initial user_input.
    expect(stepsOf(create.snapshots[0]!)).toEqual([userInput]);

    // Turn 2: user_input, then turn-1 model steps verbatim (thought included), then the function_result.
    const in2 = stepsOf(create.snapshots[1]!);
    expect(in2).toHaveLength(4);
    expect(in2[0]).toEqual(userInput);
    expect(in2[1]).toEqual(turn1.steps![0]);
    expect(in2[2]).toEqual(turn1.steps![1]);
    expect(in2[3]).toEqual({
      type: 'function_result',
      name: 'scroll',
      call_id: 'call_1',
      result: [
        { type: 'text', text: JSON.stringify({ url: LAZADA_URL, ok: true }) },
        { type: 'image', data: page.screenshots[1]!.toString('base64'), mime_type: 'image/png' },
      ],
    });

    // The live history holds the response's own step objects (same identity), not copies.
    const live = create.calls[1]!.input as Step[];
    expect(live[1]).toBe(turn1.steps![0]);
    expect(live[2]).toBe(turn1.steps![1]);

    // Turn 3: everything from turns 1-2, in order, nothing reset.
    const in3 = stepsOf(create.snapshots[2]!);
    expect(in3).toHaveLength(7);
    expect(in3.slice(0, 4)).toEqual(in2);
    expect(in3[4]).toEqual(turn2.steps![0]);
    expect(in3[5]).toEqual(turn2.steps![1]);
    expect(in3[6]).toMatchObject({ type: 'function_result', name: 'move', call_id: 'call_2' });
    expect(resultText(in3[6]!)).toEqual({ url: LAZADA_URL, ok: true });
    expect((in3[6]!.result as { data?: string }[])[1]!.data).toBe(page.screenshots[2]!.toString('base64'));
  });

  it('emits one function_result per function_call in a multi-call turn, each with its own call_id', async () => {
    const create = fakeCreate(toolTurn([scrollCall('call_a'), scrollCall('call_b', { direction: 'up' })]), finalReport());
    await run({ interactions: create, page: fakePage() });
    const in2 = stepsOf(create.snapshots[1]!);
    const results = in2.filter((s) => s.type === 'function_result');
    expect(results.map((r) => r.call_id)).toEqual(['call_a', 'call_b']);
    expect(results.map((r) => r.name)).toEqual(['scroll', 'scroll']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Exclusion list
// ---------------------------------------------------------------------------------------------

describe('EXCLUDED_PREDEFINED_FUNCTIONS', () => {
  it('excludes every click/type/key/navigate family function', () => {
    const family = [
      'click', 'double_click', 'triple_click', 'middle_click', 'right_click', 'mouse_down', 'mouse_up', 'drag_and_drop',
      'type', 'press_key', 'key_down', 'key_up', 'hotkey', 'go_back', 'navigate', 'go_forward', 'open_web_browser',
    ];
    for (const name of family) expect(EXCLUDED_PREDEFINED_FUNCTIONS).toContain(name);
    expect(EXCLUDED_PREDEFINED_FUNCTIONS).toHaveLength(family.length);
  });

  it('excludes none of OBSERVE_ONLY_FUNCTIONS', () => {
    expect(OBSERVE_ONLY_FUNCTIONS).toEqual(['scroll', 'move', 'wait', 'take_screenshot']);
    for (const name of OBSERVE_ONLY_FUNCTIONS) expect(EXCLUDED_PREDEFINED_FUNCTIONS).not.toContain(name);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Action execution
// ---------------------------------------------------------------------------------------------

describe('action execution', () => {
  it.each([
    ['down', [0, 400]],
    ['up', [0, -400]],
    ['left', [-400, 0]],
    ['right', [400, 0]],
  ] as const)('scroll %s moves to the denormalized point then wheels with the signed delta', async (direction, delta) => {
    const page = fakePage();
    const create = fakeCreate(toolTurn([scrollCall('call_1', { x: 333, y: 777, direction })]), finalReport());
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(true);
    // floor(333/1000*1280)=426, floor(777/1000*900)=699
    expect(page.moves).toEqual([[426, 699]]);
    expect(page.wheels).toEqual([delta]);
    if (result.ok) expect(result.actions).toEqual([{ turn: 1, name: 'scroll', intent: 'see more', executed: true }]);
  });

  it('scroll defaults magnitude to 300 when magnitude_in_pixels is absent or non-finite', async () => {
    const page = fakePage();
    const create = fakeCreate(
      toolTurn([fc('scroll', { x: 500, y: 500, direction: 'down' }, 'c1'), fc('scroll', { x: 500, y: 500, direction: 'up', magnitude_in_pixels: Infinity }, 'c2')]),
      finalReport(),
    );
    await run({ interactions: create, page });
    expect(page.wheels).toEqual([
      [0, 300],
      [0, -300],
    ]);
  });

  it('scroll defaults to the viewport centre when x/y are absent', async () => {
    const page = fakePage();
    await run({ interactions: fakeCreate(toolTurn([fc('scroll', { direction: 'down' })]), finalReport()), page });
    expect(page.moves).toEqual([[640, 450]]);
  });

  it('falls back to a 1280x900 viewport when viewportSize() is null', async () => {
    const page = fakePage({ viewport: null });
    await run({ interactions: fakeCreate(toolTurn([scrollCall()]), finalReport()), page });
    expect(page.moves).toEqual([[640, 450]]);
  });

  it('move calls mouse.move only and waits for load state after an executed action', async () => {
    const page = fakePage();
    const result = await run({ interactions: fakeCreate(toolTurn([fc('move', { x: 250, y: 100, intent: 'hover price' })]), finalReport()), page });
    expect(page.moves).toEqual([[320, 90]]);
    expect(page.wheels).toEqual([]);
    expect(page.loadWaits).toBe(1);
    if (result.ok) expect(result.actions).toEqual([{ turn: 1, name: 'move', intent: 'hover price', executed: true }]);
  });

  it('take_screenshot executes nothing on the page but is recorded executed:true', async () => {
    const page = fakePage();
    const result = await run({ interactions: fakeCreate(toolTurn([fc('take_screenshot', {})]), finalReport()), page });
    expect(page.moves).toEqual([]);
    expect(page.wheels).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toEqual([{ turn: 1, name: 'take_screenshot', intent: null, executed: true }]);
      expect(result.incidents).toEqual([]);
    }
  });

  it('wait with seconds:0 executes immediately and is recorded executed:true', async () => {
    const page = fakePage();
    const result = await run({ interactions: fakeCreate(toolTurn([fc('wait', { seconds: 0 })]), finalReport()), page });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actions).toEqual([{ turn: 1, name: 'wait', intent: null, executed: true }]);
  });

  it('wait clamps the requested duration to at most 5 seconds (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const page = fakePage();
    const pending = run({ interactions: fakeCreate(toolTurn([fc('wait', { seconds: 600 })]), finalReport()), page });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.ok).toBe(true);
    const delays = spy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(5000);
    expect(delays).not.toContain(600_000);
    expect(Math.max(...delays.map((d) => Number(d ?? 0)))).toBe(5000);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A17 enforcement
// ---------------------------------------------------------------------------------------------

describe('A17: disallowed function calls are never executed', () => {
  it.each(['click', 'type', 'navigate', 'press_key'])('%s is blocked, reported as submission_attempt_blocked, and the loop continues', async (name) => {
    const page = fakePage();
    const onIncident = vi.fn();
    const create = fakeCreate(toolTurn([fc(name, { x: 500, y: 500, text: 'x', url: 'https://www.lazada.sg/cart', intent: 'buy now' })]), finalReport());
    const result = await run({ interactions: create, page, onIncident });

    expect(page.moves).toEqual([]);
    expect(page.wheels).toEqual([]);
    expect(page.loadWaits).toBe(0);
    expect(onIncident).toHaveBeenCalledTimes(1);
    expect(onIncident).toHaveBeenCalledWith('submission_attempt_blocked', expect.stringContaining(`"${name}"`));

    expect(create.calls).toHaveLength(2);
    const in2 = stepsOf(create.snapshots[1]!);
    const fr = in2.at(-1)!;
    expect(fr).toMatchObject({ type: 'function_result', name, call_id: 'call_1' });
    const text = resultText(fr);
    expect(text.url).toBe(LAZADA_URL);
    expect(String(text.error)).toContain('not enabled in observe-only mode');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toEqual([{ turn: 1, name, intent: 'buy now', executed: false }]);
      expect(result.incidents).toEqual([{ kind: 'submission_attempt_blocked', detail: `Function "${name}" is not enabled in observe-only mode` }]);
      expect(result.report).toEqual(VALID_REPORT);
    }
  });

  it('an unknown non-submission function is blocked as action_not_enabled', async () => {
    const page = fakePage();
    const result = await run({ interactions: fakeCreate(toolTurn([fc('frobnicate', {})]), finalReport()), page });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.incidents).toEqual([{ kind: 'action_not_enabled', detail: 'Function "frobnicate" is not enabled in observe-only mode' }]);
    expect(page.moves).toEqual([]);
  });

  it('a page-level throw during an allowed action is recorded as dispatch_error with executed:false and the loop continues', async () => {
    const page = fakePage();
    page.mouse.wheel = async () => {
      throw new Error('wheel exploded');
    };
    const result = await run({ interactions: fakeCreate(toolTurn([scrollCall()]), finalReport()), page });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toEqual([{ turn: 1, name: 'scroll', intent: 'see more', executed: false }]);
      expect(result.incidents).toEqual([{ kind: 'dispatch_error', detail: 'scroll failed: Error: wheel exploded' }]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Safety confirmation
// ---------------------------------------------------------------------------------------------

describe('safety_decision', () => {
  it('require_confirmation halts immediately with blocked, executes nothing, and never calls create again', async () => {
    const page = fakePage();
    const onIncident = vi.fn();
    const create = fakeCreate(
      toolTurn([scrollCall('call_1', { safety_decision: { decision: 'require_confirmation', explanation: 'might add to cart' } })]),
      finalReport(),
    );
    const result = await run({ interactions: create, page, onIncident });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.detail).toMatch(/safety confirmation/);
      expect(result.turns).toBe(1);
      expect(result.actions).toEqual([]);
      expect(result.incidents).toEqual([{ kind: 'safety_confirmation_required', detail: 'Function "scroll" required confirmation: might add to cart' }]);
    }
    expect(onIncident).toHaveBeenCalledWith('safety_confirmation_required', expect.stringContaining('might add to cart'));
    expect(page.moves).toEqual([]);
    expect(page.wheels).toEqual([]);
    expect(create.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Off-host navigation
// ---------------------------------------------------------------------------------------------

describe('allowed hosts', () => {
  it('halts with blocked and unexpected_navigation when the page lands off-host after an action', async () => {
    const page = fakePage();
    page.hooks.onWheel = () => {
      page.currentUrl = 'https://evil.example/x';
    };
    const create = fakeCreate(toolTurn([scrollCall()]), finalReport());
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.incidents).toEqual([{ kind: 'unexpected_navigation', detail: 'Page is at disallowed host evil.example' }]);
      expect(result.finalUrl).toBe('https://evil.example/x');
      expect(result.turns).toBe(1);
    }
    expect(create.calls).toHaveLength(1);
  });

  it('halts before executing any action when the page is already off-host after the model responds', async () => {
    const page = fakePage({ url: 'https://evil.example/landing' });
    const create = fakeCreate(toolTurn([scrollCall()]), finalReport());
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.incidents.map((i) => i.kind)).toEqual(['unexpected_navigation']);
      expect(result.actions).toEqual([]);
    }
    expect(page.moves).toEqual([]);
    expect(create.calls).toHaveLength(1);
  });

  it.each([
    ['https://www.lazada.sg/products/x.html', true],
    ['https://s.lazada.sg/s.abc', true],
    ['https://lazada.sg/', true],
    ['https://WWW.LAZADA.SG/x', true],
    ['https://lazada.sg.evil.com/x', false],
    ['https://notlazada.sg/x', false],
  ])('allowedHosts:[lazada.sg] with %s -> allowed=%s', async (url, allowed) => {
    const create = fakeCreate(finalReport());
    const result = await run({ interactions: create, page: fakePage({ url }), allowedHosts: ['lazada.sg'] });
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.incidents.map((i) => i.kind)).toEqual(['unexpected_navigation']);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Limits
// ---------------------------------------------------------------------------------------------

describe('limits', () => {
  it('maxTurns:2 with a model that keeps scrolling ends with limit_exceeded after exactly 2 create calls', async () => {
    const create = fakeCreate(toolTurn([scrollCall()]));
    const result = await run({ interactions: create, page: fakePage(), maxTurns: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('limit_exceeded');
      expect(result.detail).toMatch(/maxTurns=2/);
      expect(result.turns).toBe(2);
      expect(result.actions).toHaveLength(2);
    }
    expect(create.calls).toHaveLength(2);
  });

  it('a clock jumping past maxSeconds after a turn ends the run with limit_exceeded naming maxSeconds', async () => {
    const clock = fixedClock();
    const page = fakePage();
    page.hooks.onWheel = () => {
      clock.mono = 6_000;
    };
    const create = fakeCreate(toolTurn([scrollCall()]));
    const result = await run({ interactions: create, page, clock, maxSeconds: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('limit_exceeded');
      expect(result.detail).toMatch(/maxSeconds=5/);
      expect(result.detail).toMatch(/Elapsed 6\.0s/);
      expect(result.turns).toBe(1);
      expect(result.usage.elapsedMs).toBe(6_000);
    }
    expect(create.calls).toHaveLength(1);
  });

  it('a clock already past maxSeconds before the first turn never calls create', async () => {
    let reads = 0;
    const clock: Clock = {
      now: () => new Date('2026-09-19T05:00:00.000Z'),
      monotonicMs: () => {
        reads += 1;
        return reads === 1 ? 0 : 999_000;
      },
    };
    const create = fakeCreate(finalReport());
    const result = await run({ interactions: create, page: fakePage(), clock, maxSeconds: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('limit_exceeded');
      expect(result.turns).toBe(0);
    }
    expect(create.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Status mapping
// ---------------------------------------------------------------------------------------------

describe('status mapping', () => {
  it.each([
    ['failed', 'api_error'],
    ['cancelled', 'api_error'],
    ['incomplete', 'truncated'],
    ['budget_exceeded', 'truncated'],
    ['something_new', 'api_error'],
  ] as const)('status "%s" -> %s', async (status, reason) => {
    const create = fakeCreate({ status, steps: [thought(), scrollCall()], output_text: '{"partial":' });
    const page = fakePage();
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.detail).toContain(status);
      expect(result.turns).toBe(1);
    }
    // A non-completed response never has its function calls executed.
    expect(page.moves).toEqual([]);
    expect(create.calls).toHaveLength(1);
  });

  it('a tool turn (function_call present) arrives as requires_action and is executed normally', async () => {
    const create = fakeCreate(toolTurn([scrollCall()]), finalTurn(JSON.stringify(VALID_REPORT)));
    const page = fakePage();
    const result = await run({ interactions: create, page });
    expect(result.ok).toBe(true);
    expect(page.moves).toHaveLength(1);
    expect(create.calls).toHaveLength(2);
  });

  it('requires_action without any function_call step maps to api_error', async () => {
    const create = fakeCreate({ status: 'requires_action', steps: [thought()], usage: USAGE });
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toContain('requires_action');
    }
    expect(create.calls).toHaveLength(1);
  });

  it('a model_output step carrying an error maps to api_error with the provider message', async () => {
    const create = fakeCreate({ status: 'completed', steps: [{ type: 'model_output', error: { message: 'boom', code: 500 } }] });
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/boom/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 10. Final output parsing
// ---------------------------------------------------------------------------------------------

describe('final output parsing', () => {
  it('parses a fenced ```json block into a validated report with finalText, finalUrl and turns', async () => {
    const text = fenced(VALID_REPORT);
    const result = await run({ interactions: fakeCreate(finalTurn(text)), page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report).toEqual(VALID_REPORT);
      expect(result.finalText).toBe(text);
      expect(result.finalUrl).toBe(LAZADA_URL);
      expect(result.turns).toBe(1);
      expect(result.actions).toEqual([]);
      expect(result.incidents).toEqual([]);
    }
  });

  it('parses bare JSON surrounded by prose (first { to last })', async () => {
    const text = `Here is what I observed:\n${JSON.stringify(VALID_REPORT)}\nEnd of report.`;
    const result = await run({ interactions: fakeCreate(finalTurn(text)), page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report).toEqual(VALID_REPORT);
      expect(result.finalText).toBe(text);
    }
  });

  it('falls back to the last model_output step text when output_text is absent', async () => {
    const create = fakeCreate({
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'superseded' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Report:' }, { type: 'text', text: JSON.stringify(VALID_REPORT) }] },
      ],
    });
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report).toEqual(VALID_REPORT);
      expect(result.finalText).toBe(`Report:\n${JSON.stringify(VALID_REPORT)}`);
    }
  });

  it('non-JSON final text maps to invalid_output', async () => {
    const result = await run({ interactions: fakeCreate(finalTurn('I could not see the page clearly.')), page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_output');
      expect(result.detail).toMatch(/not parseable as JSON/);
    }
  });

  it('JSON failing the Zod schema maps to invalid_output mentioning schema validation', async () => {
    const bad = { ...VALID_REPORT, availability: 'maybe' };
    const result = await run({ interactions: fakeCreate(finalTurn(fenced(bad))), page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_output');
      expect(result.detail).toMatch(/schema validation/);
      expect(result.detail).toMatch(/availability/);
    }
  });

  it('a completed turn with empty text maps to invalid_output, never a fabricated report', async () => {
    const result = await run({ interactions: fakeCreate({ status: 'completed', steps: [{ type: 'model_output', content: [] }] }), page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_output');
  });
});

// ---------------------------------------------------------------------------------------------
// 11. Usage aggregation
// ---------------------------------------------------------------------------------------------

describe('usage aggregation', () => {
  it('sums tokens across turns, counts function_call steps as toolCalls, and prices gemini-3.8-flash', async () => {
    const create = fakeCreate(
      toolTurn([scrollCall('c1'), scrollCall('c2', { direction: 'up' })], { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 20, total_cached_tokens: 10 }),
      toolTurn([fc('move', { x: 1, y: 1 }, 'c3')], { total_input_tokens: 200, total_output_tokens: 30, total_thought_tokens: 5, total_cached_tokens: 7 }),
      finalTurn(fenced(VALID_REPORT), { usage: { total_input_tokens: 300, total_output_tokens: 40 } }),
    );
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turns).toBe(3);
      expect(result.usage.inputTokens).toBe(600);
      expect(result.usage.outputTokens).toBe(50 + 20 + 30 + 5 + 40);
      expect(result.usage.cacheReadInputTokens).toBe(17);
      expect(result.usage.cacheCreationInputTokens).toBe(0);
      expect(result.usage.toolCalls).toBe(3);
      expect(result.usage.estimatedCostUsd).toBeCloseTo((600 / 1e6) * 0.75 + (145 / 1e6) * 3.75, 12);
    }
  });

  it('reports estimatedCostUsd as null for a model absent from the pricing table', async () => {
    const result = await run({ interactions: fakeCreate(finalReport()), page: fakePage(), model: 'gemini-9.9-imaginary' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.estimatedCostUsd).toBeNull();
    }
  });

  it('a response without usage contributes zero tokens', async () => {
    const result = await run({ interactions: fakeCreate(finalTurn(fenced(VALID_REPORT), { usage: undefined })), page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
      expect(result.usage.estimatedCostUsd).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 12. Retries
// ---------------------------------------------------------------------------------------------

describe('retries', () => {
  it('retries a 429 twice and then succeeds with 3 create calls', async () => {
    const create = fakeCreate(new ApiError({ message: 'rate', status: 429 }), new ApiError({ message: 'rate', status: 429 }), finalReport());
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.turns).toBe(1);
    expect(create.calls).toHaveLength(3);
  });

  it('never retries a 400 and fails on the first attempt with api_error', async () => {
    const create = fakeCreate(new ApiError({ message: 'bad request', status: 400 }));
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/bad request/);
      expect(result.turns).toBe(0);
    }
    expect(create.calls).toHaveLength(1);
  });

  it('gives up after three connection-level failures rather than looping', async () => {
    const create = fakeCreate(new Error('ECONNRESET'));
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/ECONNRESET/);
    }
    expect(create.calls).toHaveLength(3);
  });

  it('never retries a plain (non-ApiError) throw carrying status:400, failing after exactly 1 call', async () => {
    const create = fakeCreate(Object.assign(new Error('bad request'), { status: 400 }));
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('api_error');
      expect(result.detail).toMatch(/bad request/);
      expect(result.turns).toBe(0);
    }
    expect(create.calls).toHaveLength(1);
  });

  it('retries a plain (non-ApiError) throw carrying status:503 twice and then succeeds with 3 create calls', async () => {
    const create = fakeCreate(
      Object.assign(new Error('unavailable'), { status: 503 }),
      Object.assign(new Error('unavailable'), { status: 503 }),
      finalReport(),
    );
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(true);
    expect(create.calls).toHaveLength(3);
  });

  it('retries an Error with no status field as connection-level', async () => {
    const create = fakeCreate(new Error('no status here'), finalReport());
    const result = await run({ interactions: create, page: fakePage() });
    expect(result.ok).toBe(true);
    expect(create.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 13. Sinks and callbacks
// ---------------------------------------------------------------------------------------------

describe('screenshotSink and onTurn', () => {
  it('screenshotSink receives turn 0 then one buffer per action turn; onTurn reports turn, action names and url', async () => {
    const page = fakePage();
    const sink = vi.fn();
    const onTurn = vi.fn();
    const create = fakeCreate(toolTurn([scrollCall('c1')]), toolTurn([fc('move', { x: 1, y: 1 }, 'c2'), fc('take_screenshot', {}, 'c3')]), finalReport());
    const result = await run({ interactions: create, page, screenshotSink: sink, onTurn });
    expect(result.ok).toBe(true);

    expect(sink.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(sink.mock.calls.map((c) => c[1])).toEqual(page.screenshots);
    expect(page.screenshots).toHaveLength(3);

    expect(onTurn.mock.calls.map((c) => c[0])).toEqual([
      { turn: 1, actions: ['scroll'], url: LAZADA_URL },
      { turn: 2, actions: ['move', 'take_screenshot'], url: LAZADA_URL },
    ]);
  });
});
