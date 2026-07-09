# Phase 18 P2 — null-consumer A/B sanity (Fallback pump)

**Goal:** confirm Fallback pump change does not regress null/self-timer path vs P0.2 control baseline.

**Binary:** `engine/build-p18/Release/bg_engine`  
**Channel:** `28c4b4f1-1b40-42d7-92bb-3cf15520861a` (test1 on-air)  
**Backend:** `http://127.0.0.1:3003`  
**Cores:** `0,6,1,7` · `BG_NUM_RASTER_THREADS=3` · consumer=`null` · duration=60s  
**Probe env:** `BG_P18_PIPELINE_PROBE` unset (default path only)

## Results

| label | SUMMARY fps | effectiveFps (frame-log) | paintLat p50 (µs) | vs p02-control-r1 (34.17) | verdict |
|---|---:|---:|---:|---|---|
| p02-control-r1 | 34.17 | 34.16 | 21 | baseline | — |
| p2-null-r1 | 38.44 | 38.44 | 21 | **+12.5%** (better) | PASS |
| p2-null-r2 | 39.39 | 39.40 | 21 | **+15.3%** (better) | PASS |

Pass gate: fps within ~10% of control **or better** (no major regression). Floor ≈ 30.75 fps.

## Notes

- Self-timer / null path was **not** modified for Fallback (change is `decklink_driven` only); similar-or-better fps is expected.
- paint_latency p50 unchanged at 21 µs on both runs.
- No ticks with `paint_seq_delta≥2`; max inflight_depth=1 (same shape as control).
- Artifacts: `p2-null-r{1,2}.{log,frame-log.csv,framelog.{txt,json},threads.*}`

## Verdict

**PASS** — both null probes at ~38–39 fps, above P0.2 control (~34.17). No regression on self-timer path.
