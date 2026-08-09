# Phase 19 — Style Guide + cost model

**Статус:** DONE — Doc02 audit recovery merged as PR #84.
**Программа:** `docs/performance investigation/` (docs 00–07).
**Цель фазы:** снизить стоимость кадра сложного шаблона до уровня, при котором
3× DeckLink 1080i50 дают ≥50 unique fps на `tests/templates/test1.json`.

> **Контекст:** это dev-проект и hardware/performance стенд; действующих
> эфирных или production-инсталляций нет. DeckLink-каналы используются для
> свободных визуальных и измерительных экспериментов. Production safeguards
> остаются документацией для будущего rollout, а не блокером текущей разработки.

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

## Milestone 2 — Doc 01 raster cost reduction (DONE 2026-07-14)

Полный отчёт: [`docs/performance investigation/reports/p19-01-raster-cost.md`](../performance%20investigation/reports/p19-01-raster-cost.md).
Style Guide: [`docs/performance investigation/style-guide.md`](../performance%20investigation/style-guide.md).
Raw: `engine/research/results/p19/doc01-20260714/`.

Диагноз: bottleneck **raster-bound** (BGSTATS: writes/f=10, applyMs/f≈0.16 — не JS;
trace: raster.task ≫ style+layout+paint). Главный виновник — **inverted полноэкранная
SVG luminance mask-image** (ablation: −8.69 fps).

Фикс (runtime-only, `runtime/src/maskScopes.ts`): inverted axis-aligned rect mask без
скругления → `clip-path: polygon(evenodd)` вместо mask-image. Pixel-exact (md5 кадров
идентичны), `test1.json` не изменён, выигрывают все шаблоны с такими масками.

| Метрика | До | После |
|---|---|---|
| null test1 (warm, median) | 40–41 | **50** |
| null gate ×3 (median avg) | ~40 | **49.78** (PASS ≥45) |
| 1ch DeckLink in_fps | 41.7 | **47.6** |
| 3ch DeckLink in_fps | 25–26 | **29–32** |

Регрессий нет: cheap `test` 50.0, bench 3ch 49.94, static beacon 50.0.
Также добавлена runtime-инструментация: `maskWrites`/`textWrites` в RenderStats, `?stats=1`
BGSTATS console line, форвардинг console→лог в `engine_client.cpp` (`OnConsoleMessage`).

## Milestone 3 — Doc 03 fewer-copy memory pipeline (DONE, partial gate)

Полный отчёт: [`docs/performance investigation/reports/p19-03-memory-pipeline.md`](../performance%20investigation/reports/p19-03-memory-pipeline.md).
Evidence: `engine/research/results/p19/doc03-20260714/`.

| Изменение | Результат |
|---|---|
| PR #68 `memory5s` instrumentation | C1/C2/clone/weave/pool traffic измеримы |
| PR #69 singles alias | `singles_clone_bytes=0`; 15min 3ch soak без late/drop/flush |
| PR #70 direct paint flag | C1 `ring_bytes=0`; 30min soak безопасен, но flag остаётся OFF |
| Pools / huge pages | Не менялись: miss rate <0.1%, `MADV_HUGEPAGE` не обоснован |

Fresh 3ch baseline подтвердил: C1 + C2 + clone дают несколько GB traffic на канал каждые
5 секунд. Но final default 3ch остаётся **27.6 / 28.0 / 30.8 in_fps** (G2 FAIL), хотя
clone устранён. Direct path не даёт устойчивого throughput uplift в crossover OFF/ON,
поэтому ownership ring отложен как неоправданная сложность.

## Итоговые milestone

- **Doc 04 (pinning/CCX)** — hardware gate complete: sequential, CCX and
  `performance` governor produced no reliable throughput uplift on 3× DeckLink
  `test1`; sequential / `schedutil` remain defaults. The ≥30-minute GATE-04
  has zero late/drop/flush or reference-unlock windows, but its limiting
  channel is only 28.0 median `in_fps`: delivery stability passes, program G2
  fails. `SCHED_FIFO` needs a future systemd AmbientCapabilities experiment;
  file capabilities are incompatible with the CEF binary on this host.
  Evidence: `engine/research/results/p19/doc04-20260715/`; report:
  [`p19-04-scheduling.md`](../performance%20investigation/reports/p19-04-scheduling.md).
- **Doc 02 (CPU layer compositor)** — **audit-recovery K2 PASS.** Fresh review
  found that the original STOP measured an unoptimized and revision-unstable
  path. PR7 AVX2/worker-pool, PR8 dirty/cache/ownership and PR9 allowlist/soak
  hardening are now implemented. Fresh ABBA: 1ch treatment **50.0 fps**;
  3ch treatment **50.0 / 50.0 / 50.0**, worst paired uplift **1.5748×**,
  late/drop/flush/unlock=0. Static parity SSIM **0.999062**; byte-exact
  incremental/full goldens pass. Global default remains OFF; production opt-in
  is template-id allowlist only. Evidence:
  `engine/research/results/p19/doc02-20260715/k2-gate/audit-recovery-20260716.md`;
  report:
  [`p19-02-layer-compositor.md`](../performance%20investigation/reports/p19-02-layer-compositor.md).
- Doc02 clears G1/G2 throughput for canonical `test1` and passed the recorded
  15-minute 1ch (180 windows) and 60-minute 3ch
  (720 windows/channel) stability soaks at 50.0 fps with zero delivery errors.

## Граница результата

Phase 19 доказал throughput и DeckLink delivery health, но не заменяет
субъективную проверку temporal pacing. Визуальные тесты 2026-08-09 показали
неровную плавность и микрофризы при `in_fps≈50`, `d_pairs≈125` и нулевых
DeckLink `late/drop/flush`. Эти значения подтверждают скорость enqueue и
scheduled playback, но не равномерность semantic animation states и не
исключают interlace/deinterlacer artifacts.

Дальнейшая работа не является повторным открытием K2 или отменой результатов
Doc02. Она вынесена в
[`phase-20-visual-frame-pacing.md`](phase-20-visual-frame-pacing.md):
отдельно измеряются timeline cadence, CEF paint, weave field identity и
фактический SDI loopback.
