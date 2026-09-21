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

### Gemini provider (2026-09-19)

`BTS_MODEL_PROVIDER=gemini` routes the same extraction and assessment tasks to `gemini-3.8-flash` through the Interactions API (`store: false`, thinking level `low` by default), SDK `@google/genai` 2.22.0. Scripts: `npm run smoke:gemini`, `npm run eval:gemini -- --effort low,medium,high`. Raw records are in `docs/evaluation-results.jsonl` with `provider: "gemini"`. Same synthetic announcement and reference screenshot as the Anthropic rows above.

| Time (UTC) | Script | Task | Thinking | Model | Result | In / out tokens | Elapsed (ms) | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 17:33:36 | smoke | minimal text | low | gemini-3.8-flash | PASS | 29 / 1 | 4315 | 0.0000 |
| 17:33:39 | smoke | extract announcement (text) | low | gemini-3.8-flash | PASS | 554 / 600 | 3198 | 0.0027 |
| 17:34:54 | eval | extract announcement (text) | low | gemini-3.8-flash | PASS | 554 / 571 | 3468 | 0.0026 |
| 17:35:00 | eval | extract announcement (screenshot) | low | gemini-3.8-flash | PASS | 1587 / 752 | 5612 | 0.0040 |
| 17:35:12 | eval | extract announcement (text) | medium | gemini-3.8-flash | PASS | 554 / 1704 | 12252 | 0.0068 |
| 17:35:20 | eval | extract announcement (screenshot) | medium | gemini-3.8-flash | PASS | 1587 / 1995 | 8342 | 0.0087 |
| 17:35:32 | eval | extract announcement (text) | high | gemini-3.8-flash | PASS | 554 / 3121 | 11183 | 0.0121 |
| 17:35:55 | eval | extract announcement (screenshot) | high | gemini-3.8-flash | PASS | 1587 / 7658 | 23180 | 0.0299 |

A06 and A09 assertions: PASS at low, medium and high thinking on `gemini-3.8-flash`. Output tokens include thought tokens: a direct probe of the raw `usage` object confirmed `total_tokens = total_input_tokens + total_output_tokens + total_thought_tokens` (705 = 14 + 54 + 637 at high), so the client adds `total_thought_tokens` to output without double-counting. Costs use introductory pricing ($0.75 in / $3.75 out per MTok through 2026-12-31).

Live Lazada capture (2026-09-19, one approved read-only load, see `docs/lazada-feasibility.md`): the probe's screenshot and body text were each sent once to Gemini through `extractAnnouncement` with no tools.

| Time (UTC) | Input | Thinking | Result | In / out tokens | Elapsed (ms) | Cost (USD) |
|---|---|---|---|---|---|---|
| 17:41 | Lazada probe screenshot | low | PASS: seller, product, limit 1, `stated_removed` with exact span, no invented date | 1597 / 682 | 4169 | 0.0038 |
| 17:41 | Lazada probe body text | low | PASS: seller, product, limit 1, `not_stated` with reason (notice is artwork-only), out of stock surfaced | 925 / 663 | 4463 | 0.0032 |

Gemini computer use, observe-only (2026-09-19, `src/agent/geminiComputerUse.ts`, thinking low, `store: false`), approved live runs on the same Lazada URL:

| Time (UTC) | Runner | Turns | Actions | Incidents | In / out tokens | Elapsed (ms) | Cost (USD) | Result |
|---|---|---|---|---|---|---|---|---|
| ~21:10 | `npm run test:live:lazada` | <= 8 | scroll only | none | not persisted (the Playwright list reporter keeps only the assertion result) | 14200 (whole test) | not computed | PASS: seller, title, availability, `stated_removed`, host stayed lazada.sg |
| 21:17 | `npm run lazada:gemini-observe` | 3 | scroll x2 | none | 10356 / 1683 | 12852 | 0.0141 | Honest partial: reCAPTCHA overlay; nulls for obscured fields, `stated_removed` from visible artwork, overlay listed under uncertainties |

Two earlier attempts failed on client defects found only live (`requires_action` status on tool turns; `enable_prompt_injection_detection` causing a 400 on the next turn); both fixed and covered by unit tests. Details in `docs/lazada-feasibility.md`.

Against `claude-opus-5` at low effort on the screenshot task (12080 ms, $0.0344), Gemini at low thinking took 5612 ms for $0.0040 with the same A06/A09 outcome. Timings are single runs on one network, not benchmarks.

## Live reaction speed on Lazada (2026-09-19)

The demo-store rows above measure the executor floor on localhost, not reaction: the restock signal was hand-fed and the ticks were script-driven. Reaction speed is now measured live only, under the real `Worker` and real scheduler (`worker.start(1000)`, `SystemClock`), observe-only, approval-gated: `npm run lazada:live-reaction` (`scripts/lazada-live-reaction.ts`, adapter `src/adapters/lazadaLive.ts`). Full record and caveats in `docs/lazada-feasibility.md`, "Live reaction-speed runs".

Run 1, 03:27 to 03:35 UTC, cadence 120 s, 5 reads, fresh profile, 1 observation per origin per minute, `gemini-3.8-flash` thinking low, alert imported after read 3. Provenance `live_verified` for observations; model calls live.

| Metric | p50 | p95 | n |
|---|---|---|---|
| Scheduler slack, planned -> observation.started | 597 ms | 1009 ms | 5 |
| Observe (one goto, 4 s settle, parse) | 4285 ms | 4309 ms | 5 |
| Parse only | 75 ms | 82 ms | 5 |
| Gemini assess on the live screenshot | 3821 ms | 4477 ms | 5 |
| Alert -> observation.started | 121489 ms | | 1 |
| Reaction floor at 120 s cadence (cadence/2 + p95s) | 68.8 s | | |

- The alert row is the defect: with the policy's 1 observation per origin per minute, the limiter denied the immediate read and the worker fell back to the full cadence. Fixed in `src/worker/worker.ts` (`observation.deferred`, earliest permitted instant); re-measured in run 2.

Run 2, 03:57 to 04:04 UTC, same shape with the fix and `--max-per-minute=2`, fresh profile.

| Metric | p50 | p95 | n |
|---|---|---|---|
| Scheduler slack, planned -> observation.started | 695 ms | 1007 ms | 5 |
| Observe (one goto, 4 s settle, parse) | 4301 ms | 7052 ms (read 1, cold profile) | 5 |
| Parse only | 84 ms | 109 ms | 5 |
| Gemini assess on the live screenshot | 4089 ms | 7245 ms | 5 |
| Alert -> observation.started | 671 ms | | 1 |
| observation.deferred events | 0 | | |
| Reaction floor at 120 s cadence (cadence/2 + p95s) | 74.3 s | | |

- Alert lag went from 121,489 ms to 671 ms with zero deferrals: the fix holds live. Two loads 5 s apart drew no challenge.
- Read 4's planned instant was mis-reconstructed by the script (stale poll sample, slack -119,295 ms); fixed in the script and recomputed in the stored record from the import instant, noted there under `correction`.

Run 3, 04:58 to 05:17 UTC (12:58 to 13:17 SGT, the restock window), cadence 120 s, 10 reads, `--max-per-minute=2`, fresh profile, no injected alert.

| Metric | p50 | p95 | n |
|---|---|---|---|
| Scheduler slack, planned -> observation.started | 602 ms | 1012 ms | 10 |
| Observe (one goto, 4 s settle, parse) | 4262 ms | 7039 ms (read 1, cold profile) | 10 |
| Parse only | 78 ms | 124 ms | 10 |
| Gemini assess on the live screenshot | 3584 ms | 4091 ms | 10 |
| Reaction floor at 120 s cadence (cadence/2 + p95s) | 71.1 s | | |

- No restock occurred in the covered window; the item was UNAVAILABLE on every read, so the worker path never left WATCHING and validation was not measured. No challenge in 10 loads.

Run 4, 05:28 to 05:55 UTC (13:28 to 13:56 SGT), cadence 120 s, 14 reads, `--max-per-minute=2`, no injected alert, supervised by a log monitor for a restock.

| Metric | p50 | p95 | n |
|---|---|---|---|
| Scheduler slack, planned -> observation.started | 519 ms | 1010 ms | 14 |
| Observe (one goto, 4 s settle, parse) | 4278 ms | 4340 ms | 14 |
| Parse only | 80 ms | 104 ms | 14 |
| Gemini assess on the live screenshot | 3644 ms | 6419 ms | 14 |
| Reaction floor at 120 s cadence (cadence/2 + p95s) | 70.8 s | | |

- No restock in the window; 14 of 14 reads UNAVAILABLE, no challenge. One extra load from the same profile came from an aborted first start (see `docs/lazada-feasibility.md`).

Run 5, 06:03 to 07:04 UTC (14:03 to 15:04 SGT), cadence 120 s, 30 reads, `--max-per-minute=2`, fresh profile, no injected alert, supervised by a log monitor for a restock.

| Metric | p50 | p95 | n |
|---|---|---|---|
| Scheduler slack, planned -> observation.started | 584 ms | 906 ms | 30 |
| Observe (one goto, 4 s settle, parse) | 4280 ms | 4326 ms (read 1, cold profile, 7027 ms max) | 30 |
| Parse only | 79 ms | 98 ms | 30 |
| Gemini assess on the live screenshot | 4119 ms | 6340 ms (max 11554 ms) | 30 |
| Reaction floor at 120 s cadence (cadence/2 + p95s) | 70.7 s | | |

- No restock in the window; 30 of 30 reads UNAVAILABLE, no challenge in 30 loads over 61 minutes. Longest single-profile run so far.
- The item was out of stock throughout, so validation and CHECKOUT_READY were not reached live; the Gemini timing is the identical assess call made by the script on each read and is labelled `out_of_band` in the record.
- Costs: about $0.004 per Gemini call, one call per read (64 calls across the five runs).

## Automated test suites (2026-09-19)

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` | 19 files, 462 tests passed |
| `npm run test:e2e` | 11 Playwright tests passed (offline replay, virtual clock, owned demo store, both model keys blanked) |

Acceptance-case coverage is stamped into `fixtures/acceptance-cases.json` by `python scripts/acceptance-status.py`; all 26 cases are `passed` with the executing test files listed.
