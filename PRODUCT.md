# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally (confirmed 2026-09-18):

- The collector: a Singapore Pokemon TCG buyer running one purchase mission from a laptop during the day. Glances back at the screen around the user-observed 13:00-14:00 Asia/Singapore restock window. Wants one item at fair retail price, not a haul.
- Demo audience and evaluators: people watching the system presented on a projector or shared screen. The single main screen must read from across a room and explain the mission, its evidence, and what the system did and did not do.

## Product Purpose

Beat The Scalper (BTS) is a local, single-purchase assistant that helps one person buy one legitimate item (currently a Pokemon Center Elite Trainer Box) from the official seller before scalpers clear it. It watches an official target, interprets announcements and restock alerts as evidence, prepares a checkout when the offer is verified, and stops at a human handoff on live retailers. In `demo` mode it completes a simulated purchase on an owned local storefront through a real browser.

Success: the collector gets the exact intended item, one unit, within budget, from the approved seller, with an evidence timeline that shows why each step happened. A run that stops at `Unknown` and says so is a success of honesty, not a failure.

## Positioning

BTS is the anti-scalper tool: quantity is fixed at one, the seller is verified through a first-party link, packaging conditions and delivered total are shown before any action, and every retailer step on live sites ends at a human. A sniper bot cannot truthfully claim any of that. The deterministic controller owns observation, policy, and execution; the model only interprets evidence and is labelled as such.

## Operating Context

- Runs locally: API on 127.0.0.1:4300, React UI on 5173, demo storefront on 4310, presenter/fault controls on 4311 (not agent-reachable).
- Two modes: `demo` (full simulated purchase on the owned storefront) and `lazada_assist` (observe, optionally prepare, human submits). Live Lazada continuous observation is not validated; live flags are off. See `docs/lazada-feasibility.md`.
- Evidence sources: live observation, manual imports (pasted text, screenshots, shared restock alerts), official announcements. Reference: `fixtures/reference-restock-alerts.png` (no absolute restock time may be invented from it).
- Time: instants stored in UTC, displayed in Asia/Singapore. The 13:00-14:00 window is a user observation, not a fact about the retailer.

## Capabilities and Constraints

- One active mission at a time; mission state machine with locked states around submission; pause and cancel never touch a locked state.
- Dashboard must show (brief section "Dashboard"): mission, launch/source confidence, restock window, last successful observation, next eligible observation, connection health, current action, timeline; controls `Pause`, `Cancel`, `Review conditions`, and the handoff control. One main screen, not chat-first.
- State `Unknown` is a first-class display value. Never use animation as evidence of a successful action.
- Every result is labelled by provenance: `live_verified`, `manual_input`, `demo`, `offline_replay`, `blocked`. Mocked or replayed results are never presented as live.
- Money in integer minor units, SGD. Delivered total shows `Unknown` until delivery is known.
- No real-money submission interface exists anywhere in the codebase.
- Terminology: mission, intent, observation, candidate, attempt, handoff, evidence, provenance, cadence.

## Brand Commitments

- Name: Beat The Scalper, abbreviation BTS.
- Logo: `bts_logo.png` (repo root). Cobalt and royal blue swirls, white spirit figure carrying a glowing cube, warm sun accent, sparkles, ornate serif wordmark. Binding asset.
- Visual inspiration pinned by the user (2026-09-18), held locally and not redistributed: a painterly cream-paper illustration with misty peach gradients, a deep starry teal sky corner, warm orange sun, crescent moon, pine forest bands, and a white stone-tile plaza with terracotta grout. Direction words pinned by the user: "observatory on a paper plaza".
- Explicitly rejected feels (confirmed 2026-09-18): a sneaker-bot or trading-terminal look (dark, neon, dense tickers, urgency); a generic SaaS admin look (stock sidebar, same-size stat cards, template blue buttons).
- No emojis anywhere in the product.
- Voice and tagline: open. Proposals must be labelled as proposals.

## Evidence on Hand

- `fixtures/acceptance-cases.json`: acceptance checklist A01-A26 (not evidence of passing).
- `fixtures/reference-restock-alerts.png`: real shared restock alert screenshot; relative times only.
- `docs/lazada-feasibility.md`: one approved single Lazada read on 2026-09-18 (product i13858018841, seller Pokemon Store Online Singapore, LazMall Flagship, $109.90, Out of stock, wrap-removal notice).
- No testimonials, customer counts, or performance benchmarks exist. Latency numbers exist only after measured demo runs recorded in `docs/evaluation-results.md`.

## Product Principles

1. One item, one person, one honest answer. The interface never suggests buying more or faster than a human would.
2. Evidence before action. Every state on screen is traceable to an observation, an import, or a user decision with a timestamp.
3. Unknown is a value. Show it plainly rather than guessing.
4. Live and demo are never confused. Provenance is visible on every fact.
5. The human owns the last step on real retailers.
