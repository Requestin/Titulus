# Phase 19 / doc02: operator-aware CPU layer compositor

## Decision

**STOP after K2.** The operator-aware render-graph POC was built
(PR0–PR5, flag `BG_LAYERED_COMPOSITOR`, default off) and failed the paired
3-channel DeckLink uplift gate (PR6). Worst-channel uplift was **0.14× (1ch)** /
**0.21× (3ch)** versus paired control — far below the **1.2×** fail threshold.

`BG_LAYERED_COMPOSITOR` remains **default off**. Doc02 production optimization
(PR7 AVX2, PR8 dirty/cache, PR9 allowlist/soaks) is **cancelled** on this
architecture. A future revisit requires a different capture/compose contract,
not SIMD on the current full-path swap.

Preflight (below) correctly justified attempting the POC: **7 of 8**
pixel-bearing sources are cacheable between content updates (area-weighted
opportunity **96.70%**). Opportunity score is not a predicted FPS uplift; K2
measured throughput is the architectural gate, and it failed.

Evidence: `engine/research/results/p19/doc02-20260715/k2-gate/`
(see also [K2 gate](#k2-gate-pr6--stop) below).

## Preflight method

`engine/research/p19/analyze_doc02_static_fraction.mjs` projects a template
without rendering it:

- `content_dirty`: pixels must be recaptured (`clock`/`video` per frame,
  variable-bound text only on update);
- `props_dirty`: cached pixels remain valid while transform/opacity changes;
- `mask_dirty`: cached sources remain valid while mask geometry changes;
- unsupported operators are reported explicitly and require whole-template
  legacy fallback.

`opportunityScore` is a preflight proxy:
`cacheable local source area / all pixel-source area`. It is not a predicted FPS
uplift; measured raster/CPU attribution in the POC remains the architectural
gate.

## Canonical `test1` result

| Signal | Value |
| --- | ---: |
| Pixel-bearing sources | 8 |
| Cacheable source bitmaps | 7 |
| Per-frame live sources | 1 (clock) |
| Mask operators | 2 |
| Unsupported operators | 0 |
| Area-weighted opportunity | 96.70% |
| Legacy two-plate static coverage | 0% |
| Required preflight minimum | 20% |

The animated group rotations/translations and moving images are property-only
changes. The variable-bound text layers need recapture only on `update`. The
normal image mask and root-level inverted rectangle mask are supported operator
candidates. The evidence summary is
`engine/research/results/p19/doc02-20260715/preflight/static-fraction.json`.

## Relation to previous gates

- Doc01 raised headless `test1` to the 50 Hz ceiling, but 3-channel DeckLink
  remains around 28–30 unique fps.
- Doc03 and doc04 did not find a safe memory or scheduling throughput lever.
- The corrected preflight shows enough reusable source work to justify a POC;
  it does not yet prove that CPU affine/mask composition is cheaper than CEF.

## Consequence

The two-plate MVP remains rejected. The next implementation must instead model
cached source bitmaps, transform/group nodes, opacity/z nodes, mask operators
and a live clock node. Scalar correctness comes before SIMD. All behavior stays
behind `BG_LAYERED_COMPOSITOR=0|1`; unsupported state falls back to the complete
legacy monolith before TAKE.

The POC proceeds only through the corrected staged plan. Production optimization
still requires pixel parity and a paired 3-channel uplift gate. **That gate was
run in PR6 and failed (STOP); see Decision and K2 section.**

## Implementation progress

PR1 adds the pure runtime projection in `runtime/src/layerPromote.ts`. It:

- preserves root/group stack order and canonical mask scopes;
- emits cached bitmap, live HTML and mask operator nodes;
- tracks content/property/mask dirty domains and variable dependencies;
- rejects unsupported 3D, blend and mask operators with explicit whole-template
  fallback reasons;
- projects canonical `test1` as 7 cacheable sources, one live clock and two
  supported mask operators.

It does not change DOM rendering or the engine frame path.

PR2 adds the scalar reference mixer under `engine/src/mixer/` and a standalone
`engine/tests/` CTest target. It:

- walks a stable z-order layer list back-to-front;
- performs straight-alpha src-over BGRA8 blend;
- supports affine translation, scale, anchor rotation and opacity;
- supports axis-aligned normal/inverted rect masks;
- reports unsupported operators (fractional rotation, non-positive scale,
  oversized buffers, unsupported mask shapes) as explicit fallback reasons;
- includes a 64-byte aligned `MixerBufferPool` for the upcoming SIMD PR.

The mixer is compiled into `bg_engine` but is not yet connected to the render
pump; production gating remains behind `BG_LAYERED_COMPOSITOR` in later PRs.

PR3 adds the bounded layer protocol v1 and a shadow `RenderGraphStore`. It:

- defines the `BGGRAPH v1 <json>` wire format plus strict size/extent bounds;
- implements an allocation-light parser on the CEF UI thread inside
  `OnConsoleMessage` (mirrors the existing `BGSTATS` opt-in pattern);
- stores the latest accepted snapshot plus telemetry counters (accepted,
  stale-dropped, malformed, bounds-violation, unsupported);
- wires the shadow store into `EngineClient` and `main.cpp`;
- adds a runtime-side encoder (`runtime/src/graphProtocol.ts`) and a
  `publishTemplateGraph` helper plus an opt-in flag (`?graph=1` or
  `window.BG_GRAPH_PUBLISH=1`).

Shadow mode means the store never feeds the render pump; production still uses
the legacy monolith. The encoder is invoked at most once per `take`, never on
the per-frame path, and is dropped silently when bounds are exceeded.

PR4 delivers the synthetic operator-aware POC: the first end-to-end exercise
of the protocol + mixer + compositor stack with no CEF dependency. It:

- adds `engine/src/compositor/synthetic_snapshot.{h,cpp}`, deterministic
  BGRA8 source bitmaps keyed by layer id hash (so POC runs are reproducible
  without needing live CEF snapshot capture);
- adds `engine/src/compositor/layered_compositor.{h,cpp}`, the orchestrator
  that turns a parsed protocol snapshot into a `MixInput` and delegates to
  the scalar `CpuLayerMixer`, reporting per-frame nanoseconds and explicit
  fallback reasons;
- adds `engine/bench/layered_compositor_bench.cpp`, a no-CEF bench that
  loads a `BGGRAPH v1` snapshot, builds the synthetic sources and reports
  mean/min/max for the layered path vs a `memcpy` baseline;
- adds `engine/research/p19/emit_test1_graph.mjs`, which produces a `.bgraph`
  file from `tests/templates/test1.json` via the runtime classifier +
  encoder, so the bench can run without a live engine.

POC result on the canonical `test1` snapshot (10 layers, 1920x1080, scalar
mixer, no SIMD, no parallelism):

| Path                       | mean (us) | min   | max   |
|----------------------------|-----------|-------|-------|
| layered_mixer_scalar       | ~17 300   | 17.1k | 18.6k |
| monolith_memcpy_baseline   | ~380      | 362   | 491   |

The scalar mixer is ~45x slower than a single `memcpy`, which is expected for
a per-pixel, per-layer walk with no SIMD. The Phase 18 monolith (full CEF
raster) costs ~35-40 ms/frame for the same content; the scalar mixer at 17 ms
looked under that ceiling in synthetic isolation. Live DeckLink K2 (PR6) showed
that headroom does not survive the full-path capture + live-overlay contract,
so AVX2/PR7 was never unlocked.

PR5 wires the **full path swap** behind `BG_LAYERED_COMPOSITOR=1` (default
off):

- Runtime: `TemplateRenderer.setLayerVisibilityFilter` +
  `ChannelClient.setLayerVisibilityFilter('*', ids)` so the engine can isolate
  one layer at a time via `data-layer-id` DOM attributes.
- Engine: `LivePipeline` drives per-layer CEF snapshot capture (visibility
  filter → BeginFrame → OnPaint → `LayerBitmapCache`), then each frame either:
  - **cache-only** (no `live_html`): compose from cache without waiting for
    CEF paint;
  - **live overlay** (`test1` clock): show only live layers, capture a
    full-canvas live overlay, src-over it on top of the cached mix.
- Unsupported operators / missing cache / mixer fallback → automatic return
  to the legacy monolith OnPaint path for that channel.
- URL gets `graph=1` appended automatically when the flag is on so the page
  publishes `BGGRAPH` snapshots into the shadow store.

## Verification

```bash
node --test engine/research/p19/tests/test_doc02_static_fraction.mjs
node engine/research/p19/analyze_doc02_static_fraction.mjs tests/templates/test1.json
cd runtime
npm test
npm run typecheck
npm run build
cd ../engine/tests
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Debug ..
cmake --build .
ctest --output-on-failure
```

To opt a channel into the shadow graph publisher, open the page with
`?graph=1` (or set `window.BG_GRAPH_PUBLISH = 1` before `channel.html` boots).
The engine logs the store telemetry via the standard `BGSTATS` channel; see
`engine/src/mixer/render_graph_store.h` for the counter meanings.

To run the synthetic layered-compositor bench:

```bash
node engine/research/p19/emit_test1_graph.mjs \
  tests/templates/test1.json \
  engine/research/results/p19/doc02-20260715/graph/test1.bgraph
cd engine/bench && mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build .
./layered_compositor_bench \
  ../../research/results/p19/doc02-20260715/graph/test1.bgraph 200 1920 1080
```

## K2 gate (PR6) — STOP

Paired DeckLink `test1` on HD1080i50, fill_only, same host pins as doc04
(`0-3` / `4-7` / `8-11`), flag `BG_LAYERED_COMPOSITOR=0|1`. Harness:
`engine/research/p19/run_doc02_k2_gate.sh`. Evidence:
`engine/research/results/p19/doc02-20260715/k2-gate/`.

| Run | ch0 med | ch1 med | ch2 med | worst uplift vs paired control |
| --- | ---: | ---: | ---: | ---: |
| 1ch control (off, 90s) | 49.2 | — | — | — |
| 1ch treatment (on, 90s) | 7.0 | — | — | **0.14×** |
| 3ch control (off, 60s) | 31.0 | 29.4 | 30.8 | — (matches frozen ~29–30) |
| 3ch treatment (on, 60s) | 6.6 | 6.4 | 6.55 | **0.21×** |

Delivery errors: `d_late=d_dropped=d_flushed=0`, `ref=locked` on all measured
windows for both variants. The path is stable — just far too slow.

### Decision

**STOP.** Worst-channel uplift is **≪ 1.2×** (plan fail threshold). The
layered path is a large regression, not an uplift. `BG_LAYERED_COMPOSITOR`
stays **default off**. PR7 (AVX2), PR8 (dirty/cache), and PR9 (allowlist /
soaks) are **cancelled** on this architecture until a new approach clears a
fresh K2.

Full ABBA×3 was not repeated after the first A/B pair: further repetitions
cannot change a 0.14–0.21× result into ≥1.2×.

### Attribution notes (not excuses)

Synthetic scalar mix for `test1` was ~17 ms/frame in PR4 — under the CEF
monolith cost, which is why K2 was attempted. The live DeckLink path does not
realize that headroom:

- every frame still needs a CEF live paint for the clock (`NeedsLivePaint`);
- `ComposeInto` runs on the paint/UI path (full scalar mix of seven full-canvas
  cached bitmaps + naive live-overlay blend);
- per-tick `ExecuteJavaScript` visibility filters add more CEF work.

Whether the dominant cost is mixer CPU, capture/filter thrash, or UI-thread
blocking is open; it does not matter for the gate. Measured paired throughput
fails K2. A future revisit would need a different capture/compose contract
(region caches, props applied in the mixer without full-canvas recapture,
mix off the CEF UI thread, or dropping live overlay from the hot path) — not
SIMD on the current full-path swap.

## Plan closure

Doc02 is **complete as a research track** under the plan’s own K2 decision
tree (`FAIL <1.2×` → STOP). Delivered:

| Item | Status |
| --- | --- |
| PR0–PR5 implementation behind default-off flag | merged |
| PR6 paired 1ch + 3ch K2 | STOP (PR #82) |
| PR7–PR9 production-opt | cancelled by K2 |
| Flag-OFF legacy path | remains production path |
| Report + evidence + harness | in tree |

### Closure verification (2026-07-15)

- Classifier: 7/7 pass; runtime tests 17/17; `mixer_scalar_goldens` PASS.
- Flag-OFF 1ch DeckLink smoke 45s: median `in_fps=48.1`, late/drop/flush/unlock=0
  (legacy path healthy; formal ≥49 was the longer PR5/K2 control window).
- Docs: Decision STOP, phase-19, ARCHITECTURE, RUNBOOK, development-plan snapshot.

No further Doc02 work is scheduled on this architecture. Phase 19 continues on
other docs (Style Guide / cost model) without relying on layered compose uplift.
