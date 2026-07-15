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
