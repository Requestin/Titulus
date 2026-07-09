# Phase 18 P0.3 — IPC vs raster в paint latency

**Дата:** 2026-07-09  
**Канал:** `28c4b4f1-1b40-42d7-92bb-3cf15520861a` (test1 on-air, backend `:3003`)  
**Binary:** `engine/build-p18/Release/bg_engine`  
**Cores:** `0,6,1,7` · **duration:** 15s · **consumer:** null  
**Categories:** `cc,ipc,benchmark,toplevel,sequence_manager,blink,disabled-by-default-devtools.timeline`

## Артефакты

| Файл | Назначение |
|---|---|
| `p03-ipc-trace.json` | Chrome Trace (~97 MB, 509 356 events) — копия `blink-trace.json` из cache |
| `p03-ipc-trace-parsed.{json,csv,txt}` | `parse-chrome-trace.mjs` |
| `p03-ipc-analysis-raw.json` | Targeted Mojo/raster/pipeline breakdown |
| `p03-ipc-trace.engine.log` | Engine SUMMARY |

**Замечание по скрипту:** `run-p18-trace.sh` сначала нашёл `extensions_crx_cache/metadata.json` (13 B) вместо trace. Реальный файл — `blink-trace.json` в cache dir. Нужно предпочитать `blink-trace.json` / `trace-startup*.json` по размеру/имени.

## Что удалось измерить

### Наличие IPC / Mojo

| Паттерн | Count | Комментарий |
|---|---:|---|
| name ~ `/Mojo/i` | 12 901 | В основном `Receive mojo message` / `reply` / `Closed mojo endpoint` |
| `ChannelMojo` | 0 | Нет |
| `SyncChannel` | 0 | Нет |
| name ~ `/\bIPC\b/` | 0 | Нет классических IPC slice-имён |
| cat `ipc` | 12 | Только startup (`RenderProcessHostImpl.Channel.*`) |

IPC в этом билде виден как **Mojo** (`toplevel,mojom`), не как legacy `ChannelMojo`/`SyncChannel`.

### Суммарная длительность (поле `dur`, µs→ms)

| Bucket | Events with `dur` | Σ dur |
|---|---:|---:|
| Mojo/IPC по имени | 12 894 | **894 ms** |
| `RasterTask` | 16 045 | **20 127 ms** |
| parse subcat `raster.task` | 16 045 | 20 127 ms |
| parse subcat `raster.drawFrame` | 390 | 10 034 ms |

**Отношение CPU-time `RasterTask` / Mojo ≈ 23×** (20.1 s vs 0.89 s за ~15 s wall).

Per-`Scheduler::BeginImplFrame` interval (сумма `dur` задач, стартовавших в интервале — **CPU-sum**, не wall):

| | p50 | p95 | avg |
|---|---:|---:|---:|
| RasterTask CPU-sum | **49.9 ms** | 74.6 ms | 51.4 ms |
| Receive mojo message CPU-sum | **1.4 ms** | 3.6 ms | 2.0 ms |

Mojo на кадр — единицы миллисекунд; raster (сумма worker-задач) — десятки ms CPU (параллельно на raster threads).

### Main / composite стадии (не IPC)

| Event | n | p50 | p95 |
|---|---:|---:|---:|
| `ProxyMain::BeginMainFrame` | 391 | **2.64 ms** | 6.56 ms |
| `MainFrame.Draw` | 388 | **0.39 ms** | 0.55 ms |
| `RasterTask` (одна задача) | 16 045 | **0.91 ms** | 4.31 ms |
| `Receive mojo message` | 7 142 | **0.01 ms** | 0.85 ms |

`SendBeginMainFrameToCommit` breakdown (n=390, p50):

| Stage | p50 |
|---|---:|
| `style_update_us` | 1.42 ms |
| `animate_us` | 0.44 ms |
| `paint_us` | 0.30 ms |
| `composite_commit_us` | 0.12 ms |
| `layout_update_us` | 0.05 ms |

Main-thread paint/layout сами по себе малы; доминирует **raster worker work** + pipeline до draw (parse: Raster total dur sum ≫ Paint/Layout).

### BeginFrame → Draw

Явных `OnPaint` / CEF host `OnPaint` в trace нет (это browser/renderer Chromium events). Прокси:

- `SendBeginMainFrame` ×1173, `Scheduler::BeginImplFrame` ×397  
- Парные wall-gap `SendBeginMainFrame → MainFrame.Draw` дают p50≈33 ms — **зашумлено** (много Instant/`s`/`f` маркеров, не 1:1 с deadline; maxGap clamp). Не использовать как точный paint latency.  
- Надёжнее: `ProxyMain::BeginMainFrame` p50≈2.6 ms + `RasterTask` нагрузка + `MainFrame.Draw` p50≈0.4 ms.

Engine под trace: SUMMARY **fps≈26.5**, drops≈87 % (null + wide categories + I/O) — абсолютные fps не репрезентативны для decklink; относительные доли IPC/raster — да.

## Оценка: IPC round-trip vs composite+raster

**Качественный вердикт: paint latency не объясняется IPC round-trip.**

1. Классический sync IPC / ChannelMojo в trace отсутствует.  
2. Mojo receive — частый, но дешёвый (p50≈11 µs; per-frame CPU-sum p50≈1.4 ms).  
3. Raster — на порядок больше по CPU-time (≈24×) и по per-frame CPU-sum (≈50 ms суммарно по workers).  
4. Main-frame style/animate/paint — единицы ms; bottleneck ближе к **tile raster + draw/composite path**, не к browser↔renderer Mojo hop.

Доля IPC в атрибутированном CPU paint-path: **≲5 %** (1.4 / (1.4+50) ≈ 3 % на BeginImpl; глобально Mojo 0.9 s vs RasterTask 20 s ≈ **4 %**). Остальное — raster/composite (и прочий cc/blink вне этих двух вёдер).

## Связь с Phase 17 (`paint_latency` ≈ 20 ms на decklink)

Phase 17 (decklink, test1): `paint_latency_us` p50≈**20 089 µs** — почти весь бюджет поля 1080i50; raster threads заняты, но не на 200 % (`SESSION_RESUME_NOTES.md`).

Интерпретация вместе с P0.3:

- 20 ms — **wall-clock** от tick/pump до готового кадра (CEF OSR), не «стоимость одного Mojo RT».  
- Внутри Chromium pipeline основная работа — **raster (+ draw)**, IPC/Mojo — шум.  
- Следовательно P0.3 **не** поддерживает гипотезу «убери IPC → сильно упадёт paint_latency». Имеет смысл дальше смотреть raster threads / tile pressure / damage / layer promotion (Phase 16–17 линия), а не Mojo channel rewrite.

Оговорка: этот прогон — **null consumer + startup trace**, не decklink master clock. Доли IPC vs raster переносятся качественно; абсолютные 20 ms нужно по-прежнему брать из `--frame-log` на decklink.

## Ключевые числа (для статуса)

1. **RasterTask Σ dur ≈ 20 127 ms** vs **Mojo/IPC Σ dur ≈ 894 ms** → **~23×** в пользу raster.  
2. Per BeginImplFrame: raster CPU-sum **p50 ≈ 50 ms**, Mojo **p50 ≈ 1.4 ms**.  
3. `ProxyMain::BeginMainFrame` **p50 ≈ 2.6 ms**; Mojo message **p50 ≈ 11 µs** — IPC не доминирует в latency budget рядом с Phase 17 ~20 ms wall paint_latency.
