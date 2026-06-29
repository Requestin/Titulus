# Product

## Register

product

## Users

Live broadcast operators, graphics operators, and technical directors working in
TV galleries / control rooms (and remote/cloud equivalents). Their context:
dim, monitor-lit rooms; high time pressure; eyes flicking between this tool and
on-air/preview monitors; often driving 2-8 channels at once during a live show.
The job: put the right title on air at the right instant, update it live, and
take it off cleanly — without ever causing a missed, late, or wrong graphic.

## Product Purpose

Titulus is a commercial cloud + on-prem broadcast graphics system. The control
plane lets operators author JSON title templates and drive live on-air graphics
(TAKE / UPDATE / CLEAR) across per-channel outputs (browser, OBS/vMix, DeckLink
SDI, stream), backed by a proprietary CPU-only CEF render engine that is
render-parity with CasparCG. Success: an operator runs a multi-hour live program
with zero missed or late graphics, and the on-screen result is indistinguishable
from CasparCG on the same hardware. The editor's preview is the on-air truth
(same `@titulus/runtime` renders both — WYSIWYG).

## Brand Personality

Precise, calm-under-pressure, broadcast-grade. An instrument, not a toy. Quiet
until something is live, then unambiguous. Confident and dense without being
noisy. Three words: exact, composed, trustworthy.

## Anti-references

- Consumer SaaS dashboards: cream/pastel backgrounds, playful illustrations,
  gradient hero cards, big-number "metric" templates, tracked-uppercase eyebrows.
- Skeuomorphic "pro audio plugin" chrome (brushed metal, faux LEDs, bevels).
- Toy-like rounded bubbly UI; anything that reads as a marketing landing page.
- Ambiguous on-air state. If an operator can't tell at a glance what is LIVE,
  the design has failed.

## Design Principles

- Glanceability under pressure: the live/preview/idle state of every channel is
  readable in under a second from across a dim room.
- On-air truth: LIVE is a hard, unmistakable red tally; nothing else competes
  for that signal. State is never decorative.
- WYSIWYG: the editor canvas and program output are the same renderer; what you
  build is exactly what airs.
- Earned familiarity: lean on conventions from OBS / vMix / Resolve / CasparCG
  clients so the tool disappears into the task; don't reinvent standard controls.
- Density without noise: show what the operator needs (channels, variables,
  timeline) at working density, with restrained color so the eye finds signal.

## Accessibility & Inclusion

- WCAG 2.2 AA targets for the web control plane. Body text >= 4.5:1 against its
  surface; large text/UI >= 3:1. Dark theme tuned for control-room lighting.
- Full keyboard operation of the operator loop (TAKE/UPDATE/CLEAR, channel
  switch); always-visible focus rings; no mouse-only affordances.
- Respect `prefers-reduced-motion` (state changes crossfade/instant). Use
  `tabular-nums` for all timecode, frame counters, and channel numbers so
  digits don't jitter.
