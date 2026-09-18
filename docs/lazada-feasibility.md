# Lazada feasibility gate (Phase 0)

Status summary as of 2026-09-18 (Asia/Singapore):

| Step | Test | Status | Basis for access |
|---|---|---|---|
| 3 | Verify the official seller through the first-party Pokemon SG link | passed | Public first-party page read |
| 4 | Single supervised unauthenticated observation of the user-supplied product URL | passed (single read) | User approval in session: "first access is approved" |
| 4b | Session continuity, repeated observation, rate-limit behaviour | not attempted | Requires a further approval per run; no cadence approved by Lazada |
| 5 | Non-submitting preparation action (login, add to cart) | not attempted | No permission requested or granted; would mutate a real account |

**Gate outcome applied to this build:** live observation is technically feasible for a single read but continuous monitoring is unvalidated. `BTS_LIVE_OBSERVE_ENABLED` and `BTS_LIVE_PREPARE_ENABLED` stay `false`. The live adapter registration in `src/adapters/lazada.ts` returns a `blocked` observation until this document records a passed continuous-observation test and the user sets an explicit reviewed cadence. The live executor has no submission path in any configuration.

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

## Step 5: preparation action

- Status: not attempted. Adding to a real cart requires a logged-in Lazada account and mutates account state. This needs a separate explicit approval, a dedicated logged-in profile created by the user, and a documented non-submitting control. A working page read does not authorise it.

## What this build does with the gate

- `demo` mode: full flow on the owned storefront.
- `lazada_assist` mode: missions can be drafted and armed for manual evidence. The scheduler reports cadence `disabled` and the dashboard shows `Blocked` for live observation. Manual imports (pasted text, screenshots, shared restock alerts) work.
- To enable verified live observation later: run and record a continuous-observation test with user approval, agree an access cadence, set `BTS_LIVE_OBSERVE_ENABLED=true`, `BTS_BASELINE_INTERVAL_SECONDS` and `BTS_PRIORITY_INTERVAL_SECONDS` to the reviewed values (the config rejects the demo values 30/2 for live), and register a validated `LazadaObservationAdapter`. Even then the live path ends at human handoff; no real submission interface exists in this codebase.
