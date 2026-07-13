# Titulus — сжатая история диалога с AI-агентом
## Период: 2–5 июля 2026 | Проект: Titulus (broadcast graphics, bg_engine)

> **Назначение файла:** личный архив контекста разговора. Не является частью репозитория Titulus,
> не привязан к фазам разработки продукта.

---

## Оглавление

1. [Контекст проекта на момент старта диалога](#1-контекст-проекта)
2. [Этап A — Запрос исследования CasparCG vs bg_engine](#2-этап-a--исследование-casparcg)
3. [Этап B — План Phase 11 и согласование решений](#3-этап-b--план-phase-11)
4. [Этап C — Реализация Phase 11 (11.1–11.7)](#4-этап-c--реализация-phase-11)
5. [Этап D — Вопросы про live-стенд, коммит, PR, merge](#5-этап-d--live-стенд-коммит-pr)
6. [Этап E — Инструкции для друга (обновление и сборка)](#6-этап-e--инструкции-для-друга)
7. [Этап F — Удаление старых feature-веток](#7-этап-f--ветки-git)
8. [Этап G — Технические Q&A: пайплайн рендера](#8-этап-g--технические-qa-пайплайн)
9. [Этап H — CEF, GPU, perf, DOM writes](#9-этап-h--cef-gpu-perf-dom)
10. [Этап I — Исследование Blink pipeline (Phase 12)](#10-этап-i--blink-research-phase-12)
11. [Этап J — Blink internals: follow-up измерения](#11-этап-j--blink-internals)
12. [Этап K — Phase 12c: анализ docs/rules (рекомендации)](#12-этап-k--phase-12c-анализ)
13. [Этап L — Phase 13: полная переработка документации](#13-этап-l--phase-13)
14. [Этап M — Phase 13b: расширение документации](#14-этап-m--phase-13b)
15. [Этап N — Финальный коммит, PR #57, merge, cleanup](#15-этап-n--pr-57)
16. [Этап O — Этот файл (архив диалога)](#16-этап-o--этот-файл)
17. [Ключевые технические выводы (шпаргалка)](#17-шпаргалка)
18. [Хронология PR и веток в рамках диалога](#18-хронология-pr)

---

## 1. Контекст проекта

**Titulus** — proprietary cloud/on-prem broadcast graphics:
- **Control plane:** React + Express + SQLite (editor, control panel, rundowns)
- **Render plane:** `bg_engine` (C++20 + CEF OSR), 1 процесс = 1 канал
- **Выход:** DeckLink SDI (1080i50), stream, browser/OBS
- **Принципы:** CPU-only render, HTML5/DOM через `@titulus/runtime`, CasparCG-parity по эфиру

**Железо тестового стенда (домашний хост):**
- AMD Ryzen 5 3600 (6C/12T, 2×CCX по 3 ядра)
- DeckLink Quad 2, genlock LES DG-14B
- 3 одновременных SDI-выхода на profile `1dfd`

**Состояние на 2 июля 2026 (начало диалога):**
- Phase 0–10 в `main` (PR #1–#55)
- Phase 10 устранил tearing/judder на SDI (beacon, external BeginFrame, field-pairing)
- **Проблема:** 3 канала 1080i50 — видимые подтормаживания анимаций; 1 канал терпимо, 3 — уже заметно
- CasparCG `server/` лежит в репо как read-only reference (GPL, не линкуем)

---

## 2. Этап A — Исследование CasparCG

### Запрос пользователя (2 июля, ~21:00)

- Режим `/caveman` (лаконичные ответы)
- Создать ветку для новой фазы
- **Масштабное исследование-сравнение** Titulus `bg_engine` vs CasparCG `server/`
- Цель: взять лучшее (архитектура, оптимизации), **не копировать код на 100%** (политика GPL/reimplement by reference)
- Жёсткие правила:
  - только CPU render, без GPU
  - обязательный DeckLink
  - целевой KPI: **3×1080i50 без лагов, дёрганий, фризов, артефактов**
- На выходе: **подробный план улучшений**
- Масштабные архитектурные изменения — только после согласования в формате «сейчас / хочу / зачем / риски»

### Что сделал агент

1. Запустил **3 параллельных explore-агента:**
   - Titulus engine (frame pipeline, decklink, threading, hot path)
   - CasparCG server (channel/mixer/consumer, pools, SIMD, clock)
   - Docs + git history (Phase 10, benchmarks, hardware notes)

2. Пользователь спросил, не зависли ли агенты — агент проверил транскрипты: **все три завершились успешно**, отчёты извлечены.

### Главные находки исследования

**В Titulus (причины рывков):**

| # | Проблема | Суть |
|---|---|---|
| 1 | Три несинхронных clock | `MessagePump` 50 Hz, JS `setInterval(tick)` 50 Hz, DeckLink callback 25 Hz → биения → pairs/singles/starved |
| 2 | ~830 МБ/с memcpy/канал | OnPaint→FrameRing→queue→weave; `resize()` на каждый кадр в queue |
| 3 | Потолок ~47.9 fps | Phase 0 bench; на interlace недобор бьёт нелинейно |
| 4 | 6/6 ядер заняты | 3 ch × 2 phys cores, нет запаса; CCX pinning не учитывал топологию Ryzen |
| 5 | Drop-oldest queue depth 4 | Вместо backpressure как в CasparCG |

**Что взять у CasparCG (идеи, не код):**
- DeckLink = единственные часы (`ScheduledFrameCompleted` будит pump)
- Bounded queue depth 2 + backpressure
- `SCHED_FIFO` prio 2 на channel thread
- 64B aligned buffers + SIMD non-temporal copy (weave)
- Buffer pools — zero alloc в hot path
- `bmdDeckLinkConfigLowLatencyVideoOutput`
- Stage-time telemetry (% бюджета кадра)

### Согласованные решения (AskQuestion)

Пользователь подтвердил:
- **Да** — инверсия clock: DeckLink completion = master clock для decklink-каналов
- **Да** — разрешить `SCHED_FIFO` (только decklink path; browser/null не трогать)

---

## 3. Этап B — План Phase 11

Агент создал план **Phase 11: CasparCG-parity perf pass** с этапами:

| Этап | Содержание |
|---|---|
| 11.1 | Stage telemetry + baseline soak 3ch |
| 11.2 | DeckLink-driven clock, unified rAF tick в channel.html |
| 11.3 | Buffer pooling, 64B align, AVX2 weave |
| 11.4 | SCHED_FIFO + nice backend/frontend, CCX review |
| 11.5 | Low-latency flag + CasparCG preroll formula |
| 11.6 | Chromium background-throttling flags |
| 11.7 | Acceptance soak 30+ min + browser regression |

Ветка: `feature/phase-11-casparcg-parity`

---

## 4. Этап C — Реализация Phase 11

### 11.1 — Telemetry + baseline

**Код:**
- `decklink_consumer.cpp`: `copy_us`, `weave_us`, `schedule_us` — avg/max за 5s окно
- Новая строка лога `stages5s` с % от budget (40 ms @ 25 Hz)

**Baseline (live 3ch, домашний хост):**
- Ch1 ~28 fps — позже диагностирован как **CPU video decode** (content-bound)
- Ch2/3 ~46–48 fps, pairs:singles ~4–7:1
- copy+weave+schedule = 17–22% budget

**Операционная ошибка (задокументирована):**
- Ложная гипотеза «карта держит только 2 SDI» — на самом деле device-index уже занят live-процессами
- **Подтверждено:** 3 SDI одновременно на `1dfd`, 54+ мин uptime

### 11.2 — DeckLink-driven clock

**Код:**
- `Consumer::HasExternalClock()` / `WaitForTick()` в `consumer.h`
- `main.cpp`: отдельная ветка `decklink_driven` pump loop
- `channel.html`: JS timeline с `setInterval` → fixed-step внутри rAF

**Первая попытка провалилась:** 2 BeginFrame подряд за 4–8 ms → cap 25 fps. Исправлено pacing ~20 ms на tick.

**Результат Ch2/3:**
- in_fps ~49–50
- pairs:singles ~4–7:1 → **~8–100:1**
- Ch1 без изменений (content-bound, не clock)

### 11.3 — Memory / SIMD

**Код:**
- `aligned_buffer.h` — 64B pooled buffers
- `simd_copy.h` — AVX2 `StreamCopy`, non-temporal stores
- Убран fresh `aligned_alloc` на каждый `OnFrame()` (доминирующая стоимость)
- `kMaxQueuedFrames` 4→2

**Результат:**
- copy_us ~2700→**~1200 µs**
- weave_us ~2800→**~1500–1900 µs**
- combined stage % budget: 17–22% → **~9–11%**

### 11.4 — OS scheduling

**Код:**
- `MaybeSetRealtimePumpPriority()` — SCHED_FIFO prio 2, gated `decklink_driven`
- `dev-start.sh`: `nice -n 10` для backend/frontend

**Live:** SCHED_FIFO soft-fail (`RLIMIT_RTPRIO=0`) — нужен deployment grant (systemd)

**CCX topology:** исследовано, **не меняли** — Ch2 (straddles CCX) стал лучшим performer

**Ошибка оператора:** `renice` на PID Cursor extension host вместо Titulus backend — требует `sudo renice -n 0`

**Channel 1 root cause уточнён:** CEF CodecWorker/Media threads — CPU video decode, не backend contention

### 11.5 — DeckLink config

- `bmdDeckLinkConfigLowLatencyVideoOutput = true`
- Preroll по формуле CasparCG → `low_latency=yes preroll=3`

### 11.6 — CEF flags

- `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows`, `disable-background-timer-throttling`
- Projected-mask hotspot (`template_test_1`) — **отложено**

### 11.7 — Acceptance soak

**28.6 мин** непрерывно, 3 live decklink channels:
- **0** dropped/flushed/late на всех каналах
- Ch2/3: in_fps ~49, pairs-dominant
- Ch1: ~29 fps (video decode)
- Browser/null: 49.92 avg fps — без регрессии

**Документ:** `docs/phase11-baseline.md` (363 строки, позже перенесён в archive при Phase 13)

### Обновление docs/rules после Phase 11

Пользователь попросил обновить `@rules` и `@docs` — агент синхронизировал:
- `.cursor/rules/10-development-plan.mdc`, `99-session-history.mdc`
- `docs/phase11-baseline.md`, `CASPARRCG_PORTING.md` §3.6–3.7

---

## 5. Этап D — Live-стенд, коммит, PR

### «Уже работает новый движок?»

**Ответ агента:**
- Если `run-engines.sh` supervisor уже крутится — **убить только `bg_engine` PID** → supervisor перезапустит через ~3 с с новым бинарём
- Полный рестарт: `./dev-stop.sh && ./dev-start.sh` после `cmake --build`
- Проверка: `pgrep -af bg_engine`, логи `logs/engines.log`, telemetry `stages5s`

### Коммит всего состояния

- Ветка `feature/phase-11-casparcg-parity`
- Commit + push (Phase 11 engine + docs)
- **`take_tmp.mjs`** — throwaway WS smoke script, **не коммитится** (в `.gitignore` или одноразовый)

### PR #56 в main

- Title: `[Phase 11] CasparCG-parity perf pass — clock, memory, OS`
- Merge commit: `d9272ee`
- Пользователь попросил merge если нет ошибок — выполнено

---

## 6. Этап E — Инструкции для друга

Пользователь хотел дать другу протестировать актуальную версию.

**Агент дал пошагово:**

```bash
cd /path/to/Titulus
git fetch origin
git checkout main
git pull origin main

# Runtime
cd runtime && npm install && npm run build

# Backend + frontend
cd ../backend && npm install
cd ../frontend && npm install

# Engine (нужен CEF + DeckLink SDK на машине друга)
cd ../engine
./third_party/fetch-cef.sh   # если CEF ещё нет
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBG_ENABLE_DECKLINK=ON
cmake --build build -j"$(nproc)"

# Запуск
cd ..
TITULUS_DATA=/tmp/titulus-dev ./dev-start.sh
```

UI: `http://127.0.0.1:3011`, login `admin` / `admin123`

**Важно:** на машине друга должны быть те же prerequisites (Node 20+, DeckLink driver если SDI).

---

## 7. Этап F — Ветки Git

**Вопрос:** feature/phase-* ветки после merge — нужны?

**Ответ:**
- После merge в `main` **локальные и remote feature-ветки можно удалить** — история в merge commits
- Оставляют только если нужен hotfix прямо на старой ветке
- `git branch -d feature/phase-11-...` + `git push origin --delete feature/phase-11-...`
- `git fetch --prune` для очистки remote-tracking

---

## 8. Этап G — Технические Q&A: пайплайн

### Вопрос 1: DeckLink buffer vs свой framebuffer?

**Ответ:**
- CEF `OnPaint` → **свой** FrameRing (SPSC BGRA buffer)
- DeckLink consumer **копирует** из ring в pooled input queue
- Weave в **output buffer** карты → `ScheduleVideoFrame`
- **Не** рендерим напрямую в SDK buffer CEF

### Вопрос 2: Формат пикселей?

**BGRA end-to-end** — native для DeckLink и CEF OSR на Linux
- **Нет** BGRA→ARGB конверсии
- **Нет** YUV в render path (YUV только если ffmpeg stream consumer)

### Вопрос 3: Многопоточность?

| Компонент | Потоки |
|---|---|
| bg_engine main | 1 pump thread (BeginFrame loop) |
| CEF | Browser process + renderer subprocess(es) |
| DeckLink | Callback thread (`ScheduledFrameCompleted`) |
| ffmpeg consumer | Worker thread (stream only) |

Pinning: **2 phys cores + SMT siblings** per channel via `taskset`
Phase 11.4: SCHED_FIFO на pump (decklink-only)

---

## 9. Этап H — CEF, GPU, perf, DOM

### Что внутри CEF?

- **Не React/Vue** в engine — это **channel.html** + `window.BG` (`@titulus/runtime`)
- DOM + CSS (TemplateRenderer), timeline JS
- Skia **software raster** (CPU) в OSR mode
- SVG/CSS animations, clip-path, video через `<video>` tag

### GPU отключён?

Да, unconditionally:
```
--disable-gpu
--disable-gpu-compositing
--disable-gpu-vsync
```

### perf top / record

Пользователь просил perf на 10–20 с под нагрузкой.

**Создан `engine/collect-perf.sh`** — агент запускал на live каналах.

**Типичная картина (Ryzen 3600, 3ch):**
- ~35–40% — Chromium renderer (Skia raster, layout)
- ~15–20% — memcpy/weave в decklink consumer
- ~10–15% — CEF IPC / BeginFrame
- Backend Node ~0% (не bottleneck)

### «JS меняет inline-styles каждый кадр — что именно?»

**Ответ (Phase 9 уже добавил dirty-check):**

| Свойство | Когда пишется |
|---|---|
| `left`, `top` | При изменении x/y (layout!) |
| `transform` | rotation/scale изменились |
| `clip-path` | mask geometry изменилась |
| `opacity`, `width`, `height` | если анимированы |

**Dirty-check (Phase 9.1):** `setStyle()` пишет только если строка изменилась → `RenderStats.skippedWrites`

**Важно:** анимация position через `x/y` → `left/top` = **layout every tick** (~50/s), не compositor-only translate. Это ключевой вывод Phase 12.

---

## 10. Этап I — Blink research (Phase 12)

### Запрос пользователя (5 июля)

Глубокое исследование:
1. Layer promotion vs paint every frame
2. JS flamegraph (`PerformMicrotaskCheckpoint`)
3. Cached DOM / glyph reuse
4. **Chrome tracing** (не perf): Style, Layout, Paint, Raster events

### План и реализация

**Добавлено в engine:**
- CLI flags: `--blink-research=N`, `--remote-debugging-port=N`
- `engine/research/` — parsers и orchestrators:
  - `parse-chrome-trace.mjs`
  - `parse-paint-invalidation.mjs`
  - `parse-trace-internals.mjs`
  - `run-blink-research.sh`, `run-blink-internals-research.sh`

**Bench scenes:**
- `bench-wipe-inset.html`, `bench-wipe-polygon.html`, `bench-wipe-transform-only.html`
- `bench-static-beacon.html` (beacon on/off A/B)
- `bench-image-left.html`, `bench-image-transform.html`

### Ключевые выводы Phase 12

| # | Вывод |
|---|---|
| 1 | Damage beacon → **paint+raster каждый rAF**, даже при `styleWrites=0` |
| 2 | Titulus «transform» через `left/top` = **layout ~50/s**, не GPU-style translate |
| 3 | Wipe в production = **clip-path** (T1 inset или T3 polygon) — дорого на CPU |
| 4 | PNG decode **не каждый кадр** (~6/15s); raster ~35/frame |
| 5 | Нет frozen DisplayItemList reuse при geometry + beacon |
| 6 | Beacon off → ~0 paint после load |

**Отложено:** outer/inner split для translate-only position (архитектурный fix)

---

## 11. Этап J — Blink internals

### Дополнительные вопросы пользователя

1. Layer→Paint→Raster→Bitmap каждый кадр при только transform?
2. Paint invalidation reason — почему Blink перерисовывает?
3. clip-path для wipe — измерить отдельно
4. 24 DOM nodes — сколько `<img>`? PNG decode vs raster reuse?

### Реализация follow-up

- Paint invalidation tracing через Chrome trace categories
- Bench triplet: inset vs polygon vs transform-only
- Image left (layout) vs image-transform (compositor path)
- Live trace 15s на decklink Ch2: Layout 11.4/ev, Paint 7.9, Raster 175.9

**Документ:** `docs/phase12-blink-internals.md` (позже в archive)

---

## 12. Этап K — Phase 12c анализ

### Запрос (5 июля)

«Phase 12c — актуализируем rules и docs. Слишком много устаревшего. phase*-* вынести в отдельную папку. Проанализируй — что удалить, сократить, переписать.»

### Рекомендации агента (анализ, без реализации)

**Удалить / архивировать:**
- `docs/DEVELOPMENT_PROMPT.md` (1642 строки — дубли rules)
- `docs/AGENT_RESUME.md`, `99-session-history.mdc` (snapshot → phase files)
- `docs/RUNDOWN_IMPLEMENTATION_PROMPT.md`, `session-sergey-v1-context.md`
- Дубли phase docs в корне `docs/` если есть `development-phases/`

**Сократить:**
- 10 файлов `.cursor/rules/*.mdc` → 3–4 consolidated
- Package READMEs

**Переписать:**
- `ARCHITECTURE.md` как единый справочник
- Phase reports → `docs/development-phases/phase-NN-*.md`

**Sandbox policy (`broadcast-graphics/`):** убрать из rules — больше не актуально

→ Это привело к **Phase 13** (полная переработка)

---

## 13. Этап L — Phase 13

### Запрос пользователя

**Phase 13 — полная переработка документации:**
- Язык: **русский**
- Phase 6: один файл с секциями 6.1–6.4
- Удалить **все** старые docs (кроме archive)
- **Не трогать:** корневые `README.md`, `LICENSE.md`
- **Не трогать:** `docs archieve/` (резервная копия)

### Что сделано (Phase 13a)

**Новые rules (4 файла):**
- `architecture.mdc` (~100 строк, alwaysApply)
- `development-plan.mdc` (~45 строк)
- `git-workflow.mdc` (~68 строк)
- `skills-map.mdc` (~55 строк, optional)

**Удалены 10 старых `.mdc`** (00, 01, 02, 03, 04, 05, 06, 10, 11, 99)

**Новые docs:**
- `GETTING_STARTED.md`, `ARCHITECTURE.md` (152 строки), `RUNBOOK.md`
- `PRODUCT.md`, `DESIGN.md`
- `docs/development-phases/` — README + phase-00..13 (**короткие**, ~37–72 строк)

**Удалено из docs/ (14 файлов):**
- `DEVELOPMENT_PROMPT.md`, `AGENT_RESUME.md`, `PHASE0_BENCH.md`
- `PHASE_REPORT_*`, все `phase*.md` в корне
- `RUNDOWN_*`, `session-sergey-v1-context.md`

**Сжаты** README в engine/, runtime/, backend/, frontend/, bench/, shared/

**Commit/PR на этом этапе не создавались** (пользователь не просил)

---

## 14. Этап M — Phase 13b

### Запрос (5 июля)

Implement plan Phase 13b — расширение документации (прикреплённый plan file)

### A. Quick fixes rules

- `architecture.mdc`: убрать `broadcast-graphics`, секцию Sandbox; porting → `docs/CASPARRCG_PORTING.md`
- `development-plan.mdc`: «Следующие задачи» → `_(заполняется вручную)_`
- `skills-map.mdc`: убрать «Текущий фокус»

### B. Перенос CASPARRCG

- `engine/CASPARRCG_PORTING.md` → **`docs/CASPARRCG_PORTING.md`** (без stub)
- Обновлены ссылки в engine/README, THIRD_PARTY_NOTICES, GETTING_STARTED, phase files

### C. Расширение phase-файлов (14 шт.)

Единый шаблон: мета, цель, scope, реализация, таблица PR #1–#56, проверка, результаты, артефакты

Приоритет объёма: phase-09, 11, 06, 10, 02, 00 → остальные

**Источники:** `docs archieve/` (phase9, phase11-baseline, PHASE0_BENCH, session history), `gh pr list`

### D. ARCHITECTURE.md

Переписан до **556 строк**: REST/WS/SQLite, runtime, engine, consumers, clock model, NFR, deployment matrix

### E. Verify

- grep: 0 `broadcast-graphics` в active docs/rules
- grep: 0 `engine/CASPARRCG_PORTING` в active repo
- phase-09: 223 строки, phase-11: 201 строка
- phase-13-documentation.md дополнен секцией 13b

---

## 15. Этап N — PR #57

### Запрос пользователя (5 июля, ~19:26)

«Сделай коммит и PR в main, подтверди PR если нет ошибок, после успешного PR удали ветку и переключись на main»

### Выполнено

| Шаг | Результат |
|---|---|
| Branch | `feature/phase-13-documentation-reworking` |
| Commit | `aaa0600` — docs(phase-13): rework + Phase 12 blink research |
| PR | **#57** — `[Phase 13] documentation rework + Phase 12 blink research` |
| CI | No checks configured on repo |
| Merge | `762d703` — merge commit в `main` |
| Cleanup | Remote + local feature branch удалены |
| Current | `main`, clean (кроме untracked `docs archieve/`) |

**Scope PR #57 (83 files):**
- Phase 13/13b documentation (rules, phases, ARCHITECTURE 556 lines)
- Phase 12 blink research (engine flags, bench HTML, research scripts)
- CASPARRCG move to docs/

---

## 16. Этап O — Этот файл

Пользователь запросил **обособленный файл** 500–800 строк с полной историей диалога для переноса на флешку. Файл **не входит в репозиторий Titulus** и нигде в проекте не упоминается.

**Путь:** `/home/requestin/titulus-dialog-summary-2026-07-05.md`

---

## 17. Шпаргалка

### Frame pipeline (упрощённо)

```
WS take/update/clear
 → ChannelClient (bg-runtime.js)
 → TemplateRenderer × N (DOM/CSS, masks, 2.5D)
 → CEF OnPaint(BGRA)
 → FrameRing (SPSC)
 → Consumer: decklink | null | stream | preview
```

### Clock model (после Phase 11)

| Consumer | Master clock |
|---|---|
| decklink | `ScheduledFrameCompleted` → `WaitForTick()` |
| null/stream/browser | Self-timer MessagePump ~50 Hz |

### Ключевые файлы engine (Phase 11)

| Файл | Роль |
|---|---|
| `main.cpp` | decklink_driven loop, SCHED_FIFO |
| `consumers/decklink_consumer.cpp` | weave, telemetry, pool, preroll |
| `aligned_buffer.h`, `simd_copy.h` | pool + AVX2 weave |
| `engine_app.cpp` | CEF flags |
| `backend/public/channel.html` | rAF + unified tick |

### Perf bottlenecks (известные на 5 июля 2026)

1. **Clock desync** — fixed Phase 11.2
2. **Malloc per frame** — fixed Phase 11.3
3. **Layout via left/top** — identified Phase 12, fix отложен (translate-only)
4. **clip-path wipe/mask T3** — content hotspot
5. **CPU video decode** — Ch1 content-bound (~29 fps)
6. **Damage beacon** — необходим для 50 fps OSR, но forces paint every frame

### Операционные команды

```bash
# Dev stack
./dev-start.sh    # :3011 frontend, :3002 backend, engines
./dev-stop.sh

# Перед DeckLink экспериментами
pgrep -af "bg_engine|run-channel|run-engines"

# Bench regression
./bench/run-bench.sh 3 30 5

# Blink research
./engine/run-blink-research.sh
```

### Git workflow (принято в проекте)

- Ветка → commit → PR → **merge commit** (не squash)
- Phase = milestone PR с `[Phase N]` в title
- Не commit: CEF dist, DeckLink SDK, CasparCG, data/, bg-runtime.js (build)

---

## 18. Хронология PR

| PR | Дата (approx) | Содержание |
|---|---|---|
| #49–#55 | Jul 2 | Phase 10 SDI perf fixes (telemetry, weave, beacon, BeginFrame, mask guard) |
| #56 | Jul 2 | **Phase 11** CasparCG-parity (clock, SIMD, SCHED_FIFO, 28.6 min soak) |
| #57 | Jul 5 | **Phase 13** docs rework + Phase 12 blink research |

**Ветки в рамках диалога:**
- `feature/phase-11-casparcg-parity` → merged #56
- `feature/phase-13-documentation-reworking` → merged #57

---

## Приложение A — Ошибки и уроки сессии

| # | Ошибка | Урок |
|---|---|---|
| 1 | «Карта держит 2 SDI» | Проверять `pgrep` — device-index может быть занят live process |
| 2 | renice на Cursor PID | Сверять полный cmdline перед renice/kill |
| 3 | 2 BeginFrame подряд | CEF нужен ~полный field period на composite |
| 4 | Backend CPU contention | Misidentified — был Cursor extension host, не Titulus |
| 5 | Write `.sh` без chmod | После Write — `chmod +x` |

---

## Приложение B — Документы до/после Phase 13

**Удалены (контент перенесён или заменён):**
- `DEVELOPMENT_PROMPT.md`, `AGENT_RESUME.md`, `PHASE0_BENCH.md`
- `phase9-25d-masks.md`, `phase11-baseline.md`, `phase6-decklink-*.md`
- 10 файлов `.cursor/rules/*.mdc`

**Новая структура:**
```
.cursor/rules/          (4 файла)
docs/
  GETTING_STARTED.md
  ARCHITECTURE.md       (556 строк)
  RUNBOOK.md
  CASPARRCG_PORTING.md  (перенесён из engine/)
  development-phases/   (phase-00..13, 80–220 строк каждый)
docs archieve/          (read-only backup, не в git)
```

---

## Приложение C — Вопросы пользователя (полный список тем)

1. CasparCG comparison + Phase 11 plan
2. Subagents stuck? (нет — завершились)
3. Implement Phase 11 plan
4. Live engines already updated?
5. Update rules/docs after Phase 11
6. Commit all + push
7. What is take_tmp.mjs?
8. How friend updates to current version?
9. How to rebuild project?
10. PR phase-11 branch → main
11. Delete old feature/phase-* branches?
12. DeckLink buffer vs framebuffer / pixel format / threading
13. What's inside CEF? GPU disabled? perf results?
14. How to run perf in detail?
15. Run collect-perf.sh
16. What CSS properties change every frame? dirty-check?
17. Layer promotion, JS microtasks, DOM cache, Chrome tracing
18. Implement Blink research plan
19. Paint invalidation, clip-path wipe, image decode
20. Implement Blink internals plan
21. Phase 12c — analyze docs/rules
22. Phase 13 — full documentation rework
23. Phase 13b — expand documentation (plan)
24. Commit + PR #57 + merge + delete branch
25. This summary file for flash drive

---

## Приложение D — Метрики Phase 11 (reference)

### Baseline 11.1 (до фиксов)

| Channel | in_fps | pairs:singles | copy_us | weave_us |
|---|---|---|---|---|
| Ch1 | ~28 | 1:6 | ~2731 | ~2842 |
| Ch2 | ~46–48 | ~7:1 | ~4017 | ~3369 |
| Ch3 | ~45–46 | ~4:1 | ~2695 | ~2851 |

### After 11.2 + 11.3 (Ch2/3)

| Metric | Before | After |
|---|---|---|
| in_fps Ch2/3 | ~46–48 | ~49–50 |
| pairs:singles | ~4–7:1 | ~8–100:1 |
| copy_us | ~2700–4000 | ~1200 |
| weave_us | ~2800–3400 | ~1500–1900 |
| stage % budget | 17–22% | ~9–11% |

### Soak 11.7 (28.6 min)

| Channel | in_fps | dropped | flushed | late |
|---|---|---|---|---|
| Ch1 | 29.3 | 0 | 0 | 0 |
| Ch2 | 49.1 | 0 | 0 | 0 |
| Ch3 | 49.6 | 0 | 0 | 0 |

---

## Приложение E — Развилки spec vs CasparCG (не переоткрывать)

1. Decklink clock через `WaitForTick()` (Phase 11); browser — self-timer
2. Keyer: `IDeckLinkKeyer`, не 2dfd profile API
3. Genlock: `GetReferenceStatus` polling
4. BGRA end-to-end
5. Weave — consumer-side UFF
6. CEF pacing: push BeginFrame vs CasparCG pull — другой механизм, тот же SDI effect

---

*Конец документа. Сгенерировано 5 июля 2026. Источник: agent transcript ca04af50-2787-45c4-ab2b-9bc9bc1d5418 + session memory.*
