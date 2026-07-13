# Phase 19 — Style Guide + cost model (in progress)

**Статус:** в процессе. Milestone 1 (baseline + G0) — DONE 2026-07-13.
**Программа:** `docs/performance investigation/` (docs 00–07).
**Цель фазы:** снизить стоимость кадра сложного шаблона до уровня, при котором
3× DeckLink 1080i50 дают ≥50 unique fps на `tests/templates/test1.json`.

## Milestone 1 — Baseline & G0 (DONE)

Полный отчёт: [`docs/performance investigation/reports/p19-00-baseline.md`](../performance%20investigation/reports/p19-00-baseline.md).
Raw: `engine/research/results/p19/baseline-20260713/`.

Ключевые числа (sha `0deff0c`, Ryzen 5 3600, genlock locked):

| Сценарий | Результат |
|---|---|
| DeckLink cheap 1ch | in_fps 50.0, pairs 125.5/5s, singles 0 — **TRUE 50P** |
| DeckLink complex 1ch | in_fps **41.7**, pairs 82.5 / singles 43 — MIXED |
| DeckLink complex 3ch | in_fps **25.2–26.2**, singles ~120 — PAINT_BOUND |
| null complex 1ch (N=3) | 38.0–39.7 fps |
| Chrome trace complex | raster.task ≈29.2 ms CPU-sum / unique paint; raster ≫ style+layout+paint |

Выводы:

1. G0 PASS — harness (SUMMARY / frame-log / trace / telemetry5s / stages5s) работает.
2. PRIMARY = Blink/Skia raster cost (H1). Required speedup ≥1.36× (dual-pack), цель ≥1.82×.
3. Потолок ~25 unique fps воспроизводится **только на 3ch**; 1ch complex вырос до ~42
   vs исторических ~25 — multi-channel contention (copy ×1.65, weave ×1.33) весомее,
   чем считалось (H2 — doc 03/04).

## Следующие milestone

- Doc 01: raster cost reduction (style guide, runtime, masks) → gate null `test1` ≥45 fps.
- Doc 03/04 параллельно после GATE-01: память (C1-инструментация, fewer-copy) и pinning/CCX.
- Затем G1 (1ch ≥50) → G2 (3ch ≥50) → G3 soak — критерии в doc 00 §13.
