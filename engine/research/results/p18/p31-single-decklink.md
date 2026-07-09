# Phase 18 P3.1 — Single-channel DeckLink steady-state (Channel 1, test1)

**Date:** 2026-07-09  
**Log:** `logs/engine-Channel_1.log`  
**Setup:** Channel 1 DeckLink Quad 2, HD1080i50, test1 on-air (engines not restarted)  
**Window:** last 12 × 5s telemetry windows after take (≈60s)  
**Result:** **PASS (partial) — hard criteria met; d_pairs growth vs P17 baseline not noticeable in steady-state last-12**

## Pass criteria

| Criterion | Target | Observed | OK? |
|-----------|--------|----------|-----|
| d_late | 0 | sum=0, any>0=False | yes |
| d_dropped | 0 | sum=0, any>0=False | yes |
| d_pairs | > 0 (noticeable growth vs P17 0–9/window) | sum=19, avg=1.58/window, max=6 | yes (growth noticeable: no) |

## Aggregates (last 12 windows)

| Metric | min | avg | max | sum |
|--------|-----|-----|-----|-----|
| in_fps | 25.0 | 25.30 | 26.0 | — |
| d_pairs | 0 | 1.58 | 6 | 19 |
| d_singles | 119 | 123.83 | 126 | 1486 |
| d_starved | 0 | 0.08 | 1 | 1 |
| d_late | 0 | 0.00 | 0 | 0 |
| d_dropped | 0 | 0.00 | 0 | 0 |

## Per-window (last 12)

| # | in_fps | out_fps | d_pairs | d_singles | d_starved | d_late | d_dropped | ref |
|---|--------|---------|---------|-----------|-----------|--------|-----------|-----|
| 1 | 25.2 | 25.0 | 1 | 124 | 0 | 0 | 0 | locked |
| 2 | 25.0 | 25.0 | 0 | 125 | 0 | 0 | 0 | locked |
| 3 | 25.6 | 25.0 | 3 | 122 | 0 | 0 | 0 | locked |
| 4 | 25.0 | 25.0 | 0 | 126 | 0 | 0 | 0 | locked |
| 5 | 25.2 | 25.0 | 1 | 124 | 0 | 0 | 0 | locked |
| 6 | 25.0 | 25.0 | 0 | 126 | 0 | 0 | 0 | locked |
| 7 | 25.4 | 25.0 | 2 | 124 | 0 | 0 | 0 | locked |
| 8 | 25.4 | 25.0 | 2 | 124 | 0 | 0 | 0 | locked |
| 9 | 25.4 | 25.0 | 2 | 123 | 0 | 0 | 0 | locked |
| 10 | 25.0 | 25.0 | 0 | 126 | 0 | 0 | 0 | locked |
| 11 | 25.4 | 25.0 | 2 | 123 | 0 | 0 | 0 | locked |
| 12 | 26.0 | 25.0 | 6 | 119 | 1 | 0 | 0 | locked |

## Phase 17 baseline (comparison)

On test1 3ch DeckLink (Phase 17):

| Metric | P17 baseline | P18 P3.1 (this run, last 12) |
|--------|--------------|------------------------------|
| in_fps | ≈24–25 | 25.30 (min 25.0, max 26.0) |
| d_pairs / 5s | ≈0–9 | avg 1.58, range 0–6 |
| d_singles / 5s | ≈110–120 | avg 123.83, range 119–126 |

Steady-state last-12 looks **similar to P17** on pairs/singles (pairs still in 0–3 band, not a clear lift).  
Early post-take (first 12 windows after in_fps drop) had higher pairs: avg d_pairs=20.83 (min 0, max 48), in_fps avg=29.12 — likely warm-up / transition, not steady-state.

## Notes

- Take detected at telemetry window index 4 (first `in_fps < 40` after empty `in_fps ≥ 48`).
- Post-take windows available: 25; analysis uses last 12.
- `out_fps` stayed 25.0; `ref=locked` throughout analyzed windows.
- Engines were not restarted for this collection.

## Verdict

**PASS (partial) — hard criteria met; d_pairs growth vs P17 baseline not noticeable in steady-state last-12**

- Hard: d_late=0, d_dropped=0, d_pairs sum=19 (>0).
- Growth goal vs P17: not met in steady-state — d_pairs remains ≈0–3/window like P17.
