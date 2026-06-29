# Design

Visual system for the Titulus control plane (frontend/). Dark, broadcast
control-room register. Tokens are defined in `frontend/src/index.css` (OKLCH CSS
variables) and exposed to Tailwind in `frontend/tailwind.config.js`.

## Theme

Dark only (a control-room tool). The mood: a broadcast gallery at night — racks
of monitors glowing in near-darkness, the on-air tally the one hard, saturated
signal in the room. Strategy: Restrained. Surfaces are cool near-black neutrals;
the brand carries a single instrument-cool primary; saturation is reserved for
semantic state (LIVE red above all).

## Color (OKLCH)

Surfaces (cool near-black, faint indigo tint so it reads intentional, not gray):
- `--bg`        oklch(0.165 0.010 274)  — app background (the room)
- `--surface`   oklch(0.205 0.012 274)  — panels, cards, content surface
- `--surface-2` oklch(0.235 0.014 274)  — sidebars, toolbars, raised rows
- `--border`    oklch(0.305 0.016 274)  — hairline separators, control borders
- `--overlay`   oklch(0.140 0.010 274)  — modal/scrim base

Ink:
- `--ink`       oklch(0.972 0.004 274)  — primary text (~16:1 on bg)
- `--ink-muted` oklch(0.740 0.012 274)  — secondary text (>= 4.5:1 on bg/surface)
- `--ink-faint` oklch(0.560 0.012 274)  — tertiary / disabled labels (large only)

Brand / interactive (instrument indigo-violet; nods to the seed hue, stays cool,
clearly distinct from the tally red):
- `--primary`     oklch(0.640 0.170 285) — primary actions, current selection
- `--primary-ink` oklch(0.985 0.004 285) — text/icon on primary fills
- `--ring`        oklch(0.720 0.150 285) — focus ring

Semantic state:
- `--live`     oklch(0.605 0.224 25)  — ON AIR / TAKE / live tally (the red)
- `--success`  oklch(0.700 0.150 150) — ready, connected, ok
- `--warning`  oklch(0.800 0.150 80)  — degraded, pending
- `--danger`   oklch(0.605 0.224 25)  — destructive (CLEAR ALL), errors (== live red)
- `--info`     oklch(0.700 0.120 230) — neutral info / preview cyan

All color tokens are stored as the bare `L C H` triplet and consumed as
`oklch(var(--token) / <alpha-value>)` in Tailwind so opacity utilities work.

## Typography

One family. Inter (variable, bundled via `@fontsource-variable/inter`) for all
UI: headings, labels, buttons, body, data. Monospace only for numeric readouts.
- `--font-sans`: 'Inter Variable', system-ui, sans-serif
- `--font-mono`: ui-monospace, 'SF Mono', Menlo, monospace
- Scale: fixed rem, ratio ~1.2 (12 / 13 / 14 / 16 / 20 / 24). Default UI 14px.
- All timecode, frame counters, channel numbers, fps: `font-mono` +
  `font-variant-numeric: tabular-nums`.

## Components

Earned-familiarity controls; every interactive element ships default / hover /
focus-visible / active / disabled / (where relevant) loading + error.
- Buttons: solid primary (primary fill), neutral (surface-2 + border), ghost,
  and a dedicated `danger`/`live` variant for TAKE / CLEAR ALL.
- Inputs/selects: surface-2 fill, border hairline, focus ring (`--ring`),
  consistent 32-36px control height.
- Panels: flat surfaces separated by `--border` (no nested cards, no
  side-stripe borders). Sidebar/toolbar use `--surface-2`.
- Channel pill / tally: idle (muted) -> preview (info) -> LIVE (solid `--live`
  with a steady — not blinking — indicator). Reduced-motion safe.
- Status dot for WebSocket: success (connected) / warning (connecting) /
  danger (disconnected).
- Empty states teach the next action; loading uses skeletons, not center spinners.

## Layout

- App shell: fixed left nav (icons + labels) on `--surface-2`, top bar with
  context title + WS status, content region scrolls. Responsive is structural
  (nav collapses to icons), not fluid type.
- Editor: left Layers, center Canvas (letterboxed 16:9 stage), right Properties /
  Variables, bottom Timeline. Resizable/collapsible panels.
- Semantic z-index scale: base < sticky-toolbar < dropdown < modal-scrim <
  modal < toast < tooltip (no arbitrary 9999).

## Motion

- 150-220 ms, ease-out (no bounce/elastic in chrome). Motion conveys state only:
  TAKE/CLEAR transitions, value pop-in on UPDATE, panel collapse, toast.
- No page-load choreography. `prefers-reduced-motion` -> crossfade/instant.
- Channel-page render motion (timeline easings) is separate and lives in
  `@titulus/runtime` — not subject to these chrome rules.
