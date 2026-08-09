# Phase 20 — Residual Microfreeze Evidence and Elimination

**Статус:** P20.1 provenance/M0 PASS; loopback L0/L1 and M1 pending.
**Supersedes as an execution checklist:** the plan-only portions of
[06-microfreeze-elimination.md](../performance%20investigation/06-microfreeze-elimination.md).
**Does not supersede:** its historical observations, safety constraints and
V8/THP/DeckLink hypothesis rationale.

## 1. Separation of phenomena

The word “дёргается” must not merge three different defects:

| Class | Pattern | Primary evidence |
|---|---|---|
| Systematic cadence | repeated short/long delivery intervals, often every output frame | semantic field IDs and P20 loopback |
| Interlace/deinterlacer trail | field-parity-dependent comb/colour trail on motion | captured field order and monitor A/B |
| Microfreeze | isolated 50–200 ms stall, historically around 5–11 s | timestamped cluster and operator correlation |

The 2026-08-09 visual report contains at least the first two candidates. It
does not prove that the historical 5–11 s microfreeze is the same root cause.
P20.3 therefore precedes V8/THP mitigation experiments.

## 2. What was and was not completed before Phase 20

Completed:

- Phase 10 stopped fresh/stale field weaving under starvation.
- Phase 11 unified the original `setInterval` timeline and rAF path and made
  DeckLink the external render clock.
- Phase 17 added optional frame-log (`interval_us`, `pump_active_us`,
  `paint_latency_us`).
- Phase 18 measured CEF BeginFrame behavior and rejected dual in-flight
  pipeline.
- Phase 19 achieved 50 average enqueue fps/field pairs on allowlisted
  compositor path.

Not completed:

- historical Phase 14 was intentionally skipped;
- P20.1 has not yet proved semantic field order after the SDI wire; only
  loopback L1 can do that;
- V8 MemoryReducer, THP/khugepaged and DeckLink-driver A/Bs were never
  causally ranked;
- `telemetry5s` remains insufficient for 50–200 ms events.

## 3. P20.1 implementation contract

### Timestamp model

Every record must contain:

- `mono_us`: monotonic clock, for interval and duration calculations;
- `unix_us`: `system_clock` Unix epoch, for joins with operator marks, GC and
  OS traces.

Never derive an external “wall clock” from `steady_clock::time_since_epoch()`.
It has no specified Unix epoch.

### Required logs

| Source | New/extended fields |
|---|---|
| Frame log | `unix_us`, `mono_us`, CEF paint sequence, BeginFrame token, rAF/timeline metadata, state revision, delivery interval and deadline status |
| DeckLink completion log | `unix_us`, completion result, display time, queue depth before pop, fresh count, A/B source IDs, pair/single/starve mode |
| Operator marks | `unix_us,event,note`; events `freeze` and `control` |
| Run manifest | build/runtime SHA, CEF/Desktop Video/SDK, template, flags, pinning, THP state, reference state |

All CSV writers are opt-in and buffered. No capture or diagnostic I/O may be
enabled by default in the DeckLink hot path.

### M0 readiness result — 2026-08-09

P20.1 now provides FrameLog v2, `BGPACING v1`, buffered DeckLink
schedule/completion events, explicit bounded-queue `input_overwrite` events,
operator marks and the microfreeze/semantic analysers. Formal 1ch
provenance-OFF/ON overhead and 3ch M0 passed; exact artifacts and limits are
in [P20.1 M0 readiness evidence](../performance%20investigation/reports/p20-01-m0-readiness.md).

The ON-vs-OFF `pump_active_us` p95 delta was `+0.207 ms`, below the P20.1
limit `max(5%, 0.5 ms) = 0.5 ms`. The 3ch five-minute run had zero
`late/drop/flush`, zero event logger overflow, no reference unlock, monotonic
event clocks and complete schedule→completion records except the expected
three-frame controlled-shutdown tail per channel. ch2/ch3 recorded two/one
queue overwrites; they are explicit source-ID events matching consumer
telemetry, not hidden logger loss. This is instrumentation readiness, not
cadence or microfreeze elimination.

### Detector implementation

Add:

- `engine/research/mark-freeze.sh`;
- `engine/research/lib/analyze-microfreeze.mjs`;
- `engine/research/p20/run-p20-pacing-probe.sh`;
- synthetic CSV fixtures and tests adjacent to the analyser.

The analyser accepts frame, completion and mark logs, extracts clusters and
reports event correlations:

```text
soft hitch       interval >= 30 ms
microfreeze      interval >= 50 ms
hard freeze      interval >= 100 ms or semantic sequence gap >= 3
cluster          events merged within 200 ms
```

Join windows:

| Pair | Window |
|---|---:|
| cluster ↔ operator freeze/control mark | ±700 ms |
| cluster ↔ DeckLink completion event | ±40 ms |
| cluster ↔ GC event | ±100 ms |
| cluster ↔ scheduler stall | ±50 ms |

## 4. Experiment order

### M0 — readiness

Run a short, non-invasive decklink and null capture. Verify headers, monotonic
rows, Unix timestamp skew versus `date +%s%6N`, and synthetic fixtures.
Failure means fix tools only; do not change engine pacing.

### M1 — detector calibration

One channel, `test` template, 15 minutes on TV Logic:

1. operator watches motion and records `freeze` only on a perceived stall;
2. engineer does not prompt the operator from logs;
3. operator writes `control` every 2–3 minutes;
4. analyse clusters after the run.

Pass:

- freeze-mark match ≥70%;
- control-mark false positive ≤20%.

If calibration fails, tune the detector protocol; do not label a host setting
as a root cause.

### M2 — causal A/B matrix

Apply one factor per run, at least three 10-minute repetitions:

| Priority | A/B | Signal required to promote |
|---|---|---|
| 1 | `--no-memory-reducer` plus trace GC | cluster rate ≤20% of baseline and GC correlation disappears |
| 2 | THP default vs `never`/deferred khugepaged | rate ≤20% of baseline with saved host state |
| 3 | null consumer vs DeckLink | DeckLink-only clusters identify output/driver path |
| 4 | Chrome trace / `perf sched` | named event joins ≥60% of clusters |
| 5 | own-code toggles | a single toggle removes clusters without harming cadence |

Do not combine V8, THP, pinning, SCHED_FIFO or template changes in one
experiment. `SCHED_FIFO` remains a separate decklink-only experiment and
soft-fail is not a failure by itself.

### M3 — mitigation and soak

Only a hypothesis with correlation evidence becomes a candidate mitigation.
After a code/config mitigation:

1. run the same P20 semantic-field and visual A/B;
2. 30-minute three-channel dev soak;
3. 60-minute three-channel validation;
4. preserve rollback instructions and all artifacts.

## 5. Acceptance

| Gate | Requirement |
|---|---|
| Instrumentation | timestamp joins work and analysis fixtures pass |
| Causality | primary hypothesis has ≥60% cluster correlation or is explicitly inconclusive |
| Hard freezes | zero per final soak |
| Microfreezes | ≤0.05/min; zero required to claim elimination |
| SDI health | zero DeckLink late/drop/flush and no reference-unlock windows |
| Cadence | loopback semantic field checks still pass |
| Visual | no S2 hitch during the operator’s sampled 15 minutes |

`in_fps≈50`, `d_pairs≈125`, average CPU load and 5-second windows alone are
not acceptance gates for this document.

## 6. Rollback and safety

Undo a confirmed mitigation independently:

- unset V8 flags and restart engines;
- restore the saved THP values;
- restore the prior Desktop Video driver/profile;
- `git revert` the relevant engine/runtime change;
- conduct a 15-minute baseline smoke before another factor.

Keep CPU-only CEF OSR, HTML5/DOM runtime, DeckLink scheduled playback and
reference timing. GPU enablement, forced self-timer on DeckLink, permanent
beacon removal and unmeasured stacked flags are forbidden.
