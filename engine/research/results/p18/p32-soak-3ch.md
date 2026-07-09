# Phase 18 P3.2 — 3-channel DeckLink soak (test1, ≥15 min)

**Date:** 2026-07-09  
**Binary:** Phase 18 Fallback (engines not restarted)  
**Channels:** DeckLink Quad 2 devices 1/2/3, HD1080i50, fill_only  
**Template:** test1 on-air all three (verified via `/api/onair`)  
**Soak mark:** `2026-07-09T15:39:28Z` (`p32-soak-start.txt`)  
**Soak end:** `2026-07-09T15:57:29Z` (~18 min wall; analysis after 60s settle)  
**Logs:** `logs/engine-Channel_{1,2,3}.log`  
**Heartbeats:** `p32-soak-heartbeat.txt` (4×240s, engines=3 throughout)

## Method

- `telemetry5s` lines time-aligned to first `frames=` timestamp (`15:38:30Z`) at 5s/index (stdout buffering splits tel vs frame lines).
- Analysis window: **15:40:30Z → 15:57:25Z** (skip first ~60s after soak mark for take settle).
- Prefer content-loaded windows with `in_fps ∈ [24, 35]` (exclude empty-channel ~50; Ch1 also had 12 windows with `in_fps < 24` excluded from primary aggregates — noted below).

## Pass criteria

| Criterion | Target | Ch1 | Ch2 | Ch3 | OK? |
|-----------|--------|-----|-----|-----|-----|
| d_late | 0 entire run | 0 | 0 | 0 | **yes** |
| d_dropped | 0 entire run | 0 | 0 | 0 | **yes** |
| in_fps ≥ 24.5 | all windows | min **24.0** in content set; **38** full-soak wins &lt;24.5 (min **23.0**) | min 24.8 | min 24.6 | **no** (Ch1) |
| d_pairs vs P17 (0–9/win) | noticeable lift | avg 2.82, max 17 | avg 2.01, max 11 | avg 1.62, max 8 | **no** (still P17-like) |
| no degradation over time | first vs last third | 25.15 → 24.58 (Δ **−0.58**) | 25.07 → 25.02 (Δ −0.05) | 25.17 → 25.02 (Δ −0.15) | **no** (Ch1) |

## Aggregates (content window `in_fps` 24–35)

| Ch | windows | in_fps min/avg/max | d_pairs min/avg/max (Σ) | d_singles avg | d_starved Σ | d_late Σ | d_dropped Σ |
|----|---------|--------------------|-------------------------|---------------|-------------|----------|-------------|
| 1 | 192 | 24.0 / **24.93** / 26.0 | 0 / **2.82** / 17 (**542**) | 119.55 | 608 | 0 | 0 |
| 2 | 204 | 24.8 / **25.06** / 25.4 | 0 / **2.01** / 11 (**410**) | 121.87 | 353 | 0 | 0 |
| 3 | 204 | 24.6 / **25.10** / 25.6 | 0 / **1.62** / 8 (**331**) | 122.80 | 228 | 0 | 0 |

### Degradation (first third vs last third avg `in_fps`)

| Ch | first ⅓ | last ⅓ | Δ | Verdict |
|----|---------|--------|---|---------|
| 1 | 25.15 | 24.58 | −0.58 | **degraded** — late soak dip cluster (~15:56) with `in_fps` 23–24.4 and elevated `d_starved` |
| 2 | 25.07 | 25.02 | −0.05 | stable |
| 3 | 25.17 | 25.02 | −0.15 | stable (noise) |

### Thirds detail (avg)

| Ch | third | in_fps | d_pairs avg | d_starved avg |
|----|-------|--------|-------------|---------------|
| 1 | 1st / 2nd / 3rd | 25.15 / 25.07 / 24.58 | 1.31 / 2.09 / 5.06 | 0.56 / 1.75 / 7.19 |
| 2 | 1st / 2nd / 3rd | 25.07 / 25.07 / 25.02 | 1.18 / 2.29 / 2.56 | 0.81 / 1.93 / 2.46 |
| 3 | 1st / 2nd / 3rd | 25.17 / 25.11 / 25.02 | 1.34 / 1.54 / 1.99 | 0.49 / 0.97 / 1.90 |

## Phase 17 comparison

| Metric | P17 3ch test1 baseline | P18 P3.2 (this soak) |
|--------|------------------------|----------------------|
| in_fps | ≈24–25 | Ch2/3 ≈25.1; Ch1 avg 24.93 with late dips to 23 |
| d_pairs / 5s | ≈0–9 | avg 1.6–2.8, max 8–17 — **same band**, not a clear lift |
| d_singles / 5s | ≈110–120 | avg 119–123 |
| d_late / d_dropped | 0 expected | **0 / 0** all channels |

`d_pairs > 0` in ~66–82% of windows, but magnitude remains P17-like (mostly 0–3, occasional spikes). **Not** a noticeable growth vs Phase 17.

## Notes

- Engines PIDs unchanged through soak (1136973 / 1136979 / 1136982); heartbeats every 4 min OK.
- Ch1 late dip: 12 windows with `in_fps < 24` excluded from primary table; full-soak min 23.0. Recovered to ~25.2 by end of log.
- `out_fps` stayed 25.0; `ref=locked` on sampled telemetry.
- Aligns with P3.1 finding: hard SDI health OK; Fallback does not lift steady-state pairs vs P17.

## Verdict

**FAIL (partial hard-pass)**

- **PASS:** `d_late=0`, `d_dropped=0` on all three channels for entire analyzed soak.
- **FAIL:** Ch1 `in_fps` not ≥24.5 for all windows (38 full-soak windows &lt;24.5 from ~15:51; min 23.0).
- **FAIL:** `d_pairs` not noticeably above Phase 17 (0–9/window) — avg still ~1.6–2.8.
- **FAIL:** Ch1 shows time degradation (first→last third Δ −0.58 fps); Ch2/Ch3 OK.

