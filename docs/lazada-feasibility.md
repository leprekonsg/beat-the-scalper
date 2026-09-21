# Lazada feasibility gate (Phase 0)

Status summary as of 2026-09-19 15:10 (Asia/Singapore):

| Step | Test | Status | Basis for access |
|---|---|---|---|
| 3 | Verify the official seller through the first-party Pokemon SG link | passed | Public first-party page read |
| 4 | Single supervised unauthenticated observation of the user-supplied product URL | passed (single read, twice: 2026-09-18 and 2026-09-19) | User approval in session per run |
| 4b | Session continuity, repeated observation, rate-limit behaviour | five supervised runs passed 2026-09-19 (03:27-03:35, 03:57-04:04, 04:58-05:17, 05:28-05:55 and 06:03-07:04 UTC): 5, 5, 10, 14 and 30 reads at 120 s from fresh profiles, 65 loads, no challenge; the second with a 2-per-minute limiter and one alert-triggered read 5 s after a scheduled one (see "Live reaction-speed runs"). Earlier the same day the fourth load from the `lazada-probe` profile met a reCAPTCHA. Five clean runs of at most 61 minutes at one cadence are not a validated cadence | User approval in session per run, cadence and read count stated; no cadence approved by Lazada |
| 5 | Non-submitting preparation action (login, add to cart) | not attempted | No permission requested or granted; would mutate a real account |

**Gate outcome applied to this build:** live observation is technically feasible for a single read and for runs of up to 61 minutes at 120 s (five runs, 65 loads, no challenge); a sustained cadence remains unvalidated. `BTS_LIVE_OBSERVE_ENABLED` and `BTS_LIVE_PREPARE_ENABLED` stay `false`. The live adapter registration in `src/adapters/lazada.ts` returns a `blocked` observation until this document records a passed continuous-observation test and the user sets an explicit reviewed cadence. The live executor has no submission path in any configuration.

Every further live access needs a fresh approval from the user before it runs. `scripts/lazada-probe.ts` refuses to start without an `--approved` note for that reason.

## Step 3: first-party seller verification

- Date: 2026-09-18
- Action: fetched `https://sg.portal-pokemon.com/shop/` once and listed outbound links.
- Result: two links to `https://www.lazada.sg/shop/pokemon-store-online-singapore/` (link text "Online Store via Lazada" and "Online Store"), plus `https://www.instagram.com/pokemonofficial.sg/`.
- Approved seller identity for BTS: display name "Pokemon Store Online Singapore", shop path `/shop/pokemon-store-online-singapore/`, LazMall flagship badge observed in step 4. A marketplace seller named "OFFICIAL Cards Hub" or similar does not match this identity.

## Step 4: single supervised observation

- Date and time: 2026-09-18T11:12:44Z to 11:12:52Z (19:12 Singapore time)
- Exact action: one `page.goto` of `https://s.lazada.sg/s.TNMrZ?c=w` in a dedicated headless Chromium profile at `data/.browser-profiles/lazada-probe` (gitignored), locale en-SG, followed by a 4 second wait. No reload, no second request, no login, no cart access, no cookies from any other profile.
- Allowed access basis: the user supplied the URL and approved this first access in the session. No Lazada terms were reviewed as granting automated monitoring; the Platform Engagement Tools terms are scoped to those tools and do not cover this workflow.
- Observed result (redacted evidence in `data/feasibility/lazada-probe-2026-09-18T11-12-44-188Z.json` and `.png`, both gitignored):
  - HTTP 200, no CAPTCHA, login wall, or queue detected.
  - Final URL path: `/products/pokemon-trading-card-game-30th-celebration-pokemon-center-elite-trainer-box-limit-1-per-person-i13858018841-s124858765958.html`. Retailer product id `13858018841`, SKU id `124858765958` as exposed in the URL. Tracking query parameters were present in the redirect and must not be stored as part of the product identity.
  - Title: "Pokémon Trading Card Game: 30th Celebration Pokémon Center Elite Trainer Box [Limit 1 per person]".
  - Seller block: "Pokémon Store Online Singapore", LazMall, Flagship Store. Matches the step 3 identity.
  - Price text: `$109.90` (item price only; delivery fee not shown without a delivery address; delivered total therefore unknown).
  - Availability: "Out of stock" text, quantity input showing 0, no Add to Cart or Buy Now control, only "Add to Wishlist".
  - Product artwork carries the notice "OUTER PLASTIC WRAP WILL BE REMOVED FOR THIS PRODUCT". This is the same product artwork as the first alert in `fixtures/reference-restock-alerts.png`. BTS classifies it as `stated_removed`.
  - Variant selector elements exist in the DOM; only one SKU was visible.
- Status: passed as a single read. It does not establish that repeated polling is permitted or reliable, that an authenticated session persists, or that the layout is stable.

### Second single read (2026-09-19): Gemini interpretation test

- Date and time: 2026-09-18T17:39:43Z to 17:39:51Z (2026-09-19 01:39 Singapore time)
- Approval: user approved in session, one read-only load for the Gemini interpretation test. Same URL, same profile directory, same procedure as above: one `page.goto`, 4 second wait, no reload, no login, no cart. Evidence in `data/feasibility/lazada-probe-2026-09-18T17-39-43-765Z.json` and `.png` (gitignored).
- Observed: HTTP 200, `accessControl: none_detected`, same product id `13858018841` / SKU `124858765958`, seller "Pokémon Store Online Singapore" (LazMall flagship), price `$109.90`, "Out of stock", no Add to Cart or Buy Now control.
- Model step: the captured screenshot and the captured body text were each sent once to `gemini-3.8-flash` (`BTS_MODEL_PROVIDER=gemini`, thinking `low`, `store: false`) through `extractAnnouncement`, with no browser tools. Gemini never touched Lazada; the deterministic probe did.
  - Screenshot (1597 in / 682 out tokens, 4169 ms, $0.0038): product name and format correct, seller "Pokémon Store Online Singapore", purchase limit 1, `releaseDateLocal` null with `dateBasis: unknown` (no date invented), `packagingCondition: stated_removed` with span "OUTER PLASTIC WRAP WILL BE REMOVED FOR THIS PRODUCT" read from the artwork, notes record out of stock at $109.90.
  - Body text (925 in / 663 out tokens, 4463 ms, $0.0032): same product, seller and limit; `packagingCondition: not_stated` with a stated reason, which is correct because the wrap notice exists only in the artwork, not in the DOM text; "Out of stock" surfaced as a stated condition; delivered price listed as missing.
- Status: passed as a second single read. Still does not establish that repeated polling is permitted; step 4b remains not attempted.

### Gemini computer-use observe-only runs (2026-09-19)

Path: `src/agent/geminiComputerUse.ts` (Interactions API `computer_use` tool, browser environment, `store: false`, stateless history, thinking `low`). Gemini may only `scroll`, `move`, `wait`, `take_screenshot`; every other predefined function is excluded from the served tool and rejected again in code before execution. No login, no cart, no clicks of any kind.

Approved runs (user approval in session per run, same URL as above):

| Time (UTC) | Runner | Outcome |
|---|---|---|
| ~20:30 | `npm run test:live:lazada`, fresh Playwright context | Failed before any action: module treated status `requires_action` as an error. One load, 1 model call. Fixed (function-call turns return `requires_action`). |
| ~20:40 | same | Turn 1 executed one scroll; turn 2 rejected by the API with 400 "requires function response to contain an image ... in data.inline_data". One load, 3 model calls (the 400 was retried because the SDK error is not an `ApiError` instance). Root cause isolated on a local page, not on Lazada: `enable_prompt_injection_detection: true` breaks the next turn on `gemini-3.8-flash`. Both fixed. |
| 21:1x | same | PASS in 14.2 s: seller "Pokémon Store Online Singapore", title contains "Elite Trainer Box", availability not unknown, `packagingCondition: stated_removed`, all executed actions in the observe-only set, no incidents, final host lazada.sg. |
| 21:17:12 to 21:17:30 | `npm run lazada:gemini-observe`, persistent probe profile | 3 turns, 2 scrolls, no incidents, 10356 in / 1683 out tokens, 12.9 s, $0.0141. The page showed a reCAPTCHA overlay ("We need to check if you are a robot"). Gemini reported every obscured field as null/unknown, quoted the wrap notice from the visible artwork (`stated_removed`), listed the overlay under `uncertainties`, and made no attempt to interact with it. Evidence: `data/feasibility/lazada-gemini-observe-2026-09-18T21-17-12-270Z.json` and `-turn0..2.png` (gitignored). |

Unapproved access to disclose: during the build, a subagent ran the new script against a made-up `lazada.sg` product path to check argument parsing, not realising a live key was present. One page load (HTTP 404) and one model call occurred; no product page was observed; the artifacts and the JSONL line were removed. Counted here because every live access must be recorded.

Findings:
- The reCAPTCHA appeared on the fourth load of the day from the `lazada-probe` profile (probe at 17:39, the unapproved 404, the three test loads used fresh contexts, then the script at 21:17). Repeated loads from one profile trigger a challenge; this is direct evidence for step 4b and reinforces that no polling cadence is validated.
- The observe-only surface held under a real challenge: with clicks excluded, the model could not "solve" or dismiss the overlay and reported honestly instead.
- Gemini computer use is a feasibility tool only; it is not wired into the worker, and `BTS_LIVE_OBSERVE_ENABLED` stays `false`.

### Live reaction-speed runs (2026-09-19, step 4b)

Runner: `npm run lazada:live-reaction` (`scripts/lazada-live-reaction.ts`) with `src/adapters/lazadaLive.ts` under the real `Worker`, `SystemClock` and `worker.start(1000)`; policy `lazada_assist`, baseline and priority 120 s, 1 observation per origin per minute, `liveObserveEnabled` and the feasibility pass set only in the run's in-memory store; mission authority `observe`; preparation executor refuses every call (asserted never called). Approved by the user in session: cadence 120 s, 5 reads, Gemini interpreter, same URL, fresh profile `lazada-reaction`. Time 03:27:01 to 03:35:33 UTC (11:27 to 11:35 SGT).

| Read | Planned -> started (ms) | Observe (ms) | of which settle wait (ms) | Parse (ms) | Availability | Access control | Gemini assess (ms) |
|---|---|---|---|---|---|---|---|
| 1 | 1009 | 4309 | 4000 | 75 | UNAVAILABLE | none | 3669 |
| 2 | 510 | 4262 | 4000 | 75 | UNAVAILABLE | none | 3930 |
| 3 | 597 | 4285 | 4000 | 82 | UNAVAILABLE | none | 4477 |
| 4 (after imported alert) | 827 | 4260 | 4000 | 71 | UNAVAILABLE | none | 3269 |
| 5 | 589 | 4296 | 4000 | 81 | UNAVAILABLE | none | 3821 |

- Result: 5/5 reads completed, no challenge, no login wall, HTTP 200 each time, seller and title parsed on every read, exit 0. Evidence: `data/feasibility/lazada-live-reaction-2026-09-19T03-27-00-577Z.json` and `reaction-2026-09-19T03-27-00-577Z/evidence/*.png` (gitignored); JSONL row in `docs/evaluation-results.jsonl`.
- Gemini assess (`gemini-3.8-flash`, thinking low) ran on every read as the identical call the worker makes in VALIDATING, made by the script because the item was out of stock and the worker only validates a CANDIDATE; labelled `out_of_band` in the record. All five returned `stated_removed` from the artwork notice.
- Defect found: the alert imported after read 3 was observed 121,489 ms later, at the next cadence tick. The origin limiter (1 per minute) denied the immediate read and the worker re-planned to the full cadence with no event. Fixed the same day: a denial now records `observation.deferred` and schedules the earliest permitted instant (60 s here); a reviewed policy above 1 per minute makes an alert read near-immediate. Re-measured in run 2 below.
- Item not in stock, so CANDIDATE and CHECKOUT_READY were not exercised live. Reaction floor for an unannounced restock at this cadence: 120/2 s mean detection plus about 4.3 s observe plus about 4.5 s interpretation, roughly 69 s. The fixed 4 s settle wait is 93 percent of the observe time.
- Not established by this run: that 120 s is acceptable to Lazada over hours, that a logged-in profile behaves the same, or anything about preparation.

**Run 2** (approved in session: same shape with the deferral fix and a 2-per-minute limiter, `--max-per-minute=2`, fresh profile `lazada-reaction-b`). Time 03:57:51 to 04:04:24 UTC (11:57 to 12:04 SGT).

| Read | Planned -> started (ms) | Observe (ms) | of which settle wait (ms) | Parse (ms) | Availability | Access control | Gemini assess (ms) |
|---|---|---|---|---|---|---|---|
| 1 | 1007 | 7052 | 4000 | 109 | UNAVAILABLE | none | 3578 |
| 2 | 52 | 4228 | 4000 | 53 | UNAVAILABLE | none | 7245 |
| 3 | 804 | 4308 | 4000 | 84 | UNAVAILABLE | none | 4288 |
| 4 (alert imported 35 ms after read 3 completed) | 671 | 4291 | 4000 | 81 | UNAVAILABLE | none | 4089 |
| 5 | 695 | 4301 | 4000 | 85 | UNAVAILABLE | none | 3043 |

- Result: 5/5 reads, no challenge, HTTP 200 each time, exit 0; two loads 5 s apart (reads 3 and 4) drew no challenge. Evidence: `data/feasibility/lazada-live-reaction-2026-09-19T03-57-51-086Z.json` and `reaction-2026-09-19T03-57-51-086Z/evidence/*.png` (gitignored).
- Alert -> observation.started: 671 ms, zero `observation.deferred` events. The deferral fix is confirmed live: the limiter had one stamp in its window, the 2-per-minute policy admitted the read, and the worker started it on its next 1 s tick. Read 5 was then planned 120 s after read 4, as designed.
- Read 1 load took 6.8 s (cold profile, first connection); reads 2 to 5 sat at 4.1 s, the 4 s settle wait plus about 100 ms. Gemini spread widened to 3.0-7.2 s (read 2 outlier); the previous run was 3.3-4.5 s.
- Script defect found and fixed after the run: the alert read's planned instant was reconstructed from a poll sample taken before the import, giving a negative slack; the script now uses the import instant (the worker sets `nextCheckAt = now` synchronously), and the stored record's read 4 `scheduledAt`/`schedulerSlackMs` were recomputed from `signalReceivedAt` (noted in the file under `correction`). No raw timestamp changed.
- Reaction floor at 120 s with these p95s: 60 s + 7.1 s + 7.2 s, about 74 s; on p50s about 68 s. Alert-driven reaction, which is what the restock-alert import path gives, is now bounded by tick plus observe plus assess: under 10 s.
- Still not exercised live: CANDIDATE/CHECKOUT_READY (item out of stock in both runs), sustained cadence beyond 10 minutes, logged-in profile, preparation.

**Run 3** (approved in session for the 13:00-14:00 SGT restock window: 120 s, 10 reads, the script maximum, `--max-per-minute=2`, Gemini, fresh profile `lazada-reaction-c`, no injected alert so a real restock would drive CANDIDATE through the worker path). Time 04:58:15 to 05:17:14 UTC (12:58 to 13:17 SGT), 19 minutes.

| Read | Planned -> started (ms) | Observe (ms) | of which settle wait (ms) | Parse (ms) | Availability | Access control | Gemini assess (ms) |
|---|---|---|---|---|---|---|---|
| 1 | 1012 | 7039 | 4000 | 124 | UNAVAILABLE | none | 3731 |
| 2 | 719 | 4228 | 4000 | 51 | UNAVAILABLE | none | 3584 |
| 3 | 517 | 4234 | 4000 | 56 | UNAVAILABLE | none | 3480 |
| 4 | 709 | 4270 | 4000 | 79 | UNAVAILABLE | none | 3165 |
| 5 | 566 | 4247 | 4000 | 68 | UNAVAILABLE | none | 4091 |
| 6 | 835 | 4256 | 4000 | 72 | UNAVAILABLE | none | 3315 |
| 7 | 602 | 4262 | 4000 | 102 | UNAVAILABLE | none | 3723 |
| 8 | 538 | 4273 | 4000 | 76 | UNAVAILABLE | none | 3507 |
| 9 | 764 | 4271 | 4000 | 100 | UNAVAILABLE | none | 4088 |
| 10 | 531 | 4280 | 4000 | 80 | UNAVAILABLE | none | 3693 |

- Result: 10/10 reads, no challenge, no login wall, HTTP 200 each time, exit 0, `reads_reached`; preparation executor never called. Evidence: `data/feasibility/lazada-live-reaction-2026-09-19T04-58-14-958Z.json` and `reaction-2026-09-19T04-58-14-958Z/evidence/*.png` (gitignored).
- No restock during the window covered (12:58 to 13:17 SGT): the item stayed UNAVAILABLE on all ten reads, so the mission stayed WATCHING and CANDIDATE/VALIDATING/CHECKOUT_READY were again not exercised through the worker path. Gemini assess ran out of band on every read and returned `stated_removed` ten times out of ten.
- Cold-profile first load again 6.8 s; reads 2 to 10 at 4.08 to 4.10 s load. Gemini 3.2 to 4.1 s, tighter than run 2. Scheduler slack p50 602 ms, p95 1012 ms (the 1 s tick bound).
- Reaction floor at 120 s on p95s: 60 s + 7.0 s + 4.1 s, about 71 s.
- Cumulative 2026-09-19 exposure from fresh profiles: 20 loads at 120 s across three runs (10, 10 and 19 minutes), no challenge. The probe profile's reCAPTCHA earlier in the day remains the only challenge seen and came from a different profile and access pattern.
- Still not exercised live: CANDIDATE/CHECKOUT_READY (item out of stock in all three runs), a run longer than 19 minutes, logged-in profile, preparation.

**Run 4** (approved in session: "watch till 2pm and notify on restock"; 120 s, 14 reads, `--max-per-minute=2`, Gemini, profile `lazada-reaction-d`, no injected alert). Time 05:28:28 to 05:55:40 UTC (13:28 to 13:56 SGT), 27 minutes. The `--reads` cap was raised from 10 to 15 for this run, and the script now prints one progress line per read on stderr so a supervisor can watch it. A first start of this run (13:27:35 SGT, same profile) was stopped after 48 s, one load, to add that progress line; that load is not in the record, so the profile made 15 loads, not 14.

- Result: 14/14 reads, no challenge, HTTP 200 each time, exit 0, `reads_reached`; preparation executor never called. Every read UNAVAILABLE, `stated_removed`, mission WATCHING throughout: no restock between 13:28 and 13:56 SGT. Evidence: `data/feasibility/lazada-live-reaction-2026-09-19T05-28-27-280Z.json` and `reaction-2026-09-19T05-28-27-280Z/evidence/*.png` (gitignored).
- Slack p50/p95 519/1010 ms; observe 4278/4340 ms (no cold-load outlier: the profile had already connected during the aborted start; loads 4068 to 4112 ms); parse p95 104 ms; Gemini p50/p95 3644/6419 ms; floor about 71 s.
- Cumulative 2026-09-19 from fresh profiles: 35 loads at 120 s across four runs (10, 10, 19 and 27 minutes) plus the one aborted load, no challenge. The restock window 12:58 to 13:56 SGT produced no AVAILABLE read, so the worker-path CANDIDATE -> VALIDATING -> CHECKOUT_READY transition still has no live measurement.
- Still not exercised live: CANDIDATE/CHECKOUT_READY, a run longer than 27 minutes, logged-in profile, preparation.

**Run 5** (approved in session: "restock timing has changed today, continue to monitor for another hour"; 120 s, 30 reads, `--max-per-minute=2`, Gemini, fresh profile `lazada-reaction-e`, no injected alert). Time 06:03:35 to 07:04:10 UTC (14:03 to 15:04 SGT), 61 minutes. The `--reads` cap was raised from 15 to 30 so one hour fits in a single run. Launched with `nohup ... &` from Git Bash rather than PowerShell `Start-Process` (the latter was refused by the session's permission classifier); same script, same arguments.

- Result: 30/30 reads, no challenge, HTTP 200 each time, exit 0, `reads_reached`; preparation executor never called. Every read UNAVAILABLE, `stated_removed`, mission WATCHING throughout: no restock between 14:03 and 15:04 SGT. Evidence: `data/feasibility/lazada-live-reaction-2026-09-19T06-03-34-476Z.json` and `reaction-2026-09-19T06-03-34-476Z/evidence/*.png` (gitignored).
- Slack p50/p95 584/906 ms (max 1015); observe 4280/4326 ms (read 1 cold profile 7027 ms; reads 2 to 30 load 4078 to 4166 ms); parse p95 98 ms; Gemini p50/p95 4119/6340 ms (max 11554 ms, one outlier); floor about 71 s.
- Cumulative 2026-09-19 from fresh profiles: 65 loads at 120 s across five runs (10, 10, 19, 27 and 61 minutes) plus one aborted load, no challenge. The window 12:58 to 15:04 SGT (one 11-minute gap, 13:17 to 13:28) produced no AVAILABLE read, so the worker-path CANDIDATE -> VALIDATING -> CHECKOUT_READY transition still has no live measurement.
- Still not exercised live: CANDIDATE/CHECKOUT_READY, a run longer than 61 minutes, logged-in profile, preparation.

**Run 6** (approved in session 2026-09-21, "yes do the live run": 120 s, 5 reads, `--max-per-minute=2`, `--provider=none`, fresh profile `lazada-reaction-f`; purpose: verify the buy-box selectors and measure the readiness wait that replaced the fixed 4 s settle). Time 02:16 to 02:25 UTC (10:16 to 10:25 SGT). Record `data/feasibility/lazada-live-reaction-2026-09-21T02-16-05-005Z.json` (gitignored).

| Metric | p50 | p95 | n |
| --- | --- | --- | --- |
| Scheduler slack | 716 ms | 1010 ms | 5 |
| Observe (one goto, readiness wait, parse) | 1770 ms | 6064 ms (read 1, cold profile) | 5 |
| Readiness wait (container visible) | 1133 ms | 2029 ms | 5 |
| Parse only | 366 ms | 982 ms | 5 |

- 5/5 reads HTTP 200, no challenge, executor never called. `buyBoxSelector` was `#module_add_to_cart` on every read (first candidate to match), `readiness` `buy_box` on every read.
- Defect: availability was UNKNOWN on all 5 reads where UNAVAILABLE was correct (screenshots show "Out of stock"). `#module_add_to_cart` holds only the button area, not the quantity line that carries the stock text. On 2 of 5 reads the stock text was also absent from the body text at parse time although present in the screenshot taken moments later: the container renders before the stock line does, so "container visible" is not "state observable". No false candidate was possible (UNKNOWN to AVAILABLE still raises one), but the claim was weaker than before.

**DOM diagnostic** (approved in session 2026-09-21, "go": one load, `scripts/lazada-probe.ts --dom-diagnostic`, fresh profile `lazada-probe-c`, 02:44 UTC; a first attempt on profile `lazada-probe-b` at 02:28 UTC loaded the page but failed before recording anything because tsx injects a `__name` helper into functions passed to `page.evaluate`; the script now passes the DOM walk as a source string). Record `data/feasibility/lazada-probe-2026-09-21T02-44-52-099Z.json` (gitignored). Verified structure of the product panel:

- Buy box: `div.pdp-block.pdp-v2-block__product-detail` (its id is a random `block-...`). Children in order: `#module_product_title_1` (h1), `#module_product_price_v2` ("$109.90"), `#module_seller_warranty`, `#module_sku-select`, `#module_quantity-input` ("Quantity: Out of stock"), `#module_add_to_cart` (`.pdp-cart-concern-v2 > .pdp-cart-concern-btn > button.add-to-cart-buy-now-btn`; out of stock, the only button is "Add to Wishlist", which carries the same class as the purchase buttons).
- `_mini` duplicates (`#module_quantity-input_mini`, `#module_add_to_cart_mini`, `#module_product_price_v2_mini`) exist for a sticky bar and are empty. `#module_product_detail` is the description block lower on the page, not the buy box. The first DOM match of `[class*="pdp-price"]` never became visible within 4 s although the visible price was read fine, so waits must target decisive elements, not broad selectors.
- Landmark visibility after domcontentloaded: h1 2150 ms, stock text 2410 ms, wishlist button 2409 ms, `#module_add_to_cart` 2428 ms. Body text 5679 chars, stock text at offset 658.

Adapter after the diagnostic: `BUY_BOX_SELECTORS` is `.pdp-v2-block__product-detail` with `[class*="block__product-detail"]` as the only fallback; readiness waits for a decisive element inside the buy box (`#module_quantity-input` containing "out of stock"/"sold out", or an "Add to Cart"/"Buy Now" button in `#module_add_to_cart`), recorded as `readiness: 'decisive' | 'timeout'`; a clean page without the buy box is `unsupported_layout` (UNKNOWN), no page-wide fallback; a present-but-disabled purchase button is UNKNOWN; a "From" or range price is a null price with the raw text kept in evidence.

**Run 7** (approved in session 2026-09-21, "yes go ahead": 60 s, 3 reads, `--provider=none`, fresh profile `lazada-rerun-a`; purpose: re-measure the verified selectors and the decisive readiness wait). Time 03:00 to 03:02 UTC (11:00 to 11:02 SGT). Record `data/feasibility/lazada-live-reaction-2026-09-21T03-00-26-104Z.json` (gitignored).

| metric | p50 | p95 / max |
| --- | --- | --- |
| scheduler slack | 651 ms | 1004 ms |
| observe | 1908 ms | 5274 ms |
| readiness | 1523 ms | 1929 ms |
| parse | 90 ms | 187 ms |

- 3/3 reads HTTP 200, no challenge, executor never called. Availability `UNAVAILABLE` on every read, which the screenshots confirm; the Run 6 defect (UNKNOWN on an out-of-stock page) is gone.
- `buyBoxSelector` was `.pdp-v2-block__product-detail` on every read, `readiness` `decisive` on every read, `soldOutTextOutsideBuyBox` false on every read. No timeout, so the hydration lag seen in Run 6 is now absorbed by the wait rather than mis-parsed.
- Readiness is about 1.5 s of the 1.9 s median observe, and the first read paid a cold-profile load (5.1 s). Parse stayed under 200 ms because the scoped rules read three small modules instead of the whole body.

## Step 5: preparation action

- Status: not attempted. Adding to a real cart requires a logged-in Lazada account and mutates account state. This needs a separate explicit approval, a dedicated logged-in profile created by the user, and a documented non-submitting control. A working page read does not authorise it.

## What this build does with the gate

- `demo` mode: full flow on the owned storefront.
- `lazada_assist` mode: missions can be drafted and armed for manual evidence. The scheduler reports cadence `disabled` and the dashboard shows `Blocked` for live observation. Manual imports (pasted text, screenshots, shared restock alerts) work.
- To enable verified live observation later: run and record a continuous-observation test with user approval, agree an access cadence, set `BTS_LIVE_OBSERVE_ENABLED=true`, `BTS_BASELINE_INTERVAL_SECONDS` and `BTS_PRIORITY_INTERVAL_SECONDS` to the reviewed values (the config rejects the demo values 30/2 for live), and pass `src/adapters/lazadaLive.ts` (`LazadaLiveObservationAdapter`, used only by the supervised harnesses today) as the `live` dependency of `LazadaObservationAdapter` in `src/server/wiring.ts`, which currently passes nothing. Even then the live path ends at human handoff; no real submission interface exists in this codebase.
