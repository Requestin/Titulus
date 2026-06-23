# `bench/` — performance acceptance harness (DEVELOPMENT_PROMPT §11)

- `bench.html` — stress scene: N lower-thirds (gradient + drop-shadow + corner
  radius + slide animation), a per-frame scrolling ticker, a clock, and a CSS
  spinner. Parameterized via `?graphics=N` (default 5). Self-contained 1920×1080.
- `bench-alpha.html` — mask/alpha stress scene (§11.4, ≤5% overhead target).
  A/B via `?masks=0|1` (default ON): 2 lower-thirds + animated masked plate
  (clip-path polygon) + alpha "bug" + alpha "video" overlay.
- `run-bench.sh [channels] [duration_sec] [graphics_per_channel]` — launches N
  bg_engine processes (one per channel) pinned to disjoint core sets via
  `taskset` (2 cores/channel, §4.3), parses each engine's `SUMMARY` line, and
  captures overall CPU% from `/proc/stat`.

## Usage

```bash
# Build the engine first (once):
cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && make -C build -j

# MVP acceptance run (3 channels, 30 min soak, 5 graphics each):
./bench/run-bench.sh 3 1800 5

# Quick check (3 channels, 20s):
./bench/run-bench.sh 3 20 5

# Mask/alpha A/B (compare fps of masks=0 vs masks=1; target <=5% drop):
ENGINE_BIN=engine/build/Release/bg_engine
$ENGINE_BIN --consumer=null --fps=50 --duration=60 \
  --url="file://$(pwd)/bench/bench-alpha.html?masks=0" --cache-dir=/tmp/m0
$ENGINE_BIN --consumer=null --fps=50 --duration=60 \
  --url="file://$(pwd)/bench/bench-alpha.html?masks=1" --cache-dir=/tmp/m1
```

## Acceptance (§11.2)

| Metric | MVP target |
|---|---|
| Channels | ≥ 3 stable (1080p50) |
| Interval p50 | 20.0 ms |
| Drops | < 0.1% bare-metal |
| Mask/alpha overhead | ≤ 5% fps vs scene without masks (§11.4) |
| vs CasparCG | ≥ CasparCG 2.5 HTML Producer CPU baseline on same hardware |

Baseline numbers (CasparCG + Titulus on this dev host) land in
`docs/PHASE0_BENCH.md` (task 0.6 / 0.7).
