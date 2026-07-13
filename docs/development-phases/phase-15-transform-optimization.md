# Phase 15 — Transform Optimization Results

**Дата:** 7 июля 2026. **Цель:** минимизировать стоимость кадра (Layout/
Paint/Raster) на сложном шаблоне `test1`, создав headroom для будущего
Phase 18 (истинный 50p). Полный ход работы — в
[docs archieve/other/PHASE_15_PERFORMANCE_PLAN.md](../../docs archieve/other/PHASE_15_PERFORMANCE_PLAN.md) и
живом логе [engine/research/results/p15/p15-progress.md](../../engine/research/results/p15/p15-progress.md).

## Итоговый результат

**in_fps на `test1`, 3 одновременных канала DeckLink 1080i50, 15-минутный
soak на реальном железе:**

| | Baseline (до Phase 15) | После Phase 15 | Δ |
|---|---|---|---|
| Канал 1 | ~23-24 (пользовательский замер) | **24.87** | +4-8% |
| Канал 2 | ~23-24 | **24.95** | +4-8% |
| Канал 3 | ~23-24 | **25.12** | +5-9% |
| Headless baseline (для сравнения p50/p95) | 22.71 | 23.31 (single-channel) | +2.6% |

**Все 3 канала практически достигли теоретического потолка `out_fps=25.0`**
(текущий режим 1080i50 = 25p-as-50i, см. §1.1.1
[PERFORMANCE_INVESTIGATION_PLAN.md](../../docs archieve/other/PERFORMANCE_INVESTIGATION_PLAN.md)).

**Raster-стоимость (главная метрика для headroom к Phase 18):**

| Метрика | Baseline | После (3-канальный soak, среднее) | Δ |
|---|---|---|---|
| Layout events p50/frame | 53 | 50.3 | −5.1% |
| Raster ms p50/frame | 172.6 | 145.4 | **−15.8%** |
| Raster ms p95/frame | 234.7 | 192.0 | **−18.2%** |

Регрессия на простом шаблоне `test`: **fps=50.01** на всех 3 каналах (без
изменений относительно baseline ~49-50).

## Что было сделано

1. **P0 — Телеметрия.** `BG_TRACE_CATEGORIES`/`BG_TRACE_SECONDS` env-override
   в [engine/src/engine_app.cpp](../../engine/src/engine_app.cpp);
   [engine/research/lib/parse-chrome-trace.mjs](../../engine/research/lib/parse-chrome-trace.mjs)
   расширен до per-frame p50/p95/max distribution + sub-category breakdown.
2. **P1 — Cost matrix.** Полный аудит всех bench-стендов выявил и исправил
   методологический баг (устаревший API `r.play()`, устаревший opacity-nudge
   паттерн) — без этого исправления вся матрица измеряла бы частоту
   200мс paint-watchdog'а, а не реальную стоимость. Вердикт: класс A
   (left/top → translate3d) не даёт измеримого выигрыша для изолированного
   элемента; класс B (маски) — подтверждённый главный источник стоимости.
3. **P2 — Инвентарь.** ~45 сайтов `setStyle` в
   [runtime/src/domRenderer.ts](../../runtime/src/domRenderer.ts)
   классифицированы по классам A (Layout)/B (маски)/C (paint контента)/D
   (текстовые стили). Подтверждено: editor читает `AppliedTransform.left/
   top/width/height` напрямую — контракт нельзя менять, только расширять.
4. **P3-B — Реализовано.** Мемоизация projected-mask геометрии в
   `applyMaskScopes` — `projectMaskOutline`/`projectedMaskClip` пересчитывались
   безусловно каждый кадр даже для статичных масок; добавлена cheap
   input-signature проверка, пропускающая пересчёт при неизменной геометрии.
5. **P3-A — Явно отменено.** Теоретический разбор показал, что CSS
   `transform-origin` оборачивает весь список transform-функций
   (`T(origin)·F1·F2·T(-origin)`), а не каждую отдельно — добавление
   `translate3d` в тот же список, где уже есть `rotate`/`scale` с ненулевым
   origin, задваивает смещение. Корректная реализация требует полной
   декомпозиции пивота вращения — риск визуальной регрессии выше, чем
   ожидаемый выигрыш (P1 показал 0% для изолированного случая). Отложено за
   рамки Phase 15 (см. Phase 16 в [PERFORMANCE_ROADMAP.md](../../docs archieve/other/PERFORMANCE_ROADMAP.md)).
6. **P4 — Editor проверен.** Изолированный frontend dev-инстанс, визуальная
   проверка `test1` (включая degenerate mask case — width→0) — без регрессий.
7. **P5 — Soak на реальном железе.** 3 канала DeckLink (device-index 1/2/3),
   15 минут, `test1` — результаты выше.

## Инцидент во время P5 (важно для будущих soak-тестов)

Первая попытка P5 запустила 6 ДОПОЛНИТЕЛЬНЫХ тестовых Chromium-процессов
одновременно с 3 уже работавшими (на тот момент) процессами — итого 9
деревьев на машине с 15Gi RAM. Это исчерпало свободную память (осталось
217Mi) и вызвало `stack smashing detected` крахи в тестовых процессах;
production-канал кратковременно показал провал fps (25→12.7), самостоятельно
восстановившийся после остановки тестовых процессов. **Урок:** на этой
машине нельзя запускать более ~3-4 полных Chromium-деревьев одновременно.
Финальный успешный прогон P5 использовал ровно 3 дерева (без headless-твинов
для симуляции нагрузки), что и дало чистый результат без ресурсных проблем.

Второстепенно: канал device-index=3 показал ~31 крах GPU-подпроцесса за 15
минут (каналы 1 и 2 — по 1 каждый) при идентичных флагах; движок
самовосстанавливался каждый раз (fps не деградировал). Природа не выяснена
до конца — вероятно, окружение-специфичная нестабильность CEF/GPU-процесса в
headless ozone-platform режиме, не связанная с правками Phase 15 (правки
только в TypeScript runtime, крах — в native GPU-коде). Рекомендуется
отдельное расследование, если повторится в проде.

## Побочная находка (важно для Phase 18)

Регрессия на `test` (простой шаблон) показала `d_pairs=126, d_singles=0` —
то есть при достаточно дешёвом контенте движок УЖЕ производит настоящие
уникальные поля (не дублирует кадр между полями), в отличие от `test1`
(`d_pairs≈0, d_singles≈120` — устойчиво дублирует). Это означает: путь к
Phase 18 (истинный 50p) может быть не столько архитектурным, сколько
продолжением текущей оптимизации стоимости кадра — если раскрыть класс B
(маски) и другие узкие места до уровня `test`, движок может естественно
перейти на true 50p без отдельного架构ного рефакторинга поля-за-полем.
Требует подтверждения в Phase 16/17.

## Что осталось за рамками Phase 15

- Класс A (left/top → translate3d) — отменён, см. выше. Возможный кандидат
  для Phase 16 при полной декомпозиции пивота вращения.
- Классы C/D — не требовались (P0 показал <4% вклада paint.paint в
  raster.task).
- Причина единичных GPU-подпроцесс крахов на device-index=3 — не расследована.
- 30-минутный+ soak (для проверки долгосрочного дрейфа/памяти) — вне
  бюджета 15 минут, согласованного с пользователем; актуально для Phase 14
  (микрофризы, пропущена намеренно).

## Файлы изменены

- [engine/src/engine_app.cpp](../../engine/src/engine_app.cpp) — trace env-overrides.
- [engine/research/lib/parse-chrome-trace.mjs](../../engine/research/lib/parse-chrome-trace.mjs) — per-frame distribution.
- [runtime/src/domRenderer.ts](../../runtime/src/domRenderer.ts) — P3-B mask memoization.
- [bench/bench-image-left.html](../../bench/bench-image-left.html),
  [bench/bench-wipe-inset.html](../../bench/bench-wipe-inset.html),
  [bench/bench-wipe-polygon.html](../../bench/bench-wipe-polygon.html),
  [bench/bench-mask-stack.html](../../bench/bench-mask-stack.html),
  [bench/bench-alpha.html](../../bench/bench-alpha.html),
  [bench/bench-25d.html](../../bench/bench-25d.html) — исправление
  устаревшего API/opacity-nudge (методологический баг, не связанный с
  оптимизацией напрямую, но необходимый для валидных замеров).
- `engine/research/results/p15/p15-*.{md,json,csv}` — все промежуточные данные.
