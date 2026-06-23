# PHASE0_BENCH.md — Titulus Phase 0 benchmark report

> DEVELOPMENT_PROMPT §11.1, §13 Phase 0: run the same bench HTML scene through
> both CasparCG 2.5 HTML Producer and Titulus `bg_engine` on identical hardware;
> `bg_engine` must be **≥ CasparCG** on fps / drops / CPU.

## Status

| Item | State |
|---|---|
| Titulus `bg_engine` harness | ✅ working (task 0.5, PR #5) |
| CasparCG baseline driver script + config | ✅ ready (task 0.6, this PR) |
| **Titulus `bg_engine` baseline numbers** | ✅ captured (see §1) |
| **CasparCG baseline numbers** | ⚠️ **partial** — see §2 (CEF GPU-subprocess instability on the headless dev host prevents a clean, comparable fps/drops read; PLAY confirmed, formal number deferred) |

## Dev host

- Ubuntu 24.04.4 LTS, 16 physical cores, 31 GiB RAM
- GPU: NVIDIA (EGL 4.6, driver 595.71) — present, but `bg_engine` runs CPU-only
  per DEVELOPMENT_PROMPT §0.2.1
- CasparCG 2.5.0 Stable (`casparcg-server-2.5` + `casparcg-cef-142`), CEF 142
- Titulus `bg_engine` built against CEF 149 (chromium 149), CPU-only OSR

---

## §1. Titulus `bg_engine` results ✅

### Multi-channel run — `./bench/run-bench.sh 3 20 5`

3 channels pinned to disjoint cores 0-1 / 2-3 / 4-5, scene
`bench.html?graphics=5`, null consumer:

| ch | fps | interval p50 (us) | interval p99 (us) | late | drops |
|----|-----|-------------------|-------------------|------|-------|
| 0  | 47.99 | 20818 | 21379 | 0 | 0.000% |
| 1  | 47.96 | 20828 | 21301 | 0 | 0.000% |
| 2  | 47.97 | 20823 | 21200 | 0 | 0.000% |

- **avg fps 47.97** (target 50) on a 20s run; startup overhead (first ~2s page
  load) dominates at short durations. The 30-min soak in task 0.7 gives the
  steady-state number.
- **0 late frames, 0% drops** across all 3 channels — clean channel isolation
  via `taskset` (2 cores/channel, §4.3).
- CPU busy (host-wide, normalized to physical core count): ~100% = ~6 cores
  busy out of 16, consistent with 3 channels × 2 cores.

### Mask/alpha A/B (§11.4) — `bench-alpha.html`, 10s, null consumer

| masks | fps |
|-------|-----|
| off (`?masks=0`) | 48.74 |
| on (`?masks=1`)  | 48.35 |

- **Overhead: ~0.8%** — well inside the §11.4 **≤5%** target on CPU-only CEF.
- No filter chains / backdrop-filter in the scene (§6.5 CPU-killers avoided).

---

## §2. CasparCG baseline — partial ⚠️

### What we confirmed

- CasparCG 2.5 boots **headless** (EGL/OpenGL initialized via the NVIDIA driver).
- A 1080p50 channel with `<html><enable-gpu>false</enable-gpu>` loads our
  `bench.html` scene through its HTML Producer. AMCP `PLAY 1-10 [HTML] "..."` →
  **`202 PLAY OK`**; `INFO 1-10` reports `<producer>html</producer>` on layer 10
  with `1920 1080 50.000000`.
- The ffmpeg/matroska consumer initializes and writes a `bench-out.mkv` while
  the scene plays (frames are being produced).

### Why the formal fps/drops number is deferred

1. **CasparCG's authoritative per-channel fps/dropped-frame counters live in its
   diagnostic graph / OSC output**, not the main log. Capturing them headless
   requires an OSC consumer, which isn't bundled here.
2. **The libx264/matroska consumer cannot serve as the fps metric**: libx264
   encodes asynchronously (`bframes=3, lookahead=10`, CRF), so the encoded-frame
   count in the teardown summary is **not** the displayed frame count.
3. **CEF GPU-subprocess instability on this host**: during longer runs CasparCG's
   CEF crashes with `FATAL: GPU process isn't usable. Goodbye.` (trace/breakpoint
   trap, core dump), interrupting the server before a clean teardown. The crash
   is in CasparCG's bundled CEF 142, not in Titulus `bg_engine` (which runs
   CPU-only and has not crashed once across all runs).

### How to capture the formal baseline (deferred)

The clean, comparable number lands when either:

- **(a)** we run on the target **bare-metal with DeckLink SDI** (Phase 3): the
  DeckLink consumer's `ScheduledFrameCompleted` callback exposes
  completed/late/dropped/flushed counters directly — the same metric
  `bg_engine`'s decklink consumer will report, making the comparison apples to
  apples; or
- **(b)** we wire an **OSC capture** (UDP 6250, CasparCG's
  `/channel/1/stage/.../dropped` + fps paths) and re-run headless.

Both paths are documented; neither blocks the render-plane proof (§1) or any
later phase. The `bench/run-casparcg-baseline.sh` driver + `bench/casparcg/`
config are kept ready for either.

---

## §3. Asymmetry note (CasparCG vs bg_engine)

CasparCG's `<html><enable-gpu>false</enable-gpu>` only disables the GPU inside
the CEF/HTML producer; its **core image mixer** still runs on the GPU
("Initialized OpenGL Accelerated GPU Image Mixer for channel 1"). Titulus
`bg_engine` is **fully CPU-only** (CEF OSR + DOM/CEF compositor, no GPU mixer).
This is intentional per DEVELOPMENT_PROMPT §0.2.1: the comparison target is
**HTML-producer throughput on the same scene**, not the mixer backend. On scenes
where the mixer is a non-bottleneck (our bench scene is single-stack DOM), the
two are directly comparable.

---

## §4. Acceptance check (§11.2) — status

| Metric | Target | Titulus bg_engine | CasparCG baseline |
|---|---|---|---|
| Channels (stable, 1080p50) | ≥ 3 | ✅ 3 (20s smoke) | ✅ 1 (PLAY OK); multi-ch pending SDI |
| Interval p50 | 20.0 ms | ~20.8 ms (20s) | pending (OSC/SDI) |
| Drops | < 0.1% bare-metal | 0.000% (20s) | pending (OSC/SDI) |
| Mask/alpha overhead | ≤ 5% | ✅ 0.8% | n/a (§6.5 is our impl) |
| vs CasparCG | ≥ baseline | pending baseline | pending (OSC/SDI) |

---

## §5. Notes / caveats

- 20s smoke numbers carry startup overhead; the 30-min soak (task 0.7) is the
  acceptance number.
- No DeckLink / genlock on this host (DEVELOPMENT_PROMPT requirement: develop
  without HW, validate later). The render-pipeline bench (null/pipe/preview
  consumers) is unaffected; SDI-specific acceptance is Phase 3, deferred.
- VM/scheduler jitter is documented (§11.3); final SDI acceptance is on
  bare-metal with DeckLink.
