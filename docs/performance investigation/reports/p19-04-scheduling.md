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

## Hardware gates: blocked, not waived

The canonical `test1` refers to three upload files:

- `94ae0689-77c4-41fb-89b6-49eb5d5ce280.jpg`
- `b1936396-f999-4d55-bdae-ec0686653d1c.png`
- `0d28e312-5714-44a8-9844-c2d9b003da4d.jpg`

They are absent from the available isolated data directory. Running a
DeckLink comparison without them would not be an acceptance run.

The host also requires an interactive sudo password, so governor, IRQ
affinity, and RT capability changes were not applied. No OS setting was
changed as part of this work.

Consequently the following remain open:

- paired 3-channel `test1` DeckLink baseline and sequential/CCX crossover;
- governor `schedutil` / `performance` crossover;
- evidence-led IRQ affinity experiment;
- actual `SCHED_FIFO:2` test;
- 30-minute GATE-04 and program G2.

## Next action

Restore the three canonical upload assets into an isolated `TITULUS_DATA`
directory, create/take `test1` on three DeckLink channels, and provide a
non-interactive approved mechanism for the reversible OS experiments. Then
run the planned factors one at a time and record all telemetry windows with
the doc04 collector.

## Rollback

The planner is opt-in for CCX mode; unset `TITULUS_PACK` to restore sequential
packing. Revert code changes with `git revert <merge-commit>`.
