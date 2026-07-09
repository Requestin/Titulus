# Phase 18 P0.1 — Raster budget baseline (headless)

**Дата:** 2026-07-09  
**Окружение:** backend `http://127.0.0.1:3003`, `TITULUS_DATA=/tmp/titulus-p18-data`, channel `28c4b4f1-1b40-42d7-92bb-3cf15520861a`  
**Binary:** `engine/build-p18/Release/bg_engine`  
**Probe:** `run-p17-probe.sh --consumer=null --duration=60 --cores=0,6,1,7 --num-raster-threads=3`  
**Артефакты:** `engine/research/results/p18/p01-*`

Продакшн DeckLink на `:3002` / device 1–3 не трогались.

---

## 1. Frame-log по прогонам

| Label | Template | fps | paintLat p50/p95 (µs) | pump_active p50 (µs) | timedOutTicks / rows | delivered |
|---|---|---:|---:|---:|---:|---:|
| p01-test1-r1 | test1 | 28.26 | 26 / 63 | 822 | 1308 / 2998 | 1689 |
| p01-test1-r2 | test1 | 24.78 | 29 / 148 | 734 | 1514 / 2997 | 1482 |
| p01-test1-r3 | test1 | 28.32 | 24 / 50 | 894 | 1303 / 2998 | 1694 |
| p01-test-r1 | test | 28.63 | 24 / 45 | 877 | 1285 / 2999 | 1713 |
| p01-test-r2 | test | 28.79 | 24 / 48 | 879 | 1276 / 2999 | 1722 |

`paint_latency_us` в headless/`null` — микросекунды (pump не ждёт OnPaint до дедлайна поля, в отличие от DeckLink). Дискриминатор бюджета — **effective fps** + Chrome Trace raster, не paintLat.

### Средние

| Template | avg fps | avg paintLat p50/p95 (µs) | avg pump_active p50 (µs) | avg timedOutTicks |
|---|---:|---:|---:|---:|
| **test1** (n=3) | **27.12** | **26.3 / 87.0** | **816.7** | **1375** |
| **test** (n=2) | **28.71** | **24.0 / 46.5** | **878.0** | **1280.5** |

test1 r2 — выброс (24.78 fps, paintLat p95=148); без него avg test1 ≈ 28.29 fps.

---

## 2. Per-thread CPU (renderer, ThreadPoolForeg = raster workers)

`BG_NUM_RASTER_THREADS=3` → теоретический потолок 300% CPU.

| Label | ThreadPoolForeg mean/max % | bg_engine mean % | Compositor mean % |
|---|---:|---:|---:|
| p01-test1-r1 | 113.4 / 114 | 12.8 | 4.0 |
| p01-test1-r2 | 91.9 / 98 | 9.6 | 3.0 |
| p01-test1-r3 | 95.5 / 96 | 11.5 | 4.0 |
| p01-test-r1 | 101.1 / 102 | 10.4 | 3.0 |
| p01-test-r2 | 97.6 / 99 | 10.2 | 3.0 |

Raster-пул занят ~30–38% от 3 потоков — **не насыщен**. test и test1 почти одинаковы по CPU и fps → в headless узкое место не «сложность шаблона vs простой», а общий pump/CEF pacing.

---

## 3. Chrome Trace (test1, 15s)

Команда:

```bash
BG_NUM_RASTER_THREADS=3 BG_TRACE_SECONDS=15 BG_TRACE_CATEGORIES=blink,cc,benchmark \
  taskset -c 0,6,1,7 engine/build-p18/Release/bg_engine \
  --blink-research=1 --consumer=null --duration=30 ...
```

Файлы: `p01-test1-trace.json` (60 MB), `p01-test1-trace-report.json`, parse log `p01-test1-trace-parse.txt`.  
Engine SUMMARY на trace-прогоне: **27.30 fps**.

### Per-frame averages (events / frame)

| Stage | events/frame |
|---|---:|
| Layout | 8.7 |
| Paint | 4.33 |
| Raster | 68.59 |
| Style | 3.31 |
| JS | 0 |

### Per-frame distribution (parse-chrome-trace.mjs)

| Metric | p50 | p95 | max |
|---|---:|---:|---:|
| Layout events | 0 | 26 | 33 |
| Paint events | 0 | 13 | 14 |
| Raster events | 0 | 206 | 274 |
| **Raster ms (sum of event durs)** | **0** | **190.645** | **299.462** |

> **Методология:** `rasterMs` в парсере — **сумма** `dur` всех raster-bucket событий в slice кадра (включая параллельные `RasterTask`). Это **не wall-clock** одного кадра. Та же метрика использовалась в Phase 15 (там p95 ≈ 189.9 мс).

### Уточнённые оценки стоимости raster

| Оценка | Значение | Смысл |
|---|---:|---|
| Raster ms p95 (parser, все кадры) | **190.6 мс** | Phase-15-совместимая метрика |
| Raster ms p50/p95 (только кадры с rasterMs>0, n=412/1224) | 180.3 / **207.8 мс** | те же суммы на «тяжёлых» кадрах |
| `raster.task` CPU-sum / frame | **13.5 мс** | 16494 мс / 1224 BeginMainFrame |
| `raster.task` mean / task | 0.99 мс | 16705 tasks |
| Wall-clock lower bound @ 3 threads | **≈4.5 мс/frame** | (CPU-sum)/3 — оптимистичный пол |
| `raster.drawFrame` mean | 22.4 мс | 408 events / 9145 мс |

Sub-category (top): `raster.task` 16495 мс, `raster.drawFrame` 9145 мс, `layout.updateLayout` 670 мс, `style.recalc` 629 мс.

---

## 4. Decision Gate

**Вопрос:** raster ms p95 на кадр test1 — **≤10 мс** (подход B возможен) или **~20 мс** (нужен подход A)?

| Критерий | Результат |
|---|---|
| Phase-15-совместимый rasterMs p95 | **~191 мс** ≫ 20 мс |
| CPU-sum `RasterTask` / frame (mean) | **~13.5 мс** — выше порога ≤10 мс |
| Оптимистичный wall-clock @ 3 threads | ~4.5 мс mean — **не** p95; не доказывает ≤10 мс p95 |
| Effective headless fps test1 | **~27** (бюджет 50 fps = 20 мс/кадр не выдерживается end-to-end) |

### Вердикт: **~20 мс / нужен подход A** (не ≤10 мс для подхода B)

Обоснование:

1. По метрике, которой пользовались в Phase 15–16 для headroom, p95 raster ≈ **190 мс** — далеко от бюджета 20 мс и тем более от ≤10 мс.
2. Даже «честный» CPU-sum `RasterTask` ≈ **13.5 мс/кадр** уже **>10 мс**; это среднее, не p95 тяжёлых кадров.
3. Headless delivery **~27 fps** на test1 и почти то же на простом `test` — запас до 50 fps отсутствует; одного «дешёвого» raster для подхода B недостаточно.
4. Raster-пул при N=3 не насыщен (~100% из 300%) — узкое место не «мало потоков», а объём/латентность pipeline (согласуется с Phase 17: для true 50p нужна переработка pump, не только CPU).

**Подход B (рассчитывать на ≤10 мс raster и простой 50p path) сейчас не обоснован.** Нужен **подход A** (архитектурная переработка / дальнейшее сокращение raster work + pump), либо повторный замер wall-clock p95 после изоляции от конкуренции и/или на DeckLink-пути.

---

## 5. Канал после прогона

Take возвращён на **test1** (`p15-take.mjs` → templateId `6104dc7e-…`).

## 6. Файлы

```
engine/research/results/p18/
  p01-test1-r{1,2,3}-{frame-log.csv,framelog.json,framelog.txt,log,threads.csv,threads.log}
  p01-test-r{1,2}-…
  p01-test1-trace.json
  p01-test1-trace-report.json / .csv / -parse.txt / -engine.log
  p01-raster-budget.md          ← этот отчёт
```
