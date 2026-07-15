# Phase 19 / doc02: CPU layer compositor preflight

## Decision

**Do not start the CPU layer compositor implementation for canonical `test1`.**

The doc02 plan requires a conservative static-fraction preflight before
modifying the render pump. The measured cacheable static coverage is **0%**,
below the 20% minimum bet threshold. The two-plate MVP would add a CPU blend
and another buffer without removing any CEF raster work.

## Method

`engine/research/p19/analyze_doc02_static_fraction.mjs` projects a template
without rendering it:

- clocks, video, variable-bound and timeline-animated layers are dynamic;
- an animated group promotes its descendants;
- a dynamic mask promotes all siblings it clips in its stack scope;
- only layers outside every dynamic scope count toward cacheable coverage.

The classifier is intentionally conservative: false-static output could put
stale pixels on air, while false-dynamic output only underestimates the
opportunity.

## Canonical `test1` result

| Signal | Value |
| --- | ---: |
| Layers | 10 |
| Cacheable static layers | 0 |
| Cacheable static coverage | 0% |
| Required preflight minimum | 20% |

The animated root-level inverted mask clips all preceding root siblings.
Together with animated groups, the clock, and other timeline targets it
promotes every layer into the dynamic plate. The evidence summary is
`engine/research/results/p19/doc02-20260715/preflight/static-fraction.json`.

## Relation to previous gates

- Doc01 raised headless `test1` to the 50 Hz ceiling, but 3-channel DeckLink
  remains around 28–30 unique fps.
- Doc03 and doc04 did not find a safe memory or scheduling throughput lever.
- That does not make any compositor automatically useful: its benefit requires
  static pixels outside the dynamic/mask scope, which `test1` lacks.

## Consequence

The planned L1–L5 mixer work, CEF protocol, AVX2 blend, cache and 3-channel
K2 gate are intentionally not implemented. This is a pre-engine kill-switch,
not a failed DeckLink run.

Reopen doc02 only after a separately accepted template/style change creates a
semantically equivalent acceptance workload with at least 20% cacheable static
coverage, or after a new architecture can isolate the animated root mask
without violating mask semantics. Either path requires a new ADR and baseline.

## Verification

```bash
node --test engine/research/p19/tests/test_doc02_static_fraction.mjs
node engine/research/p19/analyze_doc02_static_fraction.mjs tests/templates/test1.json
```
