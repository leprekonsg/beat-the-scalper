/**
 * RestrictedBrowserExecutor boundary tests (BTS_FABLE_BUILD_PLAN.md sections 8, 9, 11).
 *
 * These run a real Chromium page against two tiny local `node:http` fixture origins so
 * the enforcement under test is the executor's, not a mock's. One browser is shared by
 * the whole file. Acceptance IDs: A15 (halt-on-failure batch), A17 (disallowed action
 * rejected independently of model compliance), A18 (submission attempt via
 * click/key/script/navigation), A26 (demo-only submission against a non-demo origin).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FableOfferInterpreter } from '../../src/agent/assess.ts';
import { RestrictedBrowserExecutor, type BrowserExecutorMode, type IncidentKind } from '../../src/agent/browserExecutor.ts';
import type { FableClient, TaskResult, TaskSpec } from '../../src/agent/client.ts';
import { extractAnnouncement } from '../../src/agent/extract.ts';
import { makeIntent, makeObservation } from './builders.ts';

const HALT_TEXT = 'Not executed: an earlier action in this turn failed.';
const STALE_SUFFIX = 'is stale or not found on the current page. Re-read the page to get fresh references.';
const COORDINATE_TEXT = 'Coordinate clicks are disabled; use a ref from read_page/find';
const SUBMISSION_TEXT = 'Submission is controller-owned; the model may not click purchase controls';
const TRUNCATION_MARKER = '\n...[truncated at 20000 characters]';

// ---------------------------------------------------------------- fixture servers

let otherOrigin = '';

function productPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture product</title></head><body>
<h1>Fixture Product</h1>
<button id="add">Add to cart</button>
<button id="place">Place order</button>
<button id="buy">Buy now</button>
<input aria-label="Coupon code" id="coupon">
<a href="/details">Product details</a>
<a id="external" href="${otherOrigin}/other">Partner site</a>
<form action="/checkout/step-2" method="get">
  <input aria-label="Delivery name" name="delivery">
  <button type="submit">Continue</button>
</form>
<form action="/save-address" method="get">
  <input aria-label="Street address" name="street">
  <button type="submit">Save address</button>
</form>
<p id="log"></p>
<script>
document.getElementById('add').addEventListener('click', function () {
  document.getElementById('log').textContent += 'added;';
});
</script>
</body></html>`;
}

const PAGES_A: Record<string, () => string> = {
  '/product': productPage,
  '/details': () => '<!doctype html><html><head><title>Details</title></head><body><h1>Details</h1><button>Add to cart</button></body></html>',
  '/checkout': () =>
    '<!doctype html><html><head><title>Checkout review</title></head><body><h1>Checkout review</h1><p>Delivered total S$102.89</p></body></html>',
  '/checkout/step-2': () => '<!doctype html><html><head><title>Checkout step 2</title></head><body><h1>Checkout step 2</h1></body></html>',
  '/save-address': () => '<!doctype html><html><head><title>Address saved</title></head><body><h1>Address saved</h1></body></html>',
  '/big': () => `<!doctype html><html><head><title>Big</title></head><body><p>${'abcdefghij'.repeat(2600)}</p></body></html>`,
};

const PAGES_B: Record<string, () => string> = {
  '/other': () =>
    '<!doctype html><html><head><title>Partner</title></head><body><h1>Partner</h1><button>Place order</button><button>Add to cart</button></body></html>',
};

async function startFixtureServer(pages: Record<string, () => string>): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const render = pages[path];
    if (!render) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Not found</title></head><body>Not found</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(render());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------- harness helpers

let browser: Browser;
let serverA: Server;
let serverB: Server;
let originA = '';
let originB = '';
const openPages: Page[] = [];

let toolUseSeq = 0;
function toolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  toolUseSeq += 1;
  return { type: 'tool_use', id: `toolu_${toolUseSeq}`, name, input, caller: { type: 'direct' }, toolset_name: 'browser' };
}

function resultText(result: ToolResultBlockParam): string {
  const content = result.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

interface Incident {
  kind: IncidentKind;
  detail: string;
}

interface Harness {
  page: Page;
  exec: RestrictedBrowserExecutor;
  incidents: Incident[];
  kinds: () => IncidentKind[];
}

async function makeHarness(
  mode: BrowserExecutorMode,
  opts: { allowedOrigins?: string[]; demoStoreOrigin?: string | null } = {},
): Promise<Harness> {
  const page = await browser.newPage();
  openPages.push(page);
  const incidents: Incident[] = [];
  const exec = new RestrictedBrowserExecutor({
    page,
    mode,
    allowedOrigins: opts.allowedOrigins ?? [originA],
    demoStoreOrigin: opts.demoStoreOrigin === undefined ? originA : opts.demoStoreOrigin,
    onIncident: (kind, detail) => incidents.push({ kind, detail }),
  });
  return { page, exec, incidents, kinds: () => incidents.map((i) => i.kind) };
}

/** Demo harness already on the fixture product page, navigated through the executor. */
async function demoOnProduct(): Promise<Harness> {
  const h = await makeHarness('demo');
  const result = await h.exec.dispatch(toolUse('navigate', { url: `${originA}/product` }));
  expect(result.is_error).toBeFalsy();
  return h;
}

async function refFor(exec: RestrictedBrowserExecutor, label: string): Promise<string> {
  const result = await exec.dispatch(toolUse('find', { query: label }));
  const line = resultText(result)
    .split('\n')
    .find((l) => l.includes(`"${label}"`));
  const match = line ? /\[(ref_\d+)\]/.exec(line) : null;
  if (!match) throw new Error(`No ref found for "${label}" in: ${resultText(result)}`);
  return match[1]!;
}

function enabledMembers(exec: RestrictedBrowserExecutor): string[] {
  const configs = exec.toolsetDefinition().configs as unknown as Record<string, { enabled?: boolean }>;
  return Object.entries(configs)
    .filter(([, cfg]) => cfg.enabled === true)
    .map(([name]) => name)
    .sort();
}

const OBSERVE = ['find', 'get_page_text', 'navigate', 'read_page', 'screenshot', 'scroll', 'wait', 'zoom'];

beforeAll(async () => {
  const b = await startFixtureServer(PAGES_B);
  serverB = b.server;
  originB = b.origin;
  otherOrigin = originB; // productPage() links to the second origin
  const a = await startFixtureServer(PAGES_A);
  serverA = a.server;
  originA = a.origin;
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  await stopServer(serverA);
  await stopServer(serverB);
});

// ---------------------------------------------------------------- toolset definition

describe('toolsetDefinition mode gating (section 9)', () => {
  it('enables exactly the documented members per mode', async () => {
    const demo = await makeHarness('demo');
    const prepare = await makeHarness('lazada_prepare');
    const observe = await makeHarness('lazada_observe');

    expect(enabledMembers(demo.exec)).toEqual([...OBSERVE, 'form_input', 'left_click', 'type'].sort());
    expect(enabledMembers(prepare.exec)).toEqual([...OBSERVE, 'left_click'].sort());
    expect(enabledMembers(observe.exec)).toEqual([...OBSERVE].sort());
  });

  it('declares every member explicitly and disables key and hover in every mode', async () => {
    for (const mode of ['demo', 'lazada_prepare', 'lazada_observe'] as BrowserExecutorMode[]) {
      const { exec } = await makeHarness(mode);
      const configs = exec.toolsetDefinition().configs as unknown as Record<string, { enabled?: boolean }>;
      // Every member of browser_toolset_20260801 carries an explicit decision; none is
      // left to its server-side default.
      expect(Object.keys(configs)).toHaveLength(31);
      for (const cfg of Object.values(configs)) expect(typeof cfg.enabled).toBe('boolean');
      for (const member of [
        'key',
        'hover',
        'hold_key',
        'javascript_exec',
        'file_upload',
        'new_tab',
        'close_tab',
        'switch_tab',
        'list_tabs',
        'double_click',
        'triple_click',
        'right_click',
        'middle_click',
        'left_click_drag',
        'left_mouse_down',
        'left_mouse_up',
        'mouse_move',
        'read_console',
        'read_network',
        'scroll_to',
      ]) {
        expect(configs[member], `${member} in mode ${mode}`).toEqual({ enabled: false });
      }
    }
  });

  it('marks the toolset cacheable and uses the documented toolset version', async () => {
    const { exec } = await makeHarness('demo');
    const def = exec.toolsetDefinition();
    expect(def.type).toBe('browser_toolset_20260801');
    expect(def.cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ---------------------------------------------------------------- A17

describe('dispatch rejects a disabled member regardless of what the model requests (A17)', () => {
  it('rejects form_input and type in lazada_prepare and records an incident', async () => {
    const { exec, incidents } = await makeHarness('lazada_prepare');
    for (const member of ['form_input', 'type']) {
      const result = await exec.dispatch(toolUse(member, { target: { type: 'ref', ref: 'ref_1' }, value: 'x', text: 'x' }));
      expect(result.is_error).toBe(true);
      expect(resultText(result)).toBe(`Member ${member} is not enabled in mode lazada_prepare`);
    }
    expect(incidents.map((i) => i.kind)).toEqual(['member_not_enabled', 'member_not_enabled']);
  });

  it('rejects left_click in lazada_observe', async () => {
    const { exec, incidents } = await makeHarness('lazada_observe');
    const result = await exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: 'ref_1' } }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe('Member left_click is not enabled in mode lazada_observe');
    expect(incidents[0]?.kind).toBe('member_not_enabled');
  });

  it('rejects key, hover, and javascript_exec even in demo, the most permissive mode (A18)', async () => {
    const { exec, incidents } = await makeHarness('demo');
    for (const member of ['key', 'hover', 'javascript_exec', 'file_upload', 'new_tab']) {
      const result = await exec.dispatch(toolUse(member, { text: 'Enter', code: 'document.forms[0].submit()' }));
      expect(result.is_error, member).toBe(true);
      expect(resultText(result)).toBe(`Member ${member} is not enabled in mode demo`);
    }
    expect(incidents).toHaveLength(5);
    expect(new Set(incidents.map((i) => i.kind))).toEqual(new Set(['member_not_enabled']));
  });

  it('never executes a disabled member: an Enter key request leaves the page untouched', async () => {
    const h = await demoOnProduct();
    const before = h.page.url();
    const result = await h.exec.dispatch(toolUse('key', { text: 'Enter' }));
    expect(result.is_error).toBe(true);
    expect(h.page.url()).toBe(before);
  });
});

// ---------------------------------------------------------------- A15

describe('executeBatch halts after the first failure (A15, section 11)', () => {
  it('answers every tool call and gives every later call the exact halt text', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');

    const batch = [
      toolUse('read_page'),
      toolUse('navigate', { url: 'file:///etc/passwd' }),
      toolUse('left_click', { target: { type: 'ref', ref: addRef } }),
      toolUse('get_page_text'),
    ];
    const results = await h.exec.executeBatch(batch);

    expect(results).toHaveLength(4);
    expect(results.map((r) => r.tool_use_id)).toEqual(batch.map((b) => b.id));
    expect(results[0]!.is_error).toBeFalsy();
    expect(results[1]!.is_error).toBe(true);
    for (const halted of [results[2]!, results[3]!]) {
      expect(halted.is_error).toBe(true);
      expect(resultText(halted)).toBe(HALT_TEXT);
    }
    // The halted click really did not run.
    expect(await h.page.locator('#log').textContent()).toBe('');
  });

  it('runs an all-successful batch in order without halting', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');
    const results = await h.exec.executeBatch([
      toolUse('left_click', { target: { type: 'ref', ref: addRef } }),
      toolUse('left_click', { target: { type: 'ref', ref: addRef } }),
      toolUse('get_page_text'),
    ]);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(await h.page.locator('#log').textContent()).toBe('added;added;');
  });

  it('halts the remainder when a click fails on a stale ref', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');
    await h.exec.dispatch(toolUse('navigate', { url: `${originA}/details` }));
    const results = await h.exec.executeBatch([toolUse('left_click', { target: { type: 'ref', ref: addRef } }), toolUse('screenshot')]);
    expect(resultText(results[0]!)).toContain(STALE_SUFFIX);
    expect(resultText(results[1]!)).toBe(HALT_TEXT);
  });
});

// ---------------------------------------------------------------- stale refs

describe('element references are invalidated by navigation (section 8)', () => {
  it('returns the documented stale-ref error after an executor navigation', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');
    await h.exec.dispatch(toolUse('navigate', { url: `${originA}/details` }));

    const result = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: addRef } }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(`Error: ${addRef} is stale or not found on the current page. Re-read the page to get fresh references.`);
  });

  it('returns the same error for form_input and for a ref that was never issued', async () => {
    const h = await demoOnProduct();
    const couponRef = await refFor(h.exec, 'Coupon code');
    await h.exec.dispatch(toolUse('navigate', { url: `${originA}/details` }));

    const stale = await h.exec.dispatch(toolUse('form_input', { target: { type: 'ref', ref: couponRef }, value: 'ABC' }));
    expect(resultText(stale)).toBe(`Error: ${couponRef} is stale or not found on the current page. Re-read the page to get fresh references.`);

    const invented = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: 'ref_9999' } }));
    expect(resultText(invented)).toBe('Error: ref_9999 is stale or not found on the current page. Re-read the page to get fresh references.');
  });

  it('issues fresh ids after a re-read and never reuses a retired id', async () => {
    const h = await demoOnProduct();
    const first = await refFor(h.exec, 'Add to cart');
    await h.exec.dispatch(toolUse('navigate', { url: `${originA}/product` }));
    const second = await refFor(h.exec, 'Add to cart');
    expect(second).not.toBe(first);
    const ok = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: second } }));
    expect(ok.is_error).toBeFalsy();
  });
});

// ---------------------------------------------------------------- coordinates

describe('coordinate targets are rejected in every mode (section 9)', () => {
  it('rejects coordinate and missing targets for left_click and form_input', async () => {
    const cases: { mode: BrowserExecutorMode; member: string }[] = [
      { mode: 'demo', member: 'left_click' },
      { mode: 'demo', member: 'form_input' },
      { mode: 'lazada_prepare', member: 'left_click' },
    ];
    for (const { mode, member } of cases) {
      const { exec, incidents } = await makeHarness(mode);
      const coordinate = await exec.dispatch(toolUse(member, { target: { type: 'coordinate', x: 120, y: 240 }, value: 'x' }));
      expect(coordinate.is_error, `${mode}/${member}`).toBe(true);
      expect(resultText(coordinate)).toBe(COORDINATE_TEXT);

      const missing = await exec.dispatch(toolUse(member, { value: 'x' }));
      expect(missing.is_error).toBe(true);
      expect(resultText(missing)).toBe(COORDINATE_TEXT);

      expect(incidents.map((i) => i.kind)).toEqual(['coordinate_click_blocked', 'coordinate_click_blocked']);
    }
  });

  it('does not click anything when a coordinate click is rejected', async () => {
    const h = await demoOnProduct();
    const box = await h.page.locator('#add').boundingBox();
    const result = await h.exec.dispatch(
      toolUse('left_click', { target: { type: 'coordinate', x: (box?.x ?? 0) + 2, y: (box?.y ?? 0) + 2 } }),
    );
    expect(result.is_error).toBe(true);
    expect(await h.page.locator('#log').textContent()).toBe('');
  });
});

// ---------------------------------------------------------------- submission guard

describe('submission guard (A18, A26)', () => {
  it('rejects clicks on purchase controls in lazada_prepare and records an incident (A18)', async () => {
    const h = await makeHarness('lazada_prepare');
    await h.page.goto(`${originA}/product`);
    for (const label of ['Place order', 'Buy now']) {
      const ref = await refFor(h.exec, label);
      const result = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref } }));
      expect(result.is_error, label).toBe(true);
      expect(resultText(result)).toBe(SUBMISSION_TEXT);
    }
    expect(h.kinds().filter((k) => k === 'submission_attempt_blocked')).toHaveLength(2);
    expect(h.page.url()).toBe(`${originA}/product`);
  });

  it('rejects a click on a neutral-looking control inside a checkout form (A18)', async () => {
    const h = await makeHarness('lazada_prepare');
    await h.page.goto(`${originA}/product`);
    const ref = await refFor(h.exec, 'Continue');
    const result = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref } }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(SUBMISSION_TEXT);
    expect(h.incidents[0]?.detail).toContain('Continue');
    expect(h.page.url()).toBe(`${originA}/product`);
  });

  it('rejects the demo submission click on the demo origin without raising an incident', async () => {
    const h = await demoOnProduct();
    const ref = await refFor(h.exec, 'Place order');
    const result = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref } }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(SUBMISSION_TEXT);
    // Controller-owned submission is the expected path here, so it is not an anomaly.
    expect(h.kinds()).not.toContain('submission_attempt_blocked');
  });

  it('rejects a demo-mode submission attempted against a non-demo origin and records an incident (A26)', async () => {
    const h = await makeHarness('demo', { allowedOrigins: [originA, originB], demoStoreOrigin: originA });
    await h.page.goto(`${originB}/other`);
    const ref = await refFor(h.exec, 'Place order');
    const result = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref } }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(SUBMISSION_TEXT);
    expect(h.kinds()).toContain('submission_attempt_blocked');
    // allowedOrigins cannot widen the demo mode's single permitted origin.
    expect(h.kinds()).toContain('unexpected_navigation');
  });

  it('rejects form_input into a checkout form in demo mode', async () => {
    const h = await demoOnProduct();
    const ref = await refFor(h.exec, 'Delivery name');
    const result = await h.exec.dispatch(toolUse('form_input', { target: { type: 'ref', ref }, value: 'A Collector' }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(SUBMISSION_TEXT);
    expect(await h.page.locator('input[name="delivery"]').inputValue()).toBe('');
  });

  it('still allows non-submitting preparation: add to cart and a plain field', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');
    const clicked = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: addRef } }));
    expect(clicked.is_error).toBeFalsy();
    expect(await h.page.locator('#log').textContent()).toBe('added;');

    const couponRef = await refFor(h.exec, 'Coupon code');
    const filled = await h.exec.dispatch(toolUse('form_input', { target: { type: 'ref', ref: couponRef }, value: 'SAVE5' }));
    expect(filled.is_error).toBeFalsy();
    expect(await h.page.locator('#coupon').inputValue()).toBe('SAVE5');
    expect(h.incidents).toEqual([]);
  });

  it('rejects a type containing Enter, which submits a form exactly like a submit click (A18)', async () => {
    const h = await demoOnProduct();
    const streetRef = await refFor(h.exec, 'Street address');
    await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: streetRef } }));

    const result = await h.exec.dispatch(toolUse('type', { text: 'Blk 123 Demo Road\n' }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain('Enter/newline is not permitted');
    expect(h.kinds()).toContain('submission_attempt_blocked');
    // The form was never submitted: still on the product page.
    expect(h.page.url()).toBe(`${originA}/product`);

    const plain = await h.exec.dispatch(toolUse('type', { text: 'Blk 123 Demo Road' }));
    expect(plain.is_error).toBeFalsy();
    expect(await h.page.locator('input[name="street"]').inputValue()).toBe('Blk 123 Demo Road');
    expect(h.page.url()).toBe(`${originA}/product`);
  });
});

// ---------------------------------------------------------------- navigation boundary

describe('navigate boundary (section 9)', () => {
  it('rejects non-http(s) schemes', async () => {
    const { exec, incidents } = await makeHarness('demo');
    for (const url of ['file:///etc/passwd', 'javascript:document.forms[0].submit()', 'data:text/html,<h1>x</h1>', 'chrome://settings']) {
      const result = await exec.dispatch(toolUse('navigate', { url }));
      expect(result.is_error, url).toBe(true);
      expect(resultText(result)).toBe('Navigation rejected: only http/https destinations are permitted');
    }
    expect(incidents.map((i) => i.kind)).toEqual(['navigation_blocked', 'navigation_blocked', 'navigation_blocked', 'navigation_blocked']);
  });

  it('rejects a malformed url and a missing url without touching the page', async () => {
    const { exec, page } = await makeHarness('demo');
    expect(resultText(await exec.dispatch(toolUse('navigate', { url: 'not a url' })))).toContain('is not a valid URL');
    expect(resultText(await exec.dispatch(toolUse('navigate', {})))).toBe('navigate requires a string url');
    expect(page.url()).toBe('about:blank');
  });

  it('rejects loopback and private destinations that are not the demo store origin', async () => {
    const { exec, incidents } = await makeHarness('demo', { allowedOrigins: [originA, originB], demoStoreOrigin: originA });
    const blocked = [
      `${originB}/other`,
      'http://localhost:9/admin',
      'http://10.0.0.5/x',
      'http://192.168.1.10/x',
      'http://172.16.0.9/x',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0:9/x',
    ];
    for (const url of blocked) {
      const result = await exec.dispatch(toolUse('navigate', { url }));
      expect(result.is_error, url).toBe(true);
      expect(resultText(result)).toBe('Navigation rejected: loopback/private destinations are only permitted for the demo store origin');
    }
    expect(incidents).toHaveLength(blocked.length);
  });

  it('rejects an IPv6 loopback literal even when it is explicitly allow-listed', async () => {
    const { exec, incidents } = await makeHarness('lazada_prepare', { allowedOrigins: ['http://[::1]:9'], demoStoreOrigin: null });
    const result = await exec.dispatch(toolUse('navigate', { url: 'http://[::1]:9/admin' }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe('Navigation rejected: loopback/private destinations are only permitted for the demo store origin');
    expect(incidents.map((i) => i.kind)).toEqual(['navigation_blocked']);
  });

  it('rejects an origin outside the allowlist in a lazada mode', async () => {
    const { exec, incidents } = await makeHarness('lazada_prepare', { allowedOrigins: ['https://www.lazada.sg'], demoStoreOrigin: null });
    const result = await exec.dispatch(toolUse('navigate', { url: 'https://example.com/product/1' }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe('Navigation rejected: https://example.com is not an allowed origin in mode lazada_prepare');
    expect(incidents.map((i) => i.kind)).toEqual(['navigation_blocked']);
  });

  it('rejects an out-of-allowlist origin in demo mode even when allowedOrigins lists it', async () => {
    const { exec } = await makeHarness('demo', { allowedOrigins: ['https://www.lazada.sg'], demoStoreOrigin: originA });
    const result = await exec.dispatch(toolUse('navigate', { url: 'https://www.lazada.sg/products/x' }));
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain('is not an allowed origin in mode demo');
  });

  it('rejects a navigation to a purchase-submission URL but still allows a checkout review page (A18)', async () => {
    const h = await demoOnProduct();
    const submit = await h.exec.dispatch(toolUse('navigate', { url: `${originA}/checkout/submit?session=1` }));
    expect(submit.is_error).toBe(true);
    expect(resultText(submit)).toBe('Submission is controller-owned; the model may not navigate to a purchase-submission URL');
    expect(h.kinds()).toContain('submission_attempt_blocked');
    expect(h.page.url()).toBe(`${originA}/product`);

    const review = await h.exec.dispatch(toolUse('navigate', { url: `${originA}/checkout` }));
    expect(review.is_error).toBeFalsy();
    expect(h.page.url()).toBe(`${originA}/checkout`);
  });

  it('allows the demo store origin and reports browser state', async () => {
    const h = await makeHarness('demo');
    const result = await h.exec.dispatch(toolUse('navigate', { url: `${originA}/product` }));
    expect(result.is_error).toBeFalsy();
    expect(resultText(result)).toBe(`Navigated to ${originA}/product`);
    const state = (result.content as { type: string }[]).find((b) => b.type === 'browser_state') as
      | { tabs: { url: string; title: string; active: boolean }[] }
      | undefined;
    expect(state?.tabs[0]?.url).toBe(`${originA}/product`);
    expect(state?.tabs[0]?.title).toBe('Fixture product');
    expect(h.incidents).toEqual([]);
  });
});

// ---------------------------------------------------------------- unexpected navigation

describe('unexpected navigation to an out-of-allowlist origin', () => {
  it('flags an incident and drops every ref when a clicked link leaves the allowed origin', async () => {
    const h = await demoOnProduct();
    const addRef = await refFor(h.exec, 'Add to cart');
    const linkRef = await refFor(h.exec, 'Partner site');

    const clicked = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: linkRef } }));
    expect(clicked.is_error).toBeFalsy();
    await h.page.waitForURL(`${originB}/other`);

    const unexpected = h.incidents.filter((i) => i.kind === 'unexpected_navigation');
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]!.detail).toContain(originB);

    const stale = await h.exec.dispatch(toolUse('left_click', { target: { type: 'ref', ref: addRef } }));
    expect(resultText(stale)).toContain(STALE_SUFFIX);
  });

  it('does not flag a navigation that stays inside the allowed origin', async () => {
    const h = await makeHarness('lazada_prepare', { allowedOrigins: [originA], demoStoreOrigin: null });
    await h.page.goto(`${originA}/product`);
    await h.page.goto(`${originA}/details`);
    expect(h.kinds()).not.toContain('unexpected_navigation');
  });
});

// ---------------------------------------------------------------- read surface

describe('read surface', () => {
  it('truncates get_page_text at 20000 characters with an explicit marker', async () => {
    const h = await demoOnProduct();
    await h.exec.dispatch(toolUse('navigate', { url: `${originA}/big` }));
    const text = resultText(await h.exec.dispatch(toolUse('get_page_text')));
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(text.slice(0, -TRUNCATION_MARKER.length)).toHaveLength(20000);
  });

  it('does not add a truncation marker to a short page', async () => {
    const h = await demoOnProduct();
    const text = resultText(await h.exec.dispatch(toolUse('get_page_text')));
    expect(text).toContain('Fixture Product');
    expect(text).not.toContain('truncated');
  });

  it('lists interactive elements with refs and supports a filtered read', async () => {
    const h = await demoOnProduct();
    const all = resultText(await h.exec.dispatch(toolUse('read_page')));
    expect(all).toMatch(/button "Add to cart" \[ref_\d+\]/);
    expect(all).toMatch(/link "Product details" \[ref_\d+\]/);
    expect(all).toMatch(/textbox "Coupon code" \[ref_\d+\]/);

    const filtered = resultText(await h.exec.dispatch(toolUse('read_page', { filter: 'coupon' })));
    expect(filtered).toMatch(/textbox "Coupon code"/);
    expect(filtered).not.toContain('Add to cart');

    const none = resultText(await h.exec.dispatch(toolUse('find', { query: 'nonexistent control' })));
    expect(none).toBe('No elements matched "nonexistent control".');

    const empty = await h.exec.dispatch(toolUse('find', {}));
    expect(empty.is_error).toBe(true);
    expect(resultText(empty)).toBe('find requires a string query');
  });

  it('returns a png screenshot and a cropped zoom', async () => {
    const h = await demoOnProduct();
    const shot = await h.exec.dispatch(toolUse('screenshot'));
    const image = (shot.content as { type: string; source?: { media_type?: string; data?: string } }[]).find((b) => b.type === 'image');
    expect(image?.source?.media_type).toBe('image/png');
    expect((image?.source?.data ?? '').length).toBeGreaterThan(100);

    const zoom = await h.exec.dispatch(toolUse('zoom', { region: [0, 0, 120, 80] }));
    expect(zoom.is_error).toBeFalsy();
    const badZoom = await h.exec.dispatch(toolUse('zoom', { region: [0, 0] }));
    expect(badZoom.is_error).toBe(true);
    expect(resultText(badZoom)).toBe('zoom requires region:[x0,y0,x1,y1] in pixels');
  });
});

// ---------------------------------------------------------------- wait cap

/** Minimal Page stand-in: the wait cap is arithmetic, and a real 10s wait is not. */
function stubPage(): { page: Page; waits: number[] } {
  const waits: number[] = [];
  const page = {
    on: () => undefined,
    url: () => 'about:blank',
    title: async () => '',
    mainFrame: () => ({}),
    waitForTimeout: async (ms: number) => {
      waits.push(ms);
    },
  } as unknown as Page;
  return { page, waits };
}

describe('wait is bounded (section 8 task limits)', () => {
  it('caps a long wait at 10s, floors a negative one, and passes a normal one through', async () => {
    const { page, waits } = stubPage();
    const exec = new RestrictedBrowserExecutor({
      page,
      mode: 'lazada_observe',
      allowedOrigins: [originA],
      demoStoreOrigin: null,
      onIncident: () => undefined,
    });

    const capped = await exec.dispatch(toolUse('wait', { duration: 45 }));
    expect(resultText(capped)).toBe('Waited 10s (capped from requested 45s; wait is bounded to 10s).');

    await exec.dispatch(toolUse('wait', { duration: -5 }));
    const normal = await exec.dispatch(toolUse('wait', { duration: 2 }));
    expect(resultText(normal)).toBe('Waited 2s.');
    await exec.dispatch(toolUse('wait', {}));

    expect(waits).toEqual([10000, 0, 2000, 1000]);
  });
});

// ---------------------------------------------------------------- assess.ts / extract.ts wiring

function capturingClient(): { client: FableClient; specs: TaskSpec<unknown>[] } {
  const specs: TaskSpec<unknown>[] = [];
  const client: FableClient = {
    path: 'offline_replay',
    runTask<T>(task: TaskSpec<T>): Promise<TaskResult<T>> {
      specs.push(task as TaskSpec<unknown>);
      return Promise.resolve({
        ok: false,
        reason: 'api_error',
        detail: 'capturing stub: no model call',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          toolCalls: 0,
          elapsedMs: 0,
          estimatedCostUsd: null,
        },
        provenance: 'blocked',
      });
    },
  };
  return { client, specs };
}

function specText(spec: TaskSpec<unknown>): string {
  return JSON.stringify(spec.messages);
}

describe('FableOfferInterpreter wiring (assess.ts)', () => {
  it('serves the observe-mode toolset and never sends accountRef to the model', async () => {
    const { exec } = await makeHarness('lazada_observe', { allowedOrigins: ['https://www.lazada.sg'], demoStoreOrigin: null });
    const { client, specs } = capturingClient();
    const interpreter = new FableOfferInterpreter(client, {
      dataDir: mkdtempSync(join(tmpdir(), 'bts-assess-')),
      browserExecutor: exec,
    });

    const outcome = await interpreter.assess({
      intent: makeIntent({ mode: 'lazada_assist', authority: 'observe' }),
      observation: makeObservation(),
      evidence: null,
    });
    expect(outcome.ok).toBe(false);

    const spec = specs[0]!;
    expect(spec.name).toBe('assess-offer');
    expect(spec.browserExecutor).toBe(exec);
    expect(spec.tools).toHaveLength(1);
    const configs = (spec.tools![0] as unknown as { configs: Record<string, { enabled?: boolean }> }).configs;
    expect(configs.left_click).toEqual({ enabled: false });
    expect(configs.read_page).toEqual({ enabled: true });
    // The field itself is absent, not merely renamed; only the prose note mentioning
    // that it was withheld survives.
    expect(specText(spec)).not.toContain('\\"accountRef\\":');
    expect(specText(spec)).not.toContain('local_demo_profile');
  });

  it('omits the browser toolset entirely when no executor is supplied', async () => {
    const { client, specs } = capturingClient();
    const interpreter = new FableOfferInterpreter(client, { dataDir: mkdtempSync(join(tmpdir(), 'bts-assess-')) });
    await interpreter.assess({ intent: makeIntent(), observation: makeObservation(), evidence: null });
    expect(specs[0]!.tools).toBeUndefined();
    expect(specs[0]!.browserExecutor).toBeUndefined();
  });
});

describe('extractAnnouncement prompt construction (extract.ts)', () => {
  it('always states that the capture time is unknown and marks a user expectation as such', async () => {
    const { client, specs } = capturingClient();
    await extractAnnouncement(client, { evidenceId: 'ev_ann_001', text: 'Restock 42 minutes ago', userExpectedTimeLocal: '13:05' });
    const text = specText(specs[0]!);
    expect(specs[0]!.name).toBe('extract-announcement');
    expect(text).toContain('Capture date/time unknown.');
    expect(text).toContain('a user expectation, not a source confirmation');
  });

  it('uses a distinct task name for a screenshot import', async () => {
    const { client, specs } = capturingClient();
    await extractAnnouncement(client, { evidenceId: 'ev_ann_002', imagePng: Buffer.from('not-a-real-png') });
    expect(specs[0]!.name).toBe('extract-announcement-screenshot');
    expect(specText(specs[0]!)).toContain('Capture date/time unknown.');
  });
});
