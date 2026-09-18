# Evaluation results

Every row in this file was produced by executing the named script on 2026-09-18. Provenance is stated per section; nothing here was observed on a real retailer.

## Model interpretation (2026-09-18)

Scripts: `npm run smoke:fable` (`scripts/smoke-fable.ts`) and `npm run eval:fable` (`scripts/eval-fable.ts`). Raw records, including model output and request IDs, are appended to `docs/evaluation-results.jsonl`. SDK `@anthropic-ai/sdk` 0.125.0, structured outputs, adaptive thinking.

Acceptance cases the model is responsible for:
- A06: announcement extraction returns facts with spans and never invents a date basis; a screenshot with illegible thumbnails yields null values with stated reasons.
- A09: a stated wrapping-removal notice is surfaced as a packaging condition for policy handling, not silently accepted.

### Live runs

| Time (UTC) | Script | Task | Effort | Model | Result | In / out tokens | Elapsed (ms) | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 12:12:43 | smoke | minimal text | high | claude-opus-5 | PASS | 48 / 4 | 2033 | 0.0003 |
| 12:12:59 | smoke | extract announcement (text) | high | claude-opus-5 | PASS | 124 / 1185 | 15244 | 0.0302 |
| 12:19:24 | eval | extract announcement (text) | high | claude-opus-5 | PASS | 123 / 1189 | 14662 | 0.0303 |
| 12:19:49 | eval | extract announcement (screenshot) | high | claude-opus-5 | PASS | 2392 / 1942 | 25596 | 0.0605 |
| 12:20:01 | eval | extract announcement (text) | medium | claude-opus-5 | PASS | 123 / 982 | 11538 | 0.0252 |
| 12:20:19 | eval | extract announcement (screenshot) | medium | claude-opus-5 | PASS | 2392 / 1401 | 18374 | 0.0470 |
| 12:20:29 | eval | extract announcement (text) | low | claude-opus-5 | PASS | 123 / 818 | 9364 | 0.0211 |
| 12:20:41 | eval | extract announcement (screenshot) | low | claude-opus-5 | PASS | 2392 / 899 | 12080 | 0.0344 |
| 12:21:18 | eval | extract announcement (text) | high | claude-fable-5-1 | PASS | 125 / 1470 | 20807 | 0.0748 |
| 12:21:57 | eval | extract announcement (screenshot) | high | claude-fable-5-1 | PASS | 2394 / 2812 | 39048 | 0.1645 |

A06 and A09 assertions: PASS at every effort level on `claude-opus-5` and at high on `claude-fable-5-1`. Costs use list pricing (Opus 5 $5/$25, Fable 5.1 $10/$50 per MTok) and exclude thinking tokens not reported by the API.

Before 12:12 the live extraction call failed three times with 400 errors; those records remain in the JSONL. Each failure changed the schema design:

| Time (UTC) | API error | Change |
|---|---|---|
| 12:06:39 | `For 'integer' type, properties maximum, minimum are not supported` | `toStructuredOutputSchema` strips unsupported keywords before the call; Zod still validates the parsed result. |
| 12:09:52 | `49 parameters with type arrays or anyOf ... limit: 16` | Replaced the nested per-fact nullable object with a flat `facts[]` wire schema (`AnnouncementExtractionWireSchema`), converted by `announcementFromWire`. |
| 12:11:54 | `The compiled grammar is too large` | Single repeated `facts[]` item shape; missing facts return empty `value`/`span` with a `reason`. |

### Offline replay

`eval-fable` without a key (path `offline_replay`, 11:23 and 11:24 UTC) reproduced the same A06/A09 assertions from `fixtures/replay/*.json` at high, medium and low effort in under 5 ms. Replay output is labelled `offline_replay` in every event and in the dashboard band; it is never presented as live.

## Measured demo runs (2026-09-18)

All rows below are `demo` provenance: an owned, ephemeral demo storefront (ports 0), a real Playwright browser, and the real Worker/Store, timed with the system wall clock. Nothing here calls a real retailer.

Environment: node v22.17.1, playwright 1.63.0, model path: not used. Captured 2026-09-18T12:35:56.454Z UTC / 2026-09-18 20:35 +08:00 Asia/Singapore.

| Run | Kind | Final state | Orders | Signal->ready (ms) | Observation->ready (ms) | Ticks | Wall (ms) | Result |
|---|---|---|---|---|---|---|---|---|
| run-1 | measured | COMPLETED | 1 | 274 | 266 | 2 | 1085 | PASS |
| run-2 | measured | COMPLETED | 1 | 253 | 251 | 2 | 348 | PASS |
| run-3 | measured | COMPLETED | 1 | 251 | 247 | 2 | 332 | PASS |
| run-4 | measured | COMPLETED | 1 | 251 | 248 | 2 | 333 | PASS |
| run-5 | measured | COMPLETED | 1 | 254 | 250 | 2 | 337 | PASS |
| fault-add-to-cart-once | fault_add_to_cart_once | COMPLETED | 1 | 273 | 269 | 2 | 351 | PASS |
| fault-delayed-confirmation | fault_delayed_confirmation | COMPLETED | 1 | 8361 | 8357 | 3 | 8455 | PASS |

Fault case notes:
- `failAddToCartOnce` (A12/A14): addOneToCart called 1 time(s); the completed order's quantity stayed at 1.
- `delayedConfirmationMs` (A19/A20): mission passed through UNKNOWN before reconciliation (yes); submitDemoOrder called 1 time(s) (no blind resubmission).

Full machine-readable detail (per-run latency marks, provenance labels, executor call counts): `docs/evaluation-results.json`.

## Automated test suites (2026-09-18)

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` | 13 files, 282 tests passed |
| `npm run test:e2e` | 11 Playwright tests passed (offline replay, virtual clock, owned demo store) |

Acceptance-case coverage is stamped into `fixtures/acceptance-cases.json` by `python scripts/acceptance-status.py`; all 26 cases are `passed` with the executing test files listed.
