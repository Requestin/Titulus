# Phase 19 / doc02: operator-aware CPU layer compositor preflight

## Decision

**Proceed to an operator-aware render-graph POC for canonical `test1`.**

PR #75 correctly measured that `test1` has no ready-made static underlay for a
two-plate `static + dynamic` split. It incorrectly treated that result as proof
that no source pixels can be cached. The two statements are not equivalent.

The corrected analysis finds **7 of 8 pixel-bearing sources cacheable** between
content updates. Their area-weighted preflight opportunity score is **96.70%**.
Only the clock requires per-frame source raster. The two animated masks become
mixer operators rather than invalidating every source they affect.

## Method

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
still requires pixel parity and a paired 3-channel uplift gate.

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
is already under that ceiling without any optimisation. PR7 (AVX2 + parallel
scanlines) targets ~2-4 ms/frame, which is the order-of-magnitude uplift
needed for the K2 decision gate.

`BG_LAYERED_COMPOSITOR=1` production wiring is intentionally deferred to PR5
so this POC stays pure: it does not touch the engine render pump, the
FrameRing or any consumer.

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
