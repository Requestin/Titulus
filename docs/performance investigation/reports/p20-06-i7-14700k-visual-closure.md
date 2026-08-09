# P20.6 — i7-14700K cross-host visual closure

**Дата:** 2026-08-10  
**Статус:** visual acceptance PASS; strict on-wire zero-anomaly gate deferred  
**Scope:** dev/hardware-validation, DeckLink Quad 2, HD1080i50, `one_tick`,
`layered=off`, complex `p20-test1-visual`.

## Цель

Проверить, устраняет ли более быстрый hybrid CPU наблюдаемые микрофризы на
сложном `test1`, не подменяя visual verdict средним FPS.

## Среда

- Host: Intel Core i7-14700KF, Ubuntu 24.04, kernel `7.0.0-28-generic`.
- Desktop Video / DKMS driver: `16.0a14`; Secure Boot module signature
  accepted.
- DeckLink Quad 2: Reference In on port 1; output port 5 (`device-index=1`)
  looped to input port 6 (`device-index=2`); visual outputs on ports 7 and 9
  (`device-index=2,3`).
- Harness affinity: three channels use SMT P-core masks `0-3`, `4-7`, `8-11`;
  two P-cores and all E-cores remain outside render affinity.
- Runtime assets: `p20-test1-{1.jpg,2.png,3.jpg}` were installed in the
  persistent backend `/uploads` storage. `tests/files/` is not an HTTP static
  root and cannot by itself satisfy `/uploads/...` template paths.

## Evidence

| Cell | Result |
|---|---|
| Null, 1ch `p20-test1-visual`, 5 min | 49.973 poses/s, `(1,1)=100%` |
| Null, 3ch `p20-test1-visual`, 5 min | 49.948 / 49.959 / 49.919 poses/s, `(1,1)=100%` |
| DeckLink L1 marker, 30 s, port 5 → 6 | Joint evidence PASS: 1,500 decoded fields, continuous reference, healthy logger/delivery/producer and zero measurement `single`/`overwrite` |
| DeckLink, 1ch visual on port 7, 5 min | Operator observed no freezes; 50.002 poses/s, `(1,1)=100%`, zero late/drop/flush; 3 `single` and 2 `input_overwrite` |
| DeckLink, 3ch visual, 15 min | Operator observed no freezes. `one_tick` cadence was 49.994 / 49.998 / 49.994 poses/s with `(1,1)=100%`; zero late/drop/flush on every channel |

The 3ch M0 residuals were:

| Channel | `single` | `input_overwrite` |
|---|---:|---:|
| 1 | 7 | 5 |
| 2 | 8 | 8 |
| 3 | 11 | 9 |

They are real measurement-window events, not statistical error: a `single`
selects one fresh source for an interlaced pair and an `input_overwrite`
replaces an unused queued input. They are nevertheless approximately two
orders of magnitude below the preceding Ryzen 3600 1ch visual run (913
singles and 25 overwrites in five minutes), and were not visible to the
operator.

## Verdict and boundary

The user-visible Phase 20 goal is accepted: on the complex `test1` fixture,
the i7 host removed the observed microfreezes in both one-channel and
three-channel visual validation. The causal result is consistent with a
latency-bound CEF/CPU critical path on Ryzen rather than a DeckLink delivery
fault: `one_tick` retains a clean logical cadence, while stronger P-cores
reduce residual queue pressure enough to remove the visual symptom.

This does **not** claim formal P20.2 zero-anomaly on-wire closure:

- the final 3ch 60-minute soak was not run;
- the 3ch visual cell was telemetry-observed rather than loopback-captured;
- strict semantic acceptance still requires zero duplicate/skip/reversal and
  zero steady-state `single`/`overwrite`.

Those stricter SDI-semantic requirements are documented as deferred evidence,
not silently promoted to PASS. They must be reopened if a future scope requires
a formal zero-error on-wire claim or production acceptance.

## Artifacts

The i7 host retained raw manifests, engine logs, FrameLog, DeckLink completion
logs, capture CSV and analyses under:

```text
/home/requestin/Titulus-evidence/
  hardware-l1-marker-retry-2026-08-10T0148Z/
  hardware-test1-visual-ch2-5m-2026-08-10T0210Z/
  hardware-test1-visual-3ch-15m-2026-08-10T0220Z/
```

## Rollback

No runtime default was changed. Revert the P20 tooling/documentation commits or
return to the Ryzen host configuration; DeckLink connector mapping remains
explicit and must be rediscovered after any profile change.
