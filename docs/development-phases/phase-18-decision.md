# Phase 18 — Decision Gate (P1)

**Дата:** 2026-07-09  
**Ветка:** `feature/phase-18-true-50p`  
**Входы:** P0.1 [`engine/research/results/p18/p01-raster-budget.md`](../../engine/research/results/p18/p01-raster-budget.md), P0.2 [`p02-inflight-probe.md`](../../engine/research/results/p18/p02-inflight-probe.md), P0.3 [`p03-ipc-breakdown.md`](../../engine/research/results/p18/p03-ipc-breakdown.md)

## Правило выбора (из плана)

| Данные P0 | Решение |
|---|---|
| P0.2: CEF in-flight работает (`paint_seq` delta ≥2) | **Подход A** — конвейеризация pump |
| P0.2: in-flight не работает, P0.1: raster p95 ≤10 мс | **Подход B** — sequential 2-raster в одном поле (20 мс) |
| P0.2: in-flight не работает, raster p95 ~20 мс | **Fallback** — incremental pairing + документация блокера |

## Факты P0

| Вопрос | Результат | Вывод |
|---|---|---|
| P0.2 dual BeginFrame in-flight | `pctTicksDeltaGe2 = 0%` на 3×60 с; max depth=2, но уникальных OnPaint за тик ≤1 | CEF OSR **коалесцирует** dual BeginFrame → **A отвергнут** |
| P0.1 raster budget test1 | headless ~27 fps; RasterTask CPU-sum ~13.5 мс/frame; Phase-15 rasterMs p95 ~191 мс (sum) | **не ≤10 мс** → классический B (2 raster в 20 мс поле) **не обоснован** |
| P0.3 IPC vs raster | Mojo Σ dur ≪ RasterTask (~23×) | bottleneck не Mojo round-trip; raster/composite + pump pacing |

Доп. сигнал P0.2: probe поднял effective fps ~34→~39 на null без двух уникальных paint за тик — pacing/занятость pump влияет на throughput даже без true pipeline.

## Решение: **Fallback — eager sequential field packing**

Не Approach A (in-flight dual BF). Не классический Approach B (два полных raster в одном 20 мс поле).

**Что делаем в P2:**

1. **DeckLink pump (`main.cpp`, только `decklink_driven`):** убрать принудительный sleep до `tick_deadline` между sub-tick’ами одной пары `WaitForTick` (строки pacing после раннего paint). После доставки paint тика N сразу стартовать BeginFrame тика N+1. Бюджет пары полей = ~40 мс output frame (1080i50); два последовательных ~15–20 мс raster **могут** уместиться, если не сжигать slack после раннего OnPaint. Это **не** dual in-flight: второй BF только после `paint_seq` change (или timeout) первого → коалесцирование P0.2 не воспроизводится.
2. **`kMaxQueuedFrames`:** 2 → 3 в `decklink_consumer.cpp`, чтобы при ускоренной доставке не терять intermediate bitmap (`frames_overwritten`).
3. **Телеметрия:** целевой сигнал — рост `d_pairs`, падение `d_singles` vs Phase 17 baseline (`d_pairs≈0–9`, `d_singles≈110–120` / 5 с). `d_late=0`, `d_dropped=0` обязательны.
4. **Документация блокера:** CEF OSR этой сборки не пипелайнит два BeginFrame; probe `BG_P18_PIPELINE_PROBE` оставляем для будущих CEF.
5. **Не делаем:** runtime `applySubFrame` / fractional seek (P2.A.2) — интерполяция не нужна; timeline уже 50 fps, нужны два последовательных уникальных bitmap на output frame. Self-timer / null / pipe / preview / stream path не меняем (кроме уже существующего probe за env).

## Критерии успеха P3 (зафиксированы здесь)

| Метрика | Цель |
|---|---|
| `d_late`, `d_dropped` | 0 на всех каналах весь soak |
| `in_fps` | ≥ 24.5 (как Phase 17 P4) |
| `d_pairs` | заметный рост vs Phase 17 (ориентир: стабильно >0 в каждом 5 с окне; идеал — существенная доля vs `d_singles`) |
| Визуально (P3.3) | плавнее движение на SDI (TV Logic) на `test1` |

Если после P2 `d_pairs` остаётся ~0 при `d_late=0` — Fallback не раскрыл headroom; фаза документирует потолок и CEF-блокер, без ложного claim true 50p.

## Что отвергнуто и почему

- **A (pipeline pump):** P0.2 — 0% тиков с ≥2 уникальными OnPaint.
- **B (2 raster / 20 мс поле):** P0.1 — нет доказанного ≤10 мс wall-clock p95 на test1; end-to-end ~27 fps headless.

## Следующий шаг

P2 реализация Fallback → null A/B sanity → P3 DeckLink (device 1, затем 3ch soak) → P4 отчёт + PR.
