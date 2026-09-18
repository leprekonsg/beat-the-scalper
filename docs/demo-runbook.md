# Demo runbook

A three-minute presenter script for the owned storefront. Everything below is `demo` provenance. No real retailer is touched.

## Before the audience arrives

1. `npm ci && npx playwright install chromium` (first time only).
2. `.env`: `BTS_MODE=demo`. Add `ANTHROPIC_API_KEY` if you want live interpretation; otherwise the band shows "Offline replay" and the flow still completes.
3. Optional accelerated clock so the 13:00-14:00 window is minutes away: in the terminal that runs the API set `BTS_VIRTUAL_CLOCK_START=<today>T04:58:00.000Z` (12:58 Asia/Singapore).
4. `npm start`. Wait for the banner from the API process; copy the session token.
5. Open http://127.0.0.1:5173, paste the token into the band, press Connect.
6. Open the presenter page http://127.0.0.1:4311 in a second window. It is a separate origin the agent cannot reach.

## The story (3 minutes)

**0:00 The empty binder.** The centre pocket says "No card in this pocket". Point at the band: NOW, NEXT CHECK, WINDOW. The window cell says "user observation, not a schedule".

**0:20 Import evidence.** In the Import pocket paste an announcement, or upload `fixtures/reference-restock-alerts.png`. The result table shows each fact with its evidence id, span, and reason. Note the "42 minutes ago" relative age is preserved verbatim and no absolute time is invented. Press "Use in mission".

**0:50 Draft and arm.** Fill the card: product URL `http://127.0.0.1:4310/product/etb-151?variant=en`, retailer id `etb-151`, variant `en`, seller `pokemon-store-online-sg`, max delivered price `120.00`, packaging preference "Ask about stated changes", tick the 13:00-14:00 window, authority "Demo purchase". Save draft, tick "I accept this expiry", Arm. The card flips to WATCHING; the first observation prints in the ledger with Demo provenance. Availability UNAVAILABLE, item price S$99.90, delivered total Unknown, packaging "Stated removed (outer wrap)".

**1:30 The window opens.** Press "To 13:00 SGT" in the Monitor pocket (virtual clock only). The band switches to "In window", the sun rises on the arc, the cadence reads `restock_window_priority`.

**1:45 Presenter publishes a restock.** On the presenter page press "Publish restock: etb-151 / en" (or `POST http://127.0.0.1:4311/admin/stock {"productId":"etb-151","variantId":"en","quantity":5}`). Within two seconds: CANDIDATE, VALIDATING, then PAUSED with an amber review banner because the listing states the outer wrap is removed and the preference was "ask". The eligibility table in the Last observation pocket shows every check and its detail.

**2:15 Human decides.** Press "Accept this stated condition". The card runs PREPARING, CHECKOUT_READY, SUBMISSION_STARTED, ORDER_OBSERVED, COMPLETED. The ledger prints each transition with a time. Show the presenter page: exactly one order. Show the Current action pocket: latency marks filled in, "Observation to ready" measured.

**2:45 What it refuses.** Point at: quantity fixed at 1; delivered total shown as Unknown until known; the provenance legend; the footer line "No real-money submission path exists in this build".

## Fault cases (optional, 30 seconds each)

Use the presenter page or `POST http://127.0.0.1:4311/admin/faults` with a JSON body, then `POST /admin/reset` between cases.

| Fault | Body | What the dashboard shows |
|---|---|---|
| CAPTCHA on product page | `{"captchaOnProduct":true}` | Mission PAUSED, access "CAPTCHA shown", no bypass attempted |
| Rate limit | `{"rateLimitOnProduct":true}` | Access "Rate limited (retry after Ns)", next check honours Retry-After |
| Add to cart fails once | `{"failAddToCartOnce":true}` | Cart re-read, still one line, flow completes with one order |
| Delayed confirmation | `{"delayedConfirmationMs":9500}` | Mission UNKNOWN, no resubmission, reconciliation completes it with one order |

## Interruption controls

- Pause: allowed while watching or validating; refused in locked states (a `stop.refused` line prints).
- Cancel: two-step ("Cancel mission" then "Confirm cancel"); refused in locked and finished states.
- Handoff: appears in HANDOFF_LOCKED and UNKNOWN. Report "I placed the order", "I did not order", or "Still unknown".

## Reset between runs

`POST http://127.0.0.1:4311/admin/reset` clears carts, orders, faults, and scheduled restocks. Cancel or let the previous mission finish before drafting a new one; one active mission at a time.

## Measured runs

`npm run demo:run` executes five measured runs plus the fault and interruption cases in-process and records them in `docs/evaluation-results.json` and `docs/evaluation-results.md`.
