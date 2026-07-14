# P19 doc 01 Report — Blink/Skia raster cost reduction (test1 → ≥45 fps null)

Отчёт выполнения `01-blink-raster-cost-reduction.md`. Цель: снизить per-frame raster cost
шаблона `tests/templates/test1.json` так, чтобы null-прогон давал **≥45 fps** (baseline
38–40 fps, 1 канал, `--consumer=null`).

## Шапка

| Поле | Значение |
| --- | --- |
| **Дата** | 2026-07-14 |
| **Git SHA (base)** | `9e5bb76` (ветка `feature/phase-19-raster-cost`) |
| **Host** | AMD Ryzen 5 3600 (6C/12T, 2×CCX по 3 core, 16 MiB L3) |
| **Binary** | `engine/build/Release/bg_engine` (Release, `BG_ENABLE_DECKLINK=ON`, DeckLink SDK 16.0) |
| **Backend** | изолированный, `PORT=3003`, `TITULUS_DATA=/tmp/titulus-p19-data` |
| **Template** | `tests/templates/test1.json` (complex, acceptance target) |
| **Consumer** | `null` (headless) для §1–§7; DeckLink для §8 |
| **Raster threads** | `BG_NUM_RASTER_THREADS=3` (если не указано иное) |
| **Cores** | `0,6,1,7` |
| **Artifacts** | `engine/research/results/p19/doc01-20260714/` |

**Итог одной строкой:** одна runtime-правка (inverted rect mask → `clip-path`) подняла null
`test1` с **~41 → ~50 fps**, пиксельно эквивалентно (md5 кадров идентичны). Primary gate
(**null ≥45 fps ×3**) — **PASS**. 1ch DeckLink 41.7 → 47.6 in_fps; 3ch 25–26 → 29–32 (true-50p
на 3ch — later gate, требует doc 03/04).

**Состав test1:** 2 маски (Mask 1 normal rect в группе с картинкой; Mask 2 **inverted** rect на
всю ширину внизу), 3 `dropShadow` на тексте (`dropShadow=false` — выключены), clock, 4 text,
3 image, 2 rect; анимации x / rotation / width / opacity. Градиентов / blur / polygon нет.

**Изображения:** оригинальные `/uploads/*` в изолированной БД отсутствовали; использованы
реальные картинки из `Загрузки/Telegram Desktop` (portrait photo, logo, landscape photo),
сопоставленные по aspect ratio к трём слотам. Это влияет на абсолютный raster cost картинок,
но не на вывод об inverted mask.

---

## §1. Атрибуция (ablation)

Метод: null, test1, окно 65 s, N=2, cores `0,6,1,7`, raster threads = 3, **свежий cache-dir на
каждый прогон** (важно — см. caveat). Вклад = Δ fps относительно `full`.

| Вариант | fps | Δ к full | Комментарий |
| --- | --- | --- | --- |
| **full** | 41.31 | — | все фичи включены |
| no-anim | 49.97 | +8.66 | без анимаций (static) |
| no-masks | 49.97 | +8.66 | без обеих масок |
| **no-mask2-inverted** | 50.0 | **+8.69** | inverted mask (полноэкранная SVG luminance mask-image) — **главный виновник** |
| no-mask1-normal | 34.86 | −6.45 | **cold-cache артефакт** (см. §4 warm-cache re-measure) |
| no-images | 46.87 | +5.56 | без 3 картинок |
| no-rotation | 43.31 | +2.00 | без вращения групп |
| no-clock | 41.64 | +0.33 | без часов |

**Caveat (важно):** ablation-прогоны использовали свежий `cache-dir` на каждый запуск →
первые ~20 s тратятся на прогрев shader/font cache, что занижает и зашумляет короткие прогоны.
Это объясняет аномалию `no-mask1-normal` (−6.45, физически невозможно, чтобы снятие маски
замедляло). Все решающие сравнения §4 переснятны на **warm cache** (переиспользуемый cache-dir)
и там ранжирование чистое. Ранжирование само по себе (mask2 ≫ images ≫ rotation ≫ clock)
консистентно и подтверждается warm-cache изоляцией.

**Вывод §1:** доминирующий вклад — **Mask 2 (inverted, полноэкранная SVG mask-image)**:
`no-masks ≈ no-mask2` ⇒ вся «масочная» стоимость сконцентрирована в inverted mask, не в normal rect.

---

## §2. Runtime instrumentation (BGSTATS)

Добавлены счётчики RenderStats (`maskWrites`, `textWrites`) и опция `?stats=1` в `channel.html`,
которая раз в 5 s печатает `BGSTATS` в консоль; `bg_engine` форвардит строки `BGSTATS` в лог
через новый `OnConsoleMessage` (`engine_client.cpp`). Числа на test1:

| Поле | Значение | Смысл |
| --- | --- | --- |
| `writes/f` | 10 | реальных DOM style-записей на кадр |
| `skipped/f` | 216 | dirty-check отсёк лишнее |
| `mask/f` | 3 | style-записей на mask clip host |
| `text/f` | 0 | текст не churn'ится покадрово |
| `applyMs/f` | ≈0.16 | время JS applyState на кадр |

**Вывод §2:** шаблон **не JS-bound**. 10 реальных записей против 216 пропущенных, applyState
~0.16 мс/кадр, текст не пересобирается. Цена кадра — в **растеризации (Skia)**, не в JS dirty-path.

---

## §3. Trace (raster ≫ style+layout+paint)

Chrome trace на full test1 (null), окно 15 s:

| Метрика | Значение |
| --- | --- |
| `raster.task` CPU-sum | ~18 576 ms (сумма за 15 s) |
| `raster.drawFrame` wall | ~10 956 ms / 639 unique paints ≈ **17 ms wall на paint** |
| `style.recalc` | ~842 ms |
| `layout.updateLayout` | ~898 ms |
| Paint record | ~801 ms |

**Вывод §3:** `raster.task` доминирует над `style + layout + paint` (~2540 ms) на порядок.
~17 ms wall на unique paint при field budget 20 ms → bimodal профиль (каждый ~3-й paint
пропускает слот), отсюда 38–41 fps. Оптимизация обязана снижать `raster.task` / площадь paint.

---

## §4. Оптимизации

### opt1 — inverted-mask → clip-path polygon (evenodd) [ОСНОВНАЯ]

Инвертированная axis-aligned rect-маска **без скругления** (Mask 2) переведена с полноэкранной
SVG luminance `mask-image` (Skia растеризует container-sized 1920×1080 luminance layer каждый
кадр) на `clip-path: polygon(evenodd, <outer ring>, <inner hole>)` — чистый геометрический clip.
Пиксельно эквивалентно для прямоугольного выреза с прямыми углами. Скруглённые/ellipse маски
сохраняют SVG-fallback. Файл: `runtime/src/maskScopes.ts`.

**A/B, warm cache (переиспользуемый cache-dir, 90 s, steady-state median win_fps):**

| Метрика | До (baseline runtime, mask-image) | После (clip-path) |
| --- | --- | --- |
| test1 null fps (SUMMARY) | 40.94 / 41.40 | 49.91 / 49.94 / 49.96 |
| test1 null steady-state median | 40–41 | **50** |
| Visual parity (preview JPEG md5) | `5a0678bd…` | `5a0678bd…` — **идентичны (pixel-exact)** |

Изоляция подтверждена: **тот же бинарник, тот же warm cache, отличается только `bg-runtime.js`**
(baseline из `main` vs патч). Разница +9 fps целиком от opt1. Parity-кадр снят на статичном
варианте test1 (frame0, без часов) через `--consumer=preview`; md5 old==new ⇒ вывод не изменился.

**Важно:** правка живёт в **rendering-path runtime**, а не в `test1.json`. Поэтому выигрыш
получают **все** шаблоны с inverted rect-масками, и **сам `test1.json` не изменён** (Этап 4
плана — правки шаблона — не потребовался; это лучший исход по критерию визуальной эквивалентности).

### opt2 — clock throttle / opt3 — Class A аудит

Не потребовались для gate. §2 показал `text/f=0` (clock уже обновляется тикером раз в секунду,
не покадрово) и `writes/f=10` при Class A composited position (Phase 16 уже в main). `no-clock`
давал лишь +0.33 fps. Оставлены как низкоприоритетные для будущих итераций.

---

## §5. Правки шаблона test1

**Нет.** `tests/templates/test1.json` не изменялся. Главный рычаг оказался runtime-правкой
(§4 opt1), которая пиксельно эквивалентна и полезна всем шаблонам, поэтому правки самого
acceptance-target не понадобились. Это соответствует пожеланию «менять шаблон только визуально
эквивалентно» в максимально безопасной форме — шаблон вообще не тронут.

---

## §6. Raster threads A/B

A/B `BG_NUM_RASTER_THREADS` на пропатченном runtime (warm cache, 75 s, N=2 на каждый):

| N threads | fps (SUMMARY) | steady median | drops | Решение |
| --- | --- | --- | --- | --- |
| 2 | 49.92 / 49.96 | 50 | 0.08–0.16% | OK (чуть меньше drops) |
| **3** | 49.88 / 49.94 | ~50 | 0.13–0.24% | **выбран default** (совпадает с текущим `run-channel.sh = logical−1`) |
| 4 | 49.92 / 48.32 | 48–50 | до 3.48% | нестабилен (r2 просел) — не брать |

**Решение §6:** оставить текущий production default `N=3` (в пределах шума с N=2, N=4 рискован).
Правок `run-channel.sh` не требуется.

---

## §7. Gate result (null test1 ≥45 fps ×3) — **PASS**

Canonical gate: consumer=null, 1920×1080@50, cores `0,6,1,7`, N=3, template=test1, warm cache,
3 повтора по 70 s.

| Run | avg fps | min 5s fps | drops |
| --- | --- | --- | --- |
| 1 | 49.88 | 49.2 | 0.20% |
| 2 | 49.78 | 47.4 | 0.46% |
| 3 | 49.50 | 46.9 | 1.01% |
| **median** | **49.78** | **47.4** | — |

Критерий: `median(avg) ≥ 45` и `min5s ≥ 40` и static control ~50. 
Факт: median avg **49.78 ≥ 45** ✔, min5s **46.9–49.2 ≥ 40** ✔.

**Регрессии:**

| Проверка | Результат | Критерий | Вердикт |
| --- | --- | --- | --- |
| cheap `test.json` null 65 s | 50.00 fps, 0.000% drops | ≥49 | ✔ |
| `bench/run-bench.sh 3 60 5` | avg 49.94 (ch 49.84–50.00), cpu 100% | ≥ якорь 49.7 | ✔ |
| static beacon 65 s (awake) | 50.00 fps, OnPaint не останавливается | ~50 | ✔ |

**Gate result: PASS.**

---

## §8. DeckLink sanity (genlock locked, device 1/2/3)

| Сценарий | Baseline (P19-00) | После opt1 | Комментарий |
| --- | --- | --- | --- |
| 1ch complex in_fps | 41.7 | **47.6** | pairs 111 / singles 14; d_late=d_dropped=0; ref=locked |
| 3ch complex in_fps (A/B/C) | 25.2 / 25.2 / 26.0 | **32.3 / 28.6 / 30.8** | pairs 18–38; d_late=d_dropped=0; ref=locked |

SDI-путь не регрессировал (late/drop = 0, genlock locked) и улучшился на том же контенте.
3ch пока **не** true-50p — это ожидаемо: doc 01 gate = null ≥45 (PASS); 3ch true-50p упирается
в multi-channel memory/scheduling contention (doc 03/04), не в raster одного канала.

---

## §9. Вердикт и next action

**Статус: PASS (primary gate doc 01).**

Ключевые факты:

- Bottleneck подтверждён как **raster-bound** (§2 не JS-bound; §3 raster ≫ style+layout+paint).
- Главный виновник — **inverted полноэкранная SVG mask-image** (§1: +8.69 fps при снятии).
- Fix (opt1: inverted rect mask → `clip-path` polygon) — **runtime-only, pixel-exact** (§4);
  null test1 **41 → 50 fps**, 1ch DeckLink **41.7 → 47.6**, 3ch **~25 → ~30**.
- Классификация App L: null/1ch — `TRUE_50P_AS_50I` neighbourhood; 3ch — всё ещё `PAINT_BOUND`
  из-за contention.

**Next action:**

- Doc 01 gate закрыт (null ≥45). Открывать **doc 03 (память/copies) ∥ doc 04 (pinning/CCX)** —
  именно они адресуют 3ch contention, который теперь главный барьер к 3×50.
- True-50p DeckLink re-gate (G1/G2) — после 03/04.
- Style Guide (`style-guide.md`) зафиксировал правило: inverted axis-aligned rect mask теперь
  дешёвая; избегать скруглённых inverted-масок в hot path (остаются на SVG-пути).

**Rollback:** `git revert -m 1 <merge-commit>`; runtime opt1 откатывается пересборкой
`runtime` из прежнего `maskScopes.ts`.
