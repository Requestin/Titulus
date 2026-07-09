# Phase 18 P0.2 — Dual BeginFrame in-flight probe

**Date:** 2026-07-09  
**Binary:** `engine/build-p18/Release/bg_engine` (BG_P18_PIPELINE_PROBE)  
**Setup:** consumer=null, 1920×1080@50, duration=60s, cores=0,6,1,7, `BG_NUM_RASTER_THREADS=3`  
**Backend:** http://127.0.0.1:3003, channel=`28c4b4f1-1b40-42d7-92bb-3cf15520861a` (test1)  
**Scripts:** `run-p17-probe.sh` (control), `run-p18-inflight-probe.sh` + `analyze-p18-inflight.mjs` (probe)

## Decision rule

| pctTicksDeltaGe2 | Hint |
|---|---|
| ≥ 50% | APPROACH_A (pipeline / dual in-flight paints) |
| < 5% | APPROACH_B_OR_FALLBACK (CEF coalesces dual BeginFrame) |
| else | PARTIAL |

## Results

| Run | fps | paint_seq_delta p50/p95/mean | pctTicksDeltaGe2 | maxInflight | decisionHint |
|---|---:|---|---:|---:|---|
| control r1 | 34.16 | 0 / 0 / 0.00 | 0% | 1 | — |
| inflight r1 | 39.25 | 1 / 1 / 0.78 | 0% | 2 | APPROACH_B_OR_FALLBACK |
| inflight r2 | 39.76 | 1 / 1 / 0.79 | 0% | 2 | APPROACH_B_OR_FALLBACK |
| inflight r3 | 39.34 | 1 / 1 / 0.79 | 0% | 2 | APPROACH_B_OR_FALLBACK |
| **inflight avg** | **39.45** | **1 / 1 / 0.79** | **0%** | **2** | **APPROACH_B_OR_FALLBACK** |

Notes:

- No ERR_ABORTED (~4.2 fps) — all runs healthy (34–40 fps).
- Control: almost no unique OnPaint per tick (`paint_seq_delta` mean ≈ 0; maxInflight=1).
- Probe: dual BeginFrame raises `maxInflight` to 2 and `paint_seq_delta` p50=1, but **never** ≥2 unique OnPaints in one tick (`ticksWithDeltaGe2=0/2999` on all three runs).
- Probe also lifts effective fps (~+5 vs control) and paint_latency_us (p50 ~20 ms vs ~21 µs control) — consistent with deeper in-flight scheduling without producing two distinct paints per tick.

## Artifacts

- `p02-control-r1-{frame-log.csv,framelog.json,framelog.txt,log,threads.*}`
- `p02-inflight-rN-{frame-log.csv,framelog.*,inflight.json,inflight.txt,log,threads.*}` (N=1,2,3)

## P1 Decision Gate (one-line verdict)

**APPROACH_B_OR_FALLBACK** — avg pctTicksDeltaGe2=0% (<5%); CEF coalesces dual BeginFrame; do not pursue Approach A pipeline on this signal.
