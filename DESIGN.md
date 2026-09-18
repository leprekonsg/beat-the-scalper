---
name: Beat The Scalper
description: A collector's binder page on cream grained paper; one deep-teal starry band, cobalt as the only action colour.
colors:
  paper: "#f3ebdd"
  paper-deep: "#ebe1cf"
  pocket: "#f9f4ea"
  slab: "#fffdf8"
  ink: "#221d18"
  ink-2: "#4e4740"
  ink-3: "#6b5f52"
  grout: "rgba(196, 121, 90, 0.45)"
  grout-strong: "rgba(196, 121, 90, 0.8)"
  terracotta: "#c4795a"
  night: "#234e56"
  night-deep: "#1a3d44"
  night-text: "#e9f1ee"
  night-muted: "#a8c2bd"
  cobalt: "#1e4dd8"
  cobalt-deep: "#173fb3"
  cobalt-tint: "#e3e9fb"
  amber: "#e8892b"
  amber-deep: "#a85a12"
  amber-tint: "#fbead6"
  pine: "#3e6b54"
  pine-tint: "#e2ece5"
  brick: "#9c3b22"
  brick-tint: "#f4e0d9"
  graphite: "#4b5258"
  graphite-tint: "#e8e6e1"
typography:
  display:
    fontFamily: "Marcellus, Iowan Old Style, Georgia, serif"
    fontSize: "1.625rem"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Marcellus, Iowan Old Style, Georgia, serif"
    fontSize: "1.35rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.04em"
  body:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.1em"
  mono:
    fontFamily: "Source Code Pro Variable, Source Code Pro, ui-monospace, Consolas, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  chip:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, Segoe UI, system-ui, sans-serif"
    fontSize: "0.74rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.02em"
rounded:
  r-1: "4px"
  r-2: "6px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  gutter: "24px"
  page-y: "28px"
  page-x: "32px"
components:
  button-default:
    backgroundColor: "{colors.slab}"
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "0 14px"
    height: "34px"
  button-primary:
    backgroundColor: "{colors.cobalt}"
    textColor: "#ffffff"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "0 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-deep}"
    textColor: "#ffffff"
  button-amber:
    backgroundColor: "{colors.amber}"
    textColor: "#241505"
    rounded: "{rounded.r-2}"
    padding: "0 14px"
    height: "34px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.brick}"
    rounded: "{rounded.r-2}"
    padding: "0 14px"
    height: "34px"
  button-danger-hover:
    backgroundColor: "{colors.brick-tint}"
    textColor: "{colors.brick}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.cobalt-deep}"
    rounded: "{rounded.r-2}"
    padding: "0 14px"
    height: "34px"
  button-ghost-hover:
    backgroundColor: "{colors.cobalt-tint}"
    textColor: "{colors.cobalt-deep}"
  chip-teal:
    backgroundColor: "{colors.pine-tint}"
    textColor: "{colors.pine}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-amber:
    backgroundColor: "{colors.amber-tint}"
    textColor: "{colors.amber-deep}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-brick:
    backgroundColor: "{colors.brick-tint}"
    textColor: "{colors.brick}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-blue:
    backgroundColor: "{colors.cobalt-tint}"
    textColor: "{colors.cobalt-deep}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-charcoal:
    backgroundColor: "{colors.graphite-tint}"
    textColor: "{colors.graphite}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-neutral:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink-2}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  pocket:
    backgroundColor: "{colors.pocket}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r-2}"
    padding: "18px 20px 20px"
  pocket-card:
    backgroundColor: "{colors.slab}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r-2}"
    padding: "0"
  slab-cell:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    padding: "12px 18px 10px"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.r-2}"
    padding: "7px 10px"
  input-disabled:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink-3}"
  banner-error:
    backgroundColor: "{colors.brick-tint}"
    textColor: "{colors.brick}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "9px 12px"
  banner-info:
    backgroundColor: "{colors.cobalt-tint}"
    textColor: "{colors.cobalt-deep}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "9px 12px"
  banner-review:
    backgroundColor: "{colors.amber-tint}"
    textColor: "{colors.amber-deep}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "9px 12px"
  band:
    backgroundColor: "{colors.night}"
    textColor: "{colors.night-text}"
    padding: "16px 32px"
    height: "88px"
---

# Design System: Beat The Scalper

## Overview

**Creative North Star: "The Binder Page"**

The dashboard is one page of a collector's trading-card binder laid on a stone plaza. Cream grained paper is ruled into pockets by terracotta hairlines; every pocket carries a faint clear-sleeve highlight at its top-left corner; the mission is the card in the centre pocket, wearing a white grading-slab label with three cells (State, Provenance, Evidence age). A single deep-teal starry band across the top holds the logo, the wordmark, and the observatory clock. Nothing is dark below the band, nothing scrolls as a ticker, and no two pockets are the same size.

Colour carries meaning, not decoration: cobalt is the only action colour and the current-state marker; amber appears only at review, handoff, and as the sun on the restock arc; pine marks eligible and completed; brick marks blocked and failure; graphite is the resting sun and offline replay. Type is three faces with fixed jobs: Marcellus for the card title, wordmark, and empty-pocket note; Source Sans 3 for all interface text; Source Code Pro with tabular numerals for every timestamp, money value, and identifier.

Density is calm and evidential. Labels are small uppercase tracked captions in warm ink; values sit below them in body or mono. Motion is one gesture (a 180 ms ease-out pocket lift) plus a slow heartbeat dot, both switched off under reduced-motion. Depth is a single soft teal-tinted lift that only appears on hover or focus.

Finish review status: two fix rounds applied against fresh local captures of the running dashboard; detector clean at the time of this record (as reported by the finish review; this file records the shipped `src/ui` code).

**Key Characteristics:**
- Cream grained paper ground with terracotta hairline grout; flat at rest
- One deep-teal starry band; everything else is light
- Cobalt is the only action colour; amber, pine, brick, graphite are status meanings
- Marcellus / Source Sans 3 / Source Code Pro, each with one job
- Slab label cells, sunrise arc, stations diagram, provenance chips, ledger as signature components
- Three-column binder grid, 24 px gutters, folding at 1180 and 900

## Colors

Warm paper and inks under one cold teal band, with five meaning colours that never trade places.

### Primary
- **Cobalt** (`cobalt`): the single action colour. Primary buttons, links, focus rings, caret and accent-color, the current station on the stations diagram, and the faint cobalt wash on the newest ledger line. Ghost buttons and `blue` chips (manual input, demo provenance) use `cobalt-deep` text on `cobalt-tint`.
- **Deep Night Teal** (`night`, `night-deep`): the band only. Gradient from `night-deep` to `night`, sparse 1 px white star dots, an amber glow in the bottom-right corner, bottom edge in `grout-strong`. Text on it is `night-text`; captions and quiet values are `night-muted`. Also the `::selection` colour.

### Secondary
- **Amber** (`amber`, `amber-deep`, `amber-tint`): handoff and human review only. The amber button, the review banner, `amber` chips (degraded, starting, paused, unknown verdict), the side-track marker on the stations diagram, and the sun on the restock arc while the window is open.
- **Pine** (`pine`, `pine-tint`): eligible, healthy, live-verified, completed. `teal` chips, passed stations and the passed segment of the main line.
- **Brick** (`brick`, `brick-tint`): blocked, ineligible, expired, disabled, errors. Danger buttons, error banners, `brick` chips.

### Tertiary
- **Graphite** (`graphite`, `graphite-tint`): the neutral machine tone. Offline-replay `charcoal` chips and the resting sun below the horizon.
- **Terracotta** (`terracotta`): the hairline grout at full strength. Hover border on buttons and inputs, arc horizon and tick marks, the scrollbar thumb.

### Neutral
- **Paper** (`paper`): the page ground, with a fractal-noise grain (SVG data URI, 7% alpha) and a peach radial glow at the top-right.
- **Paper Deep** (`paper-deep`): disabled inputs, inline code, the evidence canvas well, `neutral` chip fill, scrollbar track.
- **Pocket** (`pocket`): every pocket's fill and the stub row at the foot of the card.
- **Slab** (`slab`): the centre card, default buttons. Pure white (`#ffffff`) is reserved for the slab label strip, inputs, and button hover.
- **Ink / Ink 2 / Ink 3** (`ink`, `ink-2`, `ink-3`): body text; subtitles, ledger times and form labels; captions, uppercase labels, notes, placeholders.
- **Grout / Grout Strong** (`grout`, `grout-strong`): pocket borders, cell dividers, table and ledger rules at 45%; input and button borders, the band's bottom edge, and the dashed stub rule at 80%.

### Named Rules
**The One Action Colour Rule.** Cobalt is the only colour that invites a click. If an element is cobalt, the user may act on it; if it is not cobalt, it is a fact or a status.

**The Amber Handoff Rule.** Amber means a human must look: review, handoff, degraded, unknown, and the sun on the arc. It is never used for emphasis or warmth.

**The Fixed Meaning Rule.** Chip tones are chosen by the domain mapping in `Chip.tsx` (health, provenance, verdict), never by the caller's taste. Teal is verified and eligible, blue is human or demo input, charcoal is replay, brick is blocked, amber is review, neutral is no data.

## Typography

**Display Font:** Marcellus (with Iowan Old Style, Georgia, serif)
**Body Font:** Source Sans 3 Variable (with Source Sans 3, Segoe UI, system-ui, sans-serif)
**Label/Mono Font:** Source Code Pro Variable (with Source Code Pro, ui-monospace, Consolas, monospace)

**Character:** A Roman inscriptional serif for the few words that name the card, set over a plain humanist sans for everything that explains it; the mono face does the accounting. All three are loaded from Fontsource in `src/ui/main.tsx` (Marcellus 400, the two variables by weight axis). The root font size is 15 px, so rem values below resolve against 15.

### Hierarchy
- **Display** (400, 1.625rem, 1.15): the card title on the slab (`slab-title`). One per page.
- **Headline** (400, 1.35rem, 1.1, 0.04em): the wordmark in the band (white on teal) and the empty-pocket note "No card in this pocket" in `ink-3`.
- **Body** (400, 0.9375rem, 1.45): interface text, fact values (500 weight), subtitles in `ink-2`, inputs.
- **Body small** (400, 0.8125rem): buttons (600), tables, the ledger, notes, banners, the band subline.
- **Label** (400, 0.72rem, 0.1em, uppercase, `ink-3`): pocket titles, slab section headings, details summaries, legend titles. Slab cell labels and table headers tighten to 0.68rem; fact labels and key-value terms loosen to 0.06em; clock labels in the band are 0.7rem at 0.09em in `night-muted`.
- **Mono** (400, 0.9375rem, tabular numerals via `tnum`): slab cell values, clock values (1.125rem in the band), ledger times, numeric and date inputs, `num` cells in tables. Ledger payloads and inline code drop to 0.74rem and 0.8125rem.
- **Chip** (600, 0.74rem, 0.02em, 1.5): every status pill.

### Named Rules
**The Tabular Ledger Rule.** Every timestamp, money value, countdown, and identifier is set in Source Code Pro with tabular numerals. No number that can change width is set in the sans.

**The Three Faces Rule.** Marcellus names, Source Sans explains, Source Code Pro counts. A fourth face, or a serif used for body text, is outside the world.

## Layout

The page is a centred column of max 1480 px with 28 px top, 32 px side, and 56 px bottom padding under an 88 px band (`band-inner`: three-column grid auto / 1fr / auto, 16 px by 32 px padding, 28 px gap). Below it the binder is a three-column grid, `minmax(280px, 1fr) / minmax(440px, 1.55fr) / minmax(280px, 1fr)`, two rows, 24 px gutters, items aligned to start. The centre column holds the card; left and right columns are `stack` grids of pockets with the same 24 px gap; the full-width sleeve (the ledger) sits in row two.

Inside the card: the slab label is a three-cell grid with 1 px grout dividers; the body has 22 px by 24 px padding; facts are a three-column grid at 12 px by 20 px gaps (a `fact-wide` spans all); slab sections carry a 1 px grout top rule and 14 px by 24 px padding; the stub row at the foot has a dashed `grout-strong` top rule, `pocket` fill, and 16 px by 24 px padding with a two-column field grid. Key-value lists are `max-content / 1fr` grids at 8 px by 16 px gaps. The ledger row is `150px / minmax(180px, 1fr) / auto`.

Spacing rhythm as used: 2 and 3 px inside label/value stacks, 4 px under labels, 6 px for notes and chip gaps, 8 to 10 px between siblings, 12 to 14 px between fields and under titles, 16 to 20 px pocket internals, 24 px gutters, 28 px page and footer separation.

Responsive:
- **1180 px and below:** two columns, `minmax(260px, 1fr) / minmax(400px, 1.4fr)`; the card spans both rows on the right, the left column stacks above the right column, the sleeve moves to row three. Facts fold to two columns. The band folds to two columns with its right cluster on a second row.
- **900 px and below:** one column, 16 px gaps, card first, then left pockets, right pockets, sleeve. Page padding 18 px by 16 px. Clock cells fold to a two-by-two grid with top rules. Facts and stub fields go single-column; the sunrise arc stacks its text below the drawing; ledger rows collapse to one column; the stations legend drops out of the heading row into the flow; sibling dimming is switched off.

## Elevation & Depth

Flat at rest. Depth comes from paper layering (`paper` under `pocket` under `slab` under white) and the clear-sleeve highlight: a 135 degree white gradient from 78% to transparent at 46% plus a 1 px inset white top line on every pocket. The only shadow is the lift on hover or focus-within: the pocket rises 2 px and takes a soft teal-tinted shadow while its siblings drop to 86% opacity. The centre card takes the shadow and border change but does not translate. Focus rings are outlines, not shadows.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 10px 24px -14px rgba(35, 78, 86, 0.45), 0 2px 6px -3px rgba(28, 40, 51, 0.2)`): the hovered or focused pocket only. Teal-tinted so the shadow reads as the band's light, not grey.
- **Logo drop** (`filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))`): the 56 px logo on the band, so the raster sits on the teal.

### Named Rules
**The Focus Discipline Rule.** One pocket lifts; the rest dim to 86%. The lift is 2 px, 180 ms, `cubic-bezier(0.16, 1, 0.3, 1)`. No shadow appears without a hover or focus cause, and none appears under 900 px.

## Shapes

Small, consistent radii: 6 px (`r-2`) on pockets, the card, buttons, inputs, banners, clock cells, and the evidence canvas; 4 px (`r-1`) on focus rings and inline code; full pills (999 px) on chips only. Borders are 1 px hairlines in `grout` (45%) for containers and dividers and `grout-strong` (80%) for controls; the stub row is separated by a 1 px dashed `grout-strong` rule. On the band, borders become translucent `night-text` at 22 to 28%. Circles are reserved for meaning: station dots (4.5 px, 6.5 px current with a 10 px 35% halo), legend dots (8 px), heartbeat dot (7 px), and the 12 px sun. The arc is a shallow circular segment drawn dashed `3 4` in `grout-strong` over a solid terracotta horizon with three 15-minute ticks.

## Components

### Buttons
- **Shape:** gently rounded (6 px), 34 px tall, 14 px horizontal padding, Source Sans 600 at 0.8125rem, 0.01em tracking.
- **Default:** `slab` fill, `ink` text, 1 px `grout-strong` border; hover turns the border terracotta and the fill white.
- **Primary (cobalt):** `cobalt` fill and border, white text; hover `cobalt-deep`. One primary per stub row, chosen by mission state.
- **Amber:** `amber` fill, near-black text (`#241505`); hover darkens to `#d97a1f`. Handoff and review only.
- **Danger:** transparent, `brick` text, brick border at 55%; hover `brick-tint` fill and solid brick border. Cancel.
- **Ghost:** transparent, `cobalt-deep` text, no border; hover `cobalt-tint`.
- **Active / Disabled / Focus:** active nudges 1 px down; disabled is 45% opacity with a not-allowed cursor; focus-visible is a 2 px cobalt outline offset 2 px. Colour transitions are 180 ms ease-out and removed under reduced-motion.

### Chips
- **Style:** hairline pills, 2 px by 9 px padding, 6 px gap, 600 weight at 0.74rem; tint fill, deep text, border of the meaning colour at 45 to 60% alpha.
- **Tones:** `teal` (pine), `amber`, `brick`, `charcoal` (graphite), `blue` (cobalt), `neutral` (paper-deep, `ink-2`, grout border). An optional 7 px `heartbeat-dot` in currentColor pulses at 2.4 s ease-in-out (off under reduced-motion) for live health.
- **On the band:** chips invert to translucent fills (white 12% for blue, black 22% for the rest) with `night-text` text and translucent borders; brick and amber text warm to `#ffd9c9` and `#ffd9a8`.

### Cards / Containers
- **Pocket:** `pocket` fill, 1 px `grout` border, 6 px radius, 18 px by 20 px padding, clear-sleeve highlight, hover lift. Title row is a label caption with an optional right-aligned mono value. `details.pocket` variants use the same title as a summary with a cobalt "Show" / "Hide" suffix and no marker.
- **Card (pocket-card):** `slab` fill, zero padding, overflow hidden; the slab label strip (white, three mono cells with grout dividers), body, sections with grout top rules, and the dashed `pocket` stub row. Lifts without translating.
- **Sleeve:** the full-width ledger pocket in row two.
- **Banners:** 6 px radius, 9 px by 12 px padding, body-small; error (brick), info (cobalt), review (amber) in tint / deep text / meaning border.

### Inputs / Fields
- **Style:** white fill, 1 px `grout-strong` border, 6 px radius, 7 px by 10 px padding, Source Sans at body size; date, time, and number inputs switch to mono with tabular numerals. Labels are block, 0.78rem, `ink-2`, 4 px below; notes 0.78rem `ink-3`. Fields stack at 12 px; `field-row` is an auto-fit grid at 160 px minimum.
- **Hover / Focus:** hover border terracotta; focus-visible a 2 px cobalt outline at zero offset with a cobalt border.
- **Disabled:** `paper-deep` fill, `ink-3` text. Placeholders are `ink-3`. Textareas start at 88 px and resize vertically.

### Navigation
- **The band:** the only chrome. 88 px min height, `night-deep` to `night` gradient with star dots and an amber corner glow, `grout-strong` bottom edge. Left: 56 px logo and the Marcellus wordmark with a `night-muted` subline. Right: mode and model chips, then the clock cells (a 6 px-radius group on black 18% with 22% dividers; 0.7rem uppercase labels, 1.125rem mono values in white, quiet values in `night-muted`, 0.72rem notes). Token connect is a 240 px white input and a button. There is no sidebar and no tab bar.

### Slab Label Cells
The grading-slab strip across the top of the card: three equal cells on white, divided by `grout` hairlines, 12 px by 18 px padding. Each cell is a 0.68rem uppercase label in `ink-3` over a mono value in `ink` that truncates with an ellipsis; the State and Provenance cells hold a chip as the value. It is the first thing read on the card and never scrolls away from it.

### Sunrise Arc
The restock window as an SVG sunrise (320 by 110 viewBox, two-column grid with the state text at right; stacks under 900 px). Dashed `grout-strong` arc, terracotta horizon and 15-minute ticks, mono window labels in `ink-2`. Inside the window the 12 px `amber` sun travels the arc by the server clock with a 35% amber radial glow; outside it, a graphite sun rests below the horizon at the window edge behind a dashed `paper-deep` disc. State text is 600 weight; detail is body-small `ink-2`. The sun's position renders the clock and is never evidence of a restock.

### Stations Diagram
The whole mission state graph as a 400 by 64 SVG line with ten stations. Main line `grout-strong` 2 px; the passed segment and passed dots are `pine`; the current station is a 6.5 px `cobalt` dot with a 10 px 35% halo and a 700-weight `cobalt-deep` label; ahead stations are `slab` dots with `ink-3` strokes and labels at 10.5 px. Side tracks (Paused, Unknown, Cancelled, Expired) hang a small `amber-tint` bar with an `amber-deep` stroke below the centre. A visually hidden ordered list carries `aria-current="step"`; the legend (passed, current, ahead, side) sits absolutely in the section heading row at 0.72rem with 8 px ring dots.

### Provenance Chips
Every fact and every ledger line carries a chip mapped from provenance: live_verified teal, manual_input and demo blue, offline_replay charcoal, blocked brick, anything else neutral. The mapping lives in `Chip.tsx` and one fixed legend (`legend`, 0.74rem `ink-3`, uppercase title) explains it once.

### Ledger
The timeline as printed lines: an ordered list, body-small, each row a `150px / minmax(180px, 1fr) / auto` grid with 8 px vertical padding and a `grout` bottom rule. Mono SGT time in `ink-2` (UTC on hover title), 600 event type in `ink`, provenance chip at right, and an optional 0.74rem mono payload in `ink-3` spanning the trailing columns. The newest line carries a left-to-right cobalt wash at 6% bleeding 8 px past the text edge. Newest first; narration is never a success signal.

## Do's and Don'ts

### Do:
- **Do** use cobalt (`cobalt`) for every actionable element and for nothing else; exactly one primary button per stub row.
- **Do** set every timestamp, countdown, money value, and identifier in Source Code Pro with `font-variant-numeric: tabular-nums`.
- **Do** build new surfaces as pockets: `pocket` fill, 1 px `grout` border, 6 px radius, clear-sleeve highlight, uppercase 0.72rem `ink-3` title.
- **Do** choose chip tones through the `Chip.tsx` mappings (`healthTone`, `provenanceTone`, `verdictTone`) so meaning stays fixed.
- **Do** show `Unknown` as a plain value in the same type as known values; never hide it behind a spinner or animation.
- **Do** keep the lift (2 px, 180 ms, `--ease-out`) as the only translate and the heartbeat as the only loop, both disabled under `prefers-reduced-motion`.
- **Do** keep the band as the single dark surface; everything below it is paper.

### Don't:
- **Don't** introduce dark grounds, neon, dense tickers, or urgency treatments below the band; the trading-terminal look is rejected.
- **Don't** add a sidebar, tab bar, same-size stat cards, or template blue buttons; the SaaS-admin look is rejected.
- **Don't** use amber for emphasis or warmth; it is reserved for review, handoff, degraded or unknown status, and the sun.
- **Don't** apply box-shadows at rest or under 900 px; depth is paper layering, and the lift is a response to hover or focus only.
- **Don't** add a fourth typeface, set body text in Marcellus, or set numbers in the sans.
- **Don't** use emojis or glyph icons anywhere; drawings are inline SVG with `var(--token)` fills.
- **Don't** present demo, replay, or mocked results without their provenance chip, and never as live.
