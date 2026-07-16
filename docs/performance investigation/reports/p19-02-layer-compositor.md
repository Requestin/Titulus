# Phase 19 / Doc02 — operator-aware CPU layer compositor

## Decision

**PASS after audit recovery (2026-07-16).**

The original PR6 K2 STOP was correct for the implementation measured on
2026-07-15, but it was not a sound reason to permanently cancel PR7–PR9. A
fresh-eyes audit found correctness and hot-path defects that made that build
non-representative:

- the scalar mixer cost about 17 ms/frame;
- source snapshots were not sufficiently protected against stale CEF paints;
- live pixels were copied as a full crop on every paint;
- every output was fully recomposed and copied;
- props-only state revisions could restart an in-flight initial capture;
- the original gate evidence did not prove the final optimized active path.

The recovery branch fixed those defects, implemented the formerly cancelled
PR7–PR9 work, and repeated the gate from a rebuilt runtime bundle and production
engine binary.

Fresh controlled ABBA result:

- 1ch treatment: 50.0 fps, non-regression **SMOKE_PASS**;
- 3ch treatment: 50.0 / 50.0 / 50.0 fps in both B cells;
- worst paired 3ch uplift: **1.5748×**;
- late/drop/flush/reference-unlock: **zero** in every measured K2 window;
- K2 verdict: **PASS** (required ≥1.5×).

`BG_LAYERED_COMPOSITOR` remains default off globally. Production opt-in requires
the flag plus an explicit template-id allowlist. Unsupported or non-allowlisted
templates use the complete legacy monolith path.

Evidence summary:
`engine/research/results/p19/doc02-20260715/k2-gate/audit-recovery-20260716.md`.

## Scope and architecture

Canonical `test1` projects to:

- seven cacheable source bitmaps;
- one live HTML clock;
- two axis-aligned mask operators;
- affine transform, opacity and mask state updated independently of source
  pixels;
- no unsupported operator.

The runtime publishes bounded `BGGRAPH v1` snapshots containing graph/state
revisions, template id, affine/layout state, mask scopes and selective content
invalidations. The engine:

1. validates the whole graph;
2. captures cacheable sources once in isolated local bounds;
3. refreshes only explicitly invalidated cached content;
4. updates the live bitmap using CEF dirty rectangles;
5. composes affine/mask/opacity operators in a pixel-exact CPU mixer;
6. updates dirty output tiles in the currently owned FrameRing buffer;
7. falls back to monolith on any unsupported or inconsistent state.

The browser/editor authoring model and DeckLink weave/scheduling are unchanged.

## Audit recovery by original plan item

### PR2 — mixer correctness

- Confirmed CEF OSR input is premultiplied BGRA8.
- Added scalar goldens for alpha, opacity, affine bounds, masks, fail-closed
  behavior and overflow limits.
- Rejected singular/non-finite/oversized inputs before touching output.
- Corrected sampling bounds to protocol source extents.
- Added full-vs-dirty-region equality goldens.

### PR3 — protocol and revisions

- Bounded graph/state revisions are parsed symmetrically in TypeScript/C++.
- Duplicate JSON keys, duplicate ids, unknown invalidation ids, fractional mask
  rectangles and singular affine matrices are rejected.
- Added `invalidate` for selective content recapture.
- Added bounded `template_id` for production allowlisting.
- Page reload resets the graph store so revision counters cannot retain stale
  pixels across renderer instances.

### PR4–PR5 — capture and full-path correctness

- Renderer ACK and a 64-bit capture marker prove that an accepted paint belongs
  to the requested isolated host.
- The pre-ACK in-flight paint is discarded.
- Required capture extents fail closed instead of silently truncating.
- Active snapshot layers are pinned in the cache; failed admission does not
  evict a visible source.
- Props/mask-only revisions no longer restart initial source capture.
- Content invalidation recaptures only named cached sources.
- Missing cache, capture timeout/error and unsupported graphs return the entire
  channel to monolith.

### PR6 — corrected gate

The gate harness now:

- uses fresh CEF caches and tracked process groups;
- separates warmup from complete telemetry windows;
- validates exact channel/window counts and telemetry fields;
- proves the requested boot flag after graceful log flush;
- requires `mode=composing`, zero capture failures/fallbacks, completed capture
  ACKs and positive composed frame count in treatment cells;
- runs A1/B1/B2/A2 and reports conservative paired per-channel uplift.

### PR7 — optimized mixer

- AVX2 premultiplied src-over span kernel with scalar tails.
- AVX2 nearest-neighbour affine gather + blend.
- Pixel-exact dispatch goldens fixed a byte-ordering defect before measurement.
- Persistent worker pool partitions large full-frame mixes into disjoint
  scanline bands.
- Mask spans avoid per-pixel mask tests when representable.
- Synthetic `test1` mixer p95 is below the 3 ms gate; live `test1` telemetry
  observed compose p95 around 1.18 ms.

### PR8 — dirty/cache/ownership hardening

- CEF dirty rectangles update only intersecting bytes of the warm live crop.
- Dynamic 15 s probe copied 3.63 MB instead of a 151.19 MB full-copy baseline.
- 64×64 dirty tiles conservatively cover old/new affine bounds, opacity/content
  changes, live updates and old/new mask rectangles.
- Incremental output is compared against full recomposition across affine,
  opacity and animated-mask unit sequences.
- FrameRing supports locked in-place update of its owned latest buffer.
- Cache entries used by the current snapshot are pinned; replacement is
  transactional.
- Telemetry exposes region bytes, full-copy baseline, incremental regions,
  full composes and compose p50/p95/p99.

### PR9 — allowlist, soak and rollback

- `BG_LAYERED_COMPOSITOR_ALLOWLIST` is a comma-separated exact template-id
  allowlist.
- Empty allowlist means unrestricted **research opt-in** only; production must
  set an explicit list.
- Canonical allowlist entry:
  `6104dc7e-45c4-48b1-a382-db3b3b34091f`.
- A rejected template enters sticky monolith fallback and does not retry on
  every props-only frame.
- Periodic layered telemetry is emitted in both external-clock and regular
  pump loops.
- Final 15-minute 1ch: 180 windows, 50.0 fps median/average/minimum/maximum.
- Final 60-minute 3ch: 720 windows per channel; all medians/averages/minimums
  50.0 fps (max 50.0–50.2).
- Both soaks: late/drop/flush/reference-unlock all zero.
- Harness waits for actual telemetry record counts and rejects any delivery
  error; fixed wall-time sleeps are not used.

## Pixel parity

Deterministic fixture generation:

```bash
node engine/research/p19/make_doc02_parity_fixture.mjs \
  tests/templates/test1.json 100 /tmp/doc02-parity/test1-static.json
```

The fixture samples all timeline transforms/operators at one exact frame,
disables directors/actions and hides clock/video content. Independent off/on
preview captures produced:

- resolution: 1920×1080;
- mean absolute channel error: 0.0298 / 0.0302 / 0.0324;
- maximum JPEG-domain channel delta: 31;
- ffmpeg SSIM: **0.999062**;
- no structural visual mismatch on inspection.

The residual is from independent JPEG preview capture/encoding. In-memory mixer
and incremental/full goldens are byte-exact.

## Fresh K2 evidence

Host: AMD Ryzen 5 3600, DeckLink Quad 2, HD1080i50, fill-only, genlock locked.
Pins remain `0-3`, `4-7`, `8-11`. Each cell used a 10 s warmup and six complete
5 s measurement windows.

1ch:

- A1 off 49.9 → B1 on 50.0: 1.0020×;
- A2 off 49.9 → B2 on 50.0: 1.0020×;
- verdict: **SMOKE_PASS**.

3ch A1/B1:

- ch0 29.6 → 50.0: 1.6892×;
- ch1 29.8 → 50.0: 1.6779×;
- ch2 31.75 → 50.0: 1.5748×.

3ch A2/B2:

- ch0 30.0 → 50.0: 1.6667×;
- ch1 28.2 → 50.0: 1.7730×;
- ch2 29.1 → 50.0: 1.7182×.

Worst paired uplift is **1.5748×**, therefore K2 PASS.

## Verification

```bash
cd runtime
npm test
npm run build

cd ../engine/tests
cmake --build build-audit-sanitize -j4
ctest --test-dir build-audit-sanitize --output-on-failure

cd ..
cmake --build build -j4
```

The sanitizer suite covers mixer, protocol, synthetic compositor and live
pipeline. Runtime has classifier/protocol/frame-projection tests. Production
CEF/DeckLink build is warning-clean except pre-existing unused-function warnings
from bundled `stb_image_write.h`.

## Production enablement

Keep the global default off. For the canonical allowlisted template:

```bash
export BG_LAYERED_COMPOSITOR=1
export BG_LAYERED_COMPOSITOR_ALLOWLIST=6104dc7e-45c4-48b1-a382-db3b3b34091f
```

Required active-path proof:

- startup logs `layered=on` and `allowlist=1`;
- periodic `layered_stats mode=composing`;
- `capture_ready>=8`;
- `capture_failures=0`, `fallback=0`;
- compose p95 ≤3 ms;
- DeckLink telemetry has zero late/drop/flush/unlock.

## Rollback

Immediate per-process rollback:

```bash
export BG_LAYERED_COMPOSITOR=0
unset BG_LAYERED_COMPOSITOR_ALLOWLIST
# restart only the affected channel process
```

No data/schema migration is involved. The engine then uses the unchanged
legacy `OnPaint → FrameRing → consumer` path. Runtime graph publishing is
read-only and may remain disabled. At runtime, any unsupported graph, missing
cache, capture error/timeout, allowlist rejection or mixer validation failure
automatically selects whole-template monolith fallback; approximate mixed
output is never emitted.

## Remaining constraints

- At most one `live_html` source is supported by this implementation.
- Axis-aligned normal/inverted rectangle masks are supported; unsupported
  shapes/3D/non-normal blends fail closed.
- Production rollout is allowlist-only; empty allowlist is not an approval for
  arbitrary templates.
- The legacy path remains mandatory until broader template coverage and
  operator sign-off are completed.
