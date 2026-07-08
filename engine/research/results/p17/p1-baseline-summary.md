# Phase 17 P1 — Baseline (test1, single channel, cores=0,6,1,7 pinned)

Обе замера — изолированный backend `:3003` (`/tmp/titulus-p17-data`, клон seed из Phase 16),
`engine/build-p17/` (BG_ENABLE_DECKLINK=ON, идентичен build-p15/build кроме Phase 17
инструментации), 60с, `taskset -c 0,6,1,7` (та же маска, что у продакшн-канала 1).
Продакшн-каналы (device 1/2/3) остановлены на время замера — подтверждено пользователем
как тестовые (см. `.cursor/rules/git-workflow.mdc` сессионные заметки).

## SUMMARY

| Сценарий | fps | interval p50/p95 (мс) | timedOutTicks/rows |
|---|---:|---:|---:|
| headless (`--consumer=null`) | 41.25 | 20.0 / 40.0 | 531/2999 |
| decklink single (`device-index=1`) | 40.01 | 21.8 / 40.4 | 515/2969 |

## frame-log (BeginFrame→OnPaint / pump)

| Метрика | headless | decklink |
|---|---:|---:|
| pump_active_us p50/mean | 907 / 813 | 974 / 868 |
| paint_latency_us p50/p95/mean | 23 / 33 / 35 | **20089 / 21848 / 17986** |
| pumpActiveRatio (browser-process loop only) | 0.033 | 0.040 |

**Важная методологическая находка:** `pump_active_us`/`pumpActiveRatio` измеряют время
внутри `CefDoMessageLoopWork()` в **browser-процессе** (диспетчеризация IPC), а не
фактическую растеризацию, которая идёт асинхронно в **renderer-процессе**. На обоих
сценариях `pumpActiveRatio` мал (~0.03-0.04) — это ожидаемо и **не** говорит о том, что
интервал кадра тратится на латентность, а не растеризацию: browser-процесс почти всё
время просто ждёт (короткими 4мс срезами), пока renderer асинхронно всё сделает.
Дискриминатор A/B для browser-процесса неинформативен сам по себе — нужен per-thread
CPU renderer-процесса (ниже) и, для decklink-ветки, `paint_latency_us` (там это честная
метрика BeginFrame→OnPaint, т.к. код синхронно ждёт пейнта или дедлайна поля).

В decklink-сценарии `paint_latency_us p50=20089us` практически равен полному полю
(~20мс) — большинство тиков **исчерпывают весь бюджет поля**, ожидая пейнт
(`timedOutTicks=515/2969 ≈ 17%` тиков не получили новый пейнт вовсе, ушли по таймауту
и переиграли на следующем тике). Это сильный сигнал, что весь цикл
`SendExternalBeginFrame → IPC → composite → OnPaint` вплотную подходит к границе
20мс-бюджета.

## Per-thread CPU (renderer-процесс, `sample-threads.sh`, ~52 сэмпла)

| comm (поток) | headless max/mean %CPU | decklink max/mean %CPU |
|---|---:|---:|
| ThreadPoolForeg (raster workers) | 124.0 / 119.7 | 145.0 / 141.5 |
| bg_engine (main+IO group) | 15.0 / 13.6 | 15.0 / 13.6 |
| Compositor | 4.0 / 4.0 | 4.0 / 4.0 |
| остальные (ThreadPoolSingl/Servi, HangWatcher, PerfettoTrace, Chrome_ChildIOT) | ~0 | ~0 |

`num-raster-threads` авто-выбор Chromium на 4 закреплённых логических ядрах (`0,6,1,7`)
= **2** (подтверждено в командной строке renderer-процесса). Максимум для 2 потоков —
200% CPU. Наблюдаемые ~120-142% mean — **существенная, но не полная загрузка**
raster-пула (60-71% от теоретического максимума 2 потоков). Ядро (`Compositor`,
`bg_engine` main) почти не загружено (<20% суммарно).

## Вывод P1 (входные данные для P2/P3)

Картина смешанная, не однозначно A или B:
- Raster-потоки заметно заняты (~140% из 200% возможных) — не «простаивают», что было
  бы чистым сигналом B (латентность без реальной работы).
- Но они и не насыщены (200%) — есть арифметический запас параллелизма, если увеличить
  `num-raster-threads`.
- `paint_latency_us` в decklink-сценарии вплотную к границе поля (20мс) — реальный
  round-trip BeginFrame→OnPaint почти исчерпывает бюджет independent от загрузки CPU.

Это ровно тот случай, для которого нужен **P2 A/B**: если `num-raster-threads=4` даёт
измеримый (>5%) прирост fps/снижение paint_latency — вклад A подтверждён (пусть и не
единственный). Если прирост в пределах шума — латентность (B, IPC round-trip
per se) доминирует и больше потоков не поможет.
