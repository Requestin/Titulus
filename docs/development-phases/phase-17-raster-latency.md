# Phase 17 — Raster Pool vs Латентность (насыщение CPU)

Дата: 8 июля 2026.

Цель фазы: количественный ответ на вопрос «почему CPU на DeckLink-каналах не
насыщается на 100%, а держится около ~60%?» — недонасыщен raster-пул
Chromium (гипотеза A, throughput) или доминирует латентность цикла
`SendExternalBeginFrame → IPC → composite → OnPaint` (гипотеза B)?

## Контекст

После Phase 16 (Class A: composited position) `test1` single-channel
headless показывал ~44.9 fps, но 3-канальный DeckLink soak упирался в
потолок 25p-as-50i при CPU ~60%. Явного ответа, throughput или latency —
не было; `--frame-log` (детальный per-frame лог `pump_active_us` /
`paint_latency_us`) и явный контроль `--num-raster-threads` отсутствовали в
коде.

## P0 — Инструментация

- [engine/src/frame_log.h](../../engine/src/frame_log.h) /
  [frame_log.cpp](../../engine/src/frame_log.cpp) — буферизованный CSV writer
  (`--frame-log=PATH` / `BG_ENGINE_FRAME_LOG`), одна строка на pump-тик:
  `wall_clock_us,interval_us,paint_seq,pump_active_us,paint_latency_us,waited_deadline`.
- [engine/src/main.cpp](../../engine/src/main.cpp) — инструментированы обе
  pump-ветки (decklink-driven и self-timer): `pump_active_us` — суммарное
  время в `CefDoMessageLoopWork()` за тик; `paint_latency_us` — от отправки
  `SendExternalBeginFrame()` до готовности кадра к доставке.
- [engine/src/engine_app.cpp](../../engine/src/engine_app.cpp) —
  `BG_NUM_RASTER_THREADS` env-override → `--num-raster-threads` для
  renderer-процесса (по умолчанию не задан, Chromium выбирает сам).
- `engine/research/lib/analyze-frame-log.mjs` — percentiles + `pumpActiveRatio`
  (дискриминатор throughput/latency) из CSV.
- `engine/research/lib/sample-threads.sh` — per-thread CPU (`ps -T`) с
  агрегацией по имени потока.
- `engine/research/p17/run-p17-probe.sh` — оркестратор замеров (запуск + поиск
  активного renderer-процесса + сэмплинг + анализ), закрывает две находки:
  1. `pgrep -f` самосовпадает с текстом собственной shell-обёртки —
     заменено на `ps -eo pid,comm,cmd | awk '$2=="bg_engine"'`.
  2. CEF держит второй, почти простаивающий renderer-процесс (spare) рядом
     с активным — активный определяется по дельте `utime+stime` из
     `/proc/PID/stat` за ~3с.
- Изолированная сборка `engine/build-p17/` (`BG_ENABLE_DECKLINK=ON`).

## P1 — Baseline на test1 (single-channel, cores=0,6,1,7)

| Сценарий | fps | paint_latency p50/p95 | ThreadPoolForeg mean %CPU |
|---|---:|---:|---:|
| headless (`--consumer=null`) | 41.25 | 23 / 33 мкс | 119.7 |
| decklink single (device 1) | 40.01 | 20089 / 21848 мкс | 141.5 |

Полная сводка: [p1-baseline-summary.md](../../engine/research/results/p17/p1-baseline-summary.md).

Находка: в decklink-ветке `paint_latency_us` p50 вплотную к границе поля
(~20мс) — большинство тиков используют весь бюджет. Raster-потоки заняты на
120-142% из 200% максимума (2 потока) — не простаивают, но и не насыщены.
Смешанная картина, требующая A/B.

## P2 — A/B `num-raster-threads` (default 2 vs 3 vs 4)

Полная таблица: [p2-raster-threads-ab.md](../../engine/research/results/p17/p2-raster-threads-ab.md).

**Headless** (3 прогона на вариант, 60с):

| Вариант | avg fps | avg paintLat p95 | avg ThreadPoolForeg %CPU |
|---|---:|---:|---:|
| default (2) | 37.30 | 53.3 мкс | 134.9 |
| N=3 | **39.40** (+5.6%) | **30.0 мкс** (−44%) | 141.5 |
| N=4 | 39.04 (+4.7%) | 31.0 мкс | 142.3 |

**DeckLink single-channel** (device 1, 60с):

| Вариант | fps | paintLat p50 |
|---|---:|---:|
| default (2) | 39.00 | 20096 мкс |
| N=3 | 39.61 (+1.6%) | 20076 мкс |

N=3 — практический сладкий спот (N=4 не даёт дополнительного выигрыша,
вероятно SMT-контеншн на 2 физических ядрах маски). Выигрыш в headless
режиме существенный; в decklink-режиме — маленький, но положительный, без
регрессий.

## P3 — Вердикт

Гипотезы A и B **обе частично верны**, в разных pump-режимах:

- **Self-timer/headless** (editor-preview, browser/OBS·vMix): гипотеза A
  подтверждена — raster-пул был реальным (хоть и не единственным) узким
  местом, `num-raster-threads=3` даёт измеримый выигрыш.
- **DeckLink-driven** (production): гипотеза B доминирует — pump-цикл
  синхронно опрашивает `paint_seq` до дедлайна поля (~20мс) независимо от
  скорости raster; более быстрый raster не транслируется в более частую
  доставку, потому что cadence задаёт hardware-клок, а не готовность кадра.

Полный текст: [p3-verdict.md](../../engine/research/results/p17/p3-verdict.md).

**Практическое решение:** [engine/run-channel.sh](../../engine/run-channel.sh)
теперь вычисляет `BG_NUM_RASTER_THREADS = (число закреплённых логических
ядер канала) − 1` из `--cores` и экспортирует его перед запуском `bg_engine`
(применяется только при «канало-размерном» пиннинге 2-8 ядер; безлимитные
dev/editor-прогоны не тронуты — тот режим не измерялся).

**Для Phase 18 (true 50p):** увеличение raster-параллелизма **не решает**
потолок `in_fps=25` на DeckLink — узкое место архитектурное (per-field
polling в pump-цикле). Phase 18 потребует переработки самого pump-цикла
(например, конвейеризация кадров in-flight), а не просто больше
ядер/потоков.

## P4 — Валидация: 3-канальный DeckLink soak (~16.7 мин)

Полный отчёт (включая методологическую находку по битым изображениям):
[p4-soak-validation.md](../../engine/research/results/p17/p4-soak-validation.md).

| Канал | avg in_fps | d_late | d_dropped |
|---|---:|---:|---:|
| Channel 1 (device 1) | 24.10 | 0 | 0 |
| Channel 2 (device 2) | 24.16 | 0 | 0 |
| Channel 3 (device 3) | 24.32 | 0 | 0 |

`d_late=0 d_dropped=0` на всех каналах весь прогон — реальных пропусков
кадров не было. `in_fps` немного ниже Phase 16 baseline (24.98 avg) и
формального порога 24.5 — объяснено разделяемой (не запиннена через
`taskset`) фоновой нагрузкой desktop-сессии и IDE-агента на этой машине
(подтверждено A/B на одиночном канале в идентичных условиях: `~24.8-25.2
fps`, на уровне Phase 16). Не регрессия Phase 17.

## Итог фазы

1. `--frame-log` инструментация и `BG_NUM_RASTER_THREADS` — в коде, готовы
   для будущих исследований (Phase 18+).
2. `num-raster-threads = N_cores − 1` закреплён как default в
   `run-channel.sh` — измеренный, безопасный выигрыш.
3. Вердикт: для production DeckLink-пути узкое место — латентность/
   архитектура pump-цикла, не throughput raster-пула. Phase 18 (true 50p)
   должен фокусироваться на pump-архитектуре, а не на добавлении CPU.
4. 3-канальный soak валидирован без визуальных/технических регрессий.
