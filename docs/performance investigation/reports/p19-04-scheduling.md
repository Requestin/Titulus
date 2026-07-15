# Phase 19 / doc04: scheduling and CCX

## Status

Workstream is in progress. This report records only reproducible preparation
and a null-path plumbing check. It does not claim a DeckLink throughput result.

## Implemented preparation

- `engine/tools/detect-cpu-pack.py` produces locale-independent, SMT-aware CPU
  masks from `lscpu -p` and L3 `shared_cpu_list`.
- `engine/run-engines.sh` and `bench/run-bench.sh` consume the same planner.
  Sequential packing remains the default; `TITULUS_PACK=ccx` enables B1 for an
  explicit paired experiment.
- A capacity shortfall is a hard error. An unpinned overflow channel would
  invalidate a scheduling comparison.
- `engine/research/p19/collect-doc04-evidence.sh` takes a host-wide lock and
  snapshots host state plus per-channel telemetry. It does not mutate engine
  processes or OS scheduling policy.

## Host discovery

The target Ryzen 5 3600 exposes two L3 domains:

| Domain | Logical CPUs |
| --- | --- |
| L3-0 | `0-2,6-8` |
| L3-1 | `3-5,9-11` |

Current host state at preparation time:

| Signal | Value |
| --- | --- |
| Governor | `schedutil` |
| THP | `madvise` |
| irqbalance | active / enabled |
| DeckLink IRQ 71 / 73 effective CPU | 5 / 7 |
| RT limit | `ulimit -r = 0` |
| Kernel isolation | none |

## Null-path plumbing check

`bench/run-bench.sh 3 15 5` with sequential packing:

| Channel | CPUs | fps | late | drops |
| --- | --- | ---: | ---: | ---: |
| 0 | `0,6,1,7` | 50.01 | 0 | 0% |
| 1 | `2,8,3,9` | 50.01 | 0 | 0% |
| 2 | `4,10,5,11` | 50.01 | 0 | 0% |

The same cheap null scene with `TITULUS_PACK=ccx` also stayed at 50.01 fps.
That only verifies mask plumbing; it is not evidence that CCX packing helps
the complex `test1` DeckLink workload.

## DeckLink factor results

The canonical `test1` assets were restored to an isolated backend and taken on
three genlocked DeckLink channels (`HD1080i50`, devices 1–3). Every factor used
the same sequential 2-physical-core-per-channel plan unless stated otherwise.

| Factor | Median `in_fps` ch0 / ch1 / ch2 | Conclusion |
| --- | --- | --- |
| Sequential baseline | 29.5 / 27.3 / 29.0 | Reference |
| `TITULUS_PACK=ccx` | 28.8 / 30.0 / 27.2 | No repeatable uplift; retain sequential default |
| Governor `performance` | 30.7 / 27.3 / 29.8 | No improvement in the limiting channel; restore `schedutil` |
| Sequential GATE-04, ≥30 min | 29.6 / 28.0 / 30.2 | Stable delivery, but G2 throughput fails |

The GATE-04 run contains 531 five-second telemetry windows per channel. It
recorded zero `d_late`, `d_dropped`, `d_flushed`, and reference-unlocked
windows. Its worst channel reached only 28.0 median `in_fps`, far below the
50 fps G2 threshold. Evidence is committed under
`engine/research/results/p19/doc04-20260715/gate04-sequential-30m/`; raw logs
remain ignored by policy.

## Factors deliberately not adopted

- **IRQ affinity:** IRQ 71 ran on CPU 5 and IRQ 73 on CPU 7, both render CPUs.
  On the six-core 3×2c layout there is no house core: moving either IRQ merely
  moves its load to another render channel. Since GATE-04 has no late frames,
  an arbitrary affinity crossover is not an evidence-led experiment.
- **`SCHED_FIFO`:** the CFS baseline correctly soft-fails at `ulimit -r = 0`.
  A temporary `cap_sys_nice=ep` file capability made every CEF process exit
  133 at ICU initialization (`Invalid file descriptor to ICU data`). The
  capability was immediately removed; this is a failed launch, not an RT
  throughput measurement. A future RT gate must use a systemd unit with
  `AmbientCapabilities=CAP_SYS_NICE` and `LimitRTPRIO`, not a file capability
  on the CEF executable.
- **THP / C-states / kernel isolation:** remain unchanged. With zero late or
  dropped frames, these intrusive factors have no observed symptom to target.

## Gate decision

GATE-04 delivery stability passes; program G2 fails. Scheduling, L3 packing,
and the tested governor are therefore not the limiting lever for this
workload. The next investigation returns to the template cost model rather
than accumulating host tuning.

## Next action

Run a separately scoped systemd-based RT experiment only if jitter (late
frames) reappears. For the current bottleneck, profile the complex template's
render/decode cost and reduce per-frame work.

## Rollback

The planner is opt-in for CCX mode; unset `TITULUS_PACK` to restore sequential
packing. Revert code changes with `git revert <merge-commit>`.
