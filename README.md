<p align="center">
  <img src="bts_logo.png" alt="Beat The Scalper logo: a white spirit figure carrying a glowing cube through cobalt swirls under a warm sun" width="260">
</p>

<h1 align="center">Beat The Scalper</h1>

<p align="center">One item, one person, one honest board.</p>

---

Beat The Scalper (BTS) is a local-first assistant that helps one person buy one legitimate item from the official seller before scalpers clear it. It watches an owned demo storefront (or, behind a feasibility gate, a Lazada listing), interprets announcements and restock alerts as evidence, prepares a checkout when the offer is verified, and stops at a human handoff on real retailers.

Quantity is fixed at 1, the seller must match a first-party link, and packaging conditions and the delivered total are shown before any action. No real-money submission path exists in this codebase. A run that ends at `Unknown` and says so is an honest result, not a failure.

## The dashboard

![BTS dashboard in demo mode: a cream paper board with the mission card centred, monitor health and launch evidence on the left, last observation and current action on the right, and the event ledger across the bottom](docs/screenshots/dashboard-watching.png)

One screen, no chat. The mission sits in the centre pocket with its state, provenance, item price, delivered total against budget, packaging condition, purchase limit, and the restock window arc. Every fact carries a provenance chip, `Unknown` is printed rather than hidden, and the ledger prints each state change with a timestamp. Captured in `demo` mode against the owned storefront under the accelerated demo clock.

## Requirements

- Node 22.13 or newer (uses `node:sqlite`). Developed on 22.17.1.
- npm 11. Dependencies are pinned exactly; `npm ci` respects the lockfile.
- Playwright Chromium: `npx playwright install chromium` once.
- Optional: `ANTHROPIC_API_KEY` in `.env` for live model interpretation. Without it the model path runs as labelled `offline_replay` from `fixtures/replay/*.json`.

## Setup

```bash
npm ci
npx playwright install chromium
cp .env.example .env        # then add ANTHROPIC_API_KEY=... if you have one
```

`.env` is gitignored. Never commit it.

## Run the demo stack

```bash
npm start
```

Starts three processes:

| Process | URL | Purpose |
|---|---|---|
| demo store | http://127.0.0.1:4310 | Owned storefront the agent may touch |
| presenter / admin | http://127.0.0.1:4311 | Restock, faults, orders. Separate origin; the agent cannot reach it |
| BTS API | http://127.0.0.1:4300 | Local API. Requires the session token printed at startup |
| dashboard | http://127.0.0.1:5173 | React UI (Vite dev server, proxies `/api/` to 4300) |

Paste the session token (also written to `data/session-token`) into the band at the top of the dashboard. A full presenter walkthrough is in [docs/demo-runbook.md](docs/demo-runbook.md).

Accelerated demo clock: set `BTS_VIRTUAL_CLOCK_START=2026-09-18T04:58:00.000Z` (12:58 Asia/Singapore) before `npm run server` to get the "+1 min / +10 min / To 13:00 SGT" controls in the Monitor pocket.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over src, demo, tests, scripts |
| `npm test` | Vitest unit + integration suites (domain, storage, worker, agent client, browser executor, demo store HTTP and Playwright adapter) |
| `npm run test:e2e` | Playwright browser tests; boots its own stack on 4300/4310/4311/5173 with the model key blanked (offline replay) and refuses to start if those ports are busy |
| `python scripts/acceptance-status.py [--e2e]` | Stamps `fixtures/acceptance-cases.json` from executed test titles; run after the suites pass |
| `npm run demo:run` | Five measured demo runs plus fault and interruption cases; writes `docs/evaluation-results.json` and appends to `docs/evaluation-results.md` |
| `npm run smoke:fable` | Phase 0 model smoke test (live if a key exists, else exits 2) |
| `npm run eval:fable` | Extraction evaluation across effort levels; appends to a local `docs/evaluation-results.jsonl` |
| `npx tsx scripts/capture-ui.ts` | Boots the stack, arms a mission, screenshots the dashboard into a local capture directory |
| `npx tsx scripts/lazada-probe.ts --url=<lazada url> --approved "<note>"` | One supervised read-only Lazada observation. Refuses to run without an approval note |

## Layout

```
src/domain/      schemas (Zod), money, time (UTC + Asia/Singapore windows), state machine, eligibility policy, scheduling
src/storage/     node:sqlite store: missions, events, attempts, evidence, observations, settings
src/worker/      deterministic controller: scheduling, observation, validation, preparation, submission boundaries, reconciliation
src/adapters/    demo store Playwright adapter/executor (origin allowlisted); Lazada adapter blocked by the feasibility gate
src/agent/       Anthropic SDK client (history integrity, structured output, offline replay), restricted browser toolset, extraction, assessment
src/server/      local HTTP API (token + Origin checks), wiring, entry point
src/ui/          React dashboard, "Binder Page" design
demo/store/      owned storefront + presenter/admin origin with faults
prompts/         runtime prompts for extraction and assessment
fixtures/        acceptance cases, reference alert screenshot and notes, offline replay fixtures
scripts/         smoke, eval, demo runs, UI capture, Lazada probe
tests/           unit, integration (HTTP + Playwright), e2e
docs/            feasibility record, runbook, screenshots, evaluation results
```

Scope, audiences, and brand commitments are in [PRODUCT.md](PRODUCT.md); the design system as shipped is recorded in [DESIGN.md](DESIGN.md). The acceptance checklist is [fixtures/acceptance-cases.json](fixtures/acceptance-cases.json), cases A01-A26; it lists what must pass, not what has passed.

## Modes and gates

- `demo`: full simulated purchase on the owned storefront through a real Chromium. Quantity is fixed at 1, the seller must match, packaging conditions are surfaced before any action, and the delivered total shows `Unknown` until delivery is known.
- `lazada_assist`: missions can be drafted and armed; live observation stays `Blocked` until [docs/lazada-feasibility.md](docs/lazada-feasibility.md) records a passed continuous-observation test and the user sets a reviewed cadence. The live path ends at human handoff. Every live access needs explicit approval first.
- The model interprets evidence only. The deterministic controller owns observation, policy, and execution; model output can resolve an unknown into a concrete condition that code re-checks, never authorise a purchase.

## Provenance labels

Every fact on screen carries one of five labels, and a mocked or replayed result is never presented as live:

| Label | Meaning |
|---|---|
| `live_verified` | Read from the real retailer during an approved access |
| `manual_input` | Pasted text, an imported screenshot, or a shared alert |
| `demo` | Produced by the owned local storefront |
| `offline_replay` | Produced from recorded fixtures with no model call |
| `blocked` | The step was refused, gated, or unreachable |

Money is stored in integer minor units (SGD). Instants are stored in UTC and displayed in Asia/Singapore. The 13:00-14:00 SGT restock window is a user observation, not a fact about the retailer.

## Security notes

- API writes require `X-BTS-Token` (random per boot, tab-scoped in the UI) and an allowed `Origin`. No wildcard CORS.
- Event payloads are redacted for credential-like keys before persistence.
- The demo executor aborts any request to a non-store origin at the network layer. The presenter origin is never reachable from the agent.
- The repository ships no credentials, API key, browser profile, or payment data.

## Built with Claude

BTS was designed and implemented with [Claude Code](https://claude.com/claude-code). The Anthropic model configured in `.env` also runs inside the product, where its only job is interpreting evidence: extracting facts from announcements and screenshots, and assessing whether an offer matches the mission. It never drives the browser, the policy, or a purchase.

## License

[MIT](LICENSE).

Pokemon and Pokemon Center are trademarks of their respective owners. This project is unaffiliated with them, with Lazada, and with any retailer. The storefront in `demo/store` is an owned local simulation written for this repository.
