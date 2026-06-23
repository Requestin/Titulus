# `bench/` — performance acceptance harness (DEVELOPMENT_PROMPT §11)

- `bench.html` — 5 simultaneous lower-thirds (gradient, shadow, ticker, clock, spinner)
- `bench-alpha.html` — mask/alpha stress scene (§11.4, ≤5% overhead target)
- `run-bench.sh [channels] [duration_sec] [graphics_per_channel]` — launches N
  engine processes pinned to disjoint cores (`taskset`), parses per-engine
  `SUMMARY` log lines, reads `/proc/stat` for CPU%

MVP acceptance: `./bench/run-bench.sh 3 1800 5` ≥ CasparCG CPU baseline.

Populated in **Phase 0** (`feature/phase-0-bench-harness`). Not yet implemented.
