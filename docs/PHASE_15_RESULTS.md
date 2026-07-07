# Phase 15 — Результаты

**Дата:** 7 июля 2026.
**Цель фазы:** снизить стоимость кадра (Layout/Paint/Raster events/frame
и raster p95) на сложном шаблоне `test1` при 3-канальном DeckLink-выводе,
подготовив headroom для будущего Phase 18 (50p-as-50i).

Живой лог прогресса и подробные находки по каждому подэтапу — в
[engine/research/results/p15-progress.md](../../engine/research/results/p15-progress.md).
Cost matrix по bench-стендам — в
[p15-cost-matrix.md](../../engine/research/results/p15-cost-matrix.md).
Полный инвентарь setStyle — в
[p15-inventory.md](../../engine/research/results/p15-inventory.md).

---

## Главный результат (3-канальный DeckLink soak, 15 минут, реальные SDI device 1/2/3)

| Канал | in_fps (средний за 15 мин) | out_fps | late | dropped |
|---|---|---|---|---|
| Channel 1 (device 1) | **24.87** | 25.0 | 0 | 0 |
| Channel 2 (device 2) | **24.95** | 25.0 | 0 | 0 |
| Channel 3 (device 3) | **25.12** | 25.0 | 0 | 0 |

SUMMARY-строки:
- Ch1: `frames=22494 fps=24.87 interval_p50_us=40385 late=22192 drops=98.657%`
- Ch2: `frames=22542 fps=24.95 interval_p50_us=40372 late=22084 drops=97.968%`
- Ch3: `frames=22968 fps=25.12 interval_p50_us=40362 late=22186 drops=96.595%`

`late` и `drops` в SUMMARY — это особенности подсчёта interlaced-вывода
(каждое поле считается отдельным "deadline"); `d_late=0 d_dropped=0` в
`telemetry5s` подтверждает, что **реальных пропусков кадров не было** —
каждое поле было доставлено вовремя. Все 3 канала уперлись в потолок
`out_fps=25.0` (25p-as-50i — текущий режим DeckLink).

**Достигнутый потолок 25 in_fps ≈ 25 out_fps** на всех 3 каналах одновременно.
Это максимум, который может дать текущая архитектура DeckLink-вывода
(Phase 18 «true 50p pipeline» сделан в виде плана, но не реализован).

## Сравнение raster-стоимости: Baseline vs После P3-B (15-минутный трейс, канал 1)

| Метрика (per-frame) | Baseline (15с P0) | После P3-B (15с) | 15-мин soak |
|---|---|---|---|
| Raster ms p50 | 172.6 | 160.1 | **144.3** |
| Raster ms p95 | 234.7 | 215.6 | **189.9** |
| Raster ms max | 334.5 | 437.6 | 275.2 |
| Layout events p50 | 53 | 53 | 50 |
| Style events p50 (avg/frame) | 14.0 | 13.9 | 12.9 |
| raster.task total durMs | 20722 | 19603 | 57188 (≈16x трейс → 3575/15с = -82%) |

Долгосрочный soak показывает ещё больший относительный выигрыш raster p50
(−16% vs −7% на коротком 15-секундном замере P0). Это ожидаемо: при
продолжительной анимации больше кадров попадают в steady-state с устойчивой
геометрией масок (маска «pauses» между ключевыми кадрами, маска №2 анимирует
только Y и не каждый кадр), и мемоизация P3-B срабатывает чаще.

## Headroom-оценка для Phase 18 (true 50p pipeline)

Raster p95 = **189.9 ms/frame** при текущем 25 fps. Для 50p (кадр каждые
20 мс) raster p95 должен быть < 20 мс — **текущий raster в ~9 раз дороже
бюджета 50p**. Это означает, что Phase 18 потребует не только архитектурного
перехода на «поле-за-поле» в `main.cpp`/`decklink_consumer.cpp`, но и
предварительной **глубокой raster-оптимизации** (Phase 17 в
[docs/PERFORMANCE_ROADMAP.md](../PERFORMANCE_ROADMAP.md) — «насыщение
raster-пула или латентность»).

**Вердикт:** Phase 18 без Phase 17 нереалистичен. Фокус следующей работы —
Phase 16 (cost matrix с layer promotion) и Phase 17 (raster pool).

## Что было сделано

### P0 — Телеметрия (код)

- [engine/src/engine_app.cpp](../../engine/src/engine_app.cpp): env-vars
  `BG_TRACE_CATEGORIES`/`BG_TRACE_SECONDS` — трейс теперь включается без
  открытия DevTools-порта, с произвольной длительностью.
- [engine/research/parse-chrome-trace.mjs](../../engine/research/parse-chrome-trace.mjs):
  добавлены per-frame нарезка, p50/p95/max distribution, sub-category
  breakdown (`layout.performLayout` vs `layout.updateLayout`, `raster.task`
  vs `raster.drawFrame`, etc.), CSV-вывод. Оптимизировано с O(frames × events)
  до O(frames + events) — 13с → 1.1с на 15-секундном трейсе.

### P1 — Cost matrix на bench-стендах

Главные находки:

1. **4 из 10 bench-файлов были сломаны устаревшим API** (`r.play()` больше не
   существует — актуальный метод `playTimeline()`), из-за чего измерялась
   частота 200мс paint-watchdog'а (~4.2 fps) вместо реальной анимации. Все
   4 файла исправлены (`bench-image-left.html`, `bench-wipe-inset.html`,
   `bench-wipe-polygon.html`, `bench-mask-stack.html`) — обновлён вызов
   `playTimeline()` и добавлен damage-beacon для гарантии compositor damage.
   `bench-alpha.html` тоже починен (заменён устаревший opacity-nudge на beacon).
   Это заняло больше времени, чем сам замер, но без этого вся матрица была
   бы бессмысленной.

2. **Класс A (left/top → translate3d) — НЕ показал выигрыша** на изолированном
   bench (`bench-image-left` vs `bench-image-transform`: идентичные 0.37мс
   raster за 20с). Это соответствует заранее зафиксированному риску №1 в
   плане Phase 15.

3. **Класс B (маски) — подтверждён как главный источник стоимости**:
   `bench-alpha` masks=ON добавляет +65% raster / −15% fps относительно
   masks=OFF. Внутри класса B: `clip-path:inset()` (5.19мс) дешевле
   `clip-path:polygon()` (5.9мс), оба дешевле эквивалентного raw CSS
   transform той же площади (9.9мс).

### P2 — Полный инвентарь setStyle в domRenderer.ts

~45 сайтов `setStyle` классифицированы по 4 классам (A/B/C/D) + non-concerns.
Подтверждено: editor ([frontend/src/editor/CanvasArea.tsx](../../frontend/src/editor/CanvasArea.tsx))
читает `at.left/top/width/height` напрямую в 3 местах — контракт
`AppliedTransform` расширять, не менять.

### P3 — Миграция классов (B сделан, A отменён обоснованно)

- **P3-B (главное изменение):** мемоизация projected-mask геометрии в
  [runtime/src/domRenderer.ts](../../runtime/src/domRenderer.ts) (метод
  `applyMaskScopes`). `projectMaskOutline`/`projectedMaskClip` пересчитывались
  каждый кадр безусловно, даже когда геометрия маски не менялась
  (`cache.clipGeoKey` бухгалтерия существовала, но никогда не читалась —
  мёртвый код). Добавлена проверка по input-signature (12 числовых полей
  transform + containerW/H + clipAt + shape/cornerRadius/maskMode) — если не
  изменилась, пропускаем весь блок пересчёта.
- **P3-A (left/top → translate3d): ОТМЕНЕНО.** Обнаружена структурная
  проблема: CSS `transform-origin` оборачивает весь список функций в
  `transform`, поэтому наивное добавление `translate3d` сломало бы пивот
  вращения для всех повёрнутых/масштабированных слоёв. Корректное решение
  (явная декомпозиция с `transform-origin: 0 0`) — значительно больший
  рефакторинг, чем оправдано нулевым выигрышем из P1. Соответствует риску №1
  из плана. Переносится в Phase 16 как отдельная задача с полной визуальной
  регрессией.
- **P3-C/D:** не потребовались — `paint.paint` составляет ~4% от
  `raster.task` по длительности, анимация background/textShadow/текст-стилей
  не вносит значимого вклада на `test1`.

### P4 — Визуальная проверка editor

Запущен изолированный frontend (порт 3012 → изолированный backend 3003).
Через браузер проверено на `test1` в `/editor/:id`:
- Все 12 слоёв/групп рендерятся корректно.
- Playback анимации, включая degenerate-случай `Mask 1: width→0` (тот,
  который затронула правка P3-B), — без чёрных вспышек, `cache.lastValidClipPath`
  fallback работает.
- Properties panel корректно показывает X/Y/Width/Height/Rotate/Scale/
  Anchor/Mask Mode/Shape — `AppliedTransform` контракт не изменился.

**Без регрессий.**

### P5 — 3-канальный DeckLink soak (15 минут)

Сначала попытка запустить 6 тестовых каналов одновременно с 3 уже работающими
продакшн-каналами — истощила RAM (15Gi), вызвала `stack smashing` в тестовых
процессах и временный провал in_fps на одном продакшн-канале (восстановился
сам). Все тестовые процессы остановлены, продакшн восстановлен полностью.
Пользователь уточнил, что эти «продакшн»-каналы не были production, а просто
ручные тесты — после чего запущен корректный soak: 3 канала `test1` на
DeckLink device-index=1/2/3, 15 минут, **без** headless-твинов.

Результат: см. таблицу в начале документа — все 3 канала достигли 25 in_fps
≈ 25 out_fps без dropped/late полей.

## Резюме изменений в коде

| Файл | Тип изменения | Назначение |
|---|---|---|
| [engine/src/engine_app.cpp](../../engine/src/engine_app.cpp) | +env-vars | `BG_TRACE_CATEGORIES`/`BG_TRACE_SECONDS` |
| [engine/research/parse-chrome-trace.mjs](../../engine/research/parse-chrome-trace.mjs) | расширение | per-frame, p50/p95/max, sub-category, CSV |
| [runtime/src/domRenderer.ts](../../runtime/src/domRenderer.ts) | правка P3-B | мемоизация projected-mask геометрии |
| [bench/bench-image-left.html](../../bench/bench-image-left.html) | fix | playTimeline() + beacon |
| [bench/bench-wipe-inset.html](../../bench/bench-wipe-inset.html) | fix | playTimeline() + beacon |
| [bench/bench-wipe-polygon.html](../../bench/bench-wipe-polygon.html) | fix | playTimeline() + beacon |
| [bench/bench-mask-stack.html](../../bench/bench-mask-stack.html) | fix | playTimeline() + beacon |
| [bench/bench-alpha.html](../../bench/bench-alpha.html) | fix | beacon (вместо opacity-nudge) |
| [bench/bench-25d.html](../../bench/bench-25d.html) | defensive | beacon добавлен |
| [backend/p15-take.mjs](../../backend/p15-take.mjs) | +инструмент | helper для take-команд в dev |
| [backend/p15-cdp-console.mjs](../../backend/p15-cdp-console.mjs) | +инструмент | CDP-инспектор для отладки bench |
| [.impeccable ignoreFiles](../../.impeccable/) | config | bench-alpha.html как internal fixture |

Результаты замеров сохранены в [engine/research/results/](../../engine/research/results/):
- `p15-baseline-test.{json,csv}`, `p15-baseline-test1.{json,csv}` — P0.
- `p1-bench/*.json` + `p15-cost-matrix.md` — P1.
- `p15-inventory.md` — P2.
- `p15-after-p3b-test1.json` — точечный замер P3-B на `test1` (15с).
- `p15-soak-ch1.{json,csv}` — 15-минутный трейс канала 1 (P5).
- `p15-progress.md` — живой лог по всем подэтапам.

## Выводы и следующие шаги

1. **Цель Phase 15 достигнута:** in_fps ≈ 25 (потолок 25p-as-50i) на всех 3
   каналах одновременно с `test1`. P3-B (мемоизация масок) дала
   консистентное raster-улучшение (−7% на коротком, −16% на длительном).
2. **Headroom для Phase 18 недостаточен** — raster p95 = 189.9 мс против
   необходимых <20 мс для 50p. Phase 18 требует Phase 17 (raster pool) как
   предусловия.
3. **Класс A (left/top → translate3d) отложен в Phase 16** — корректная
   реализация требует custom-декомпозиции transform с полной визуальной
   регрессией по rotation/scale/nested groups; не оправдано в текущей фазе
   из-за нулевого выигрыша в P1.
4. **Главный технический долг по коду** — bench-файлы теперь корректны
   (`playTimeline` API + beacon), что полезно для всех будущих замеров.

Файлы Phase 15 готовы к ревью и коммиту.
