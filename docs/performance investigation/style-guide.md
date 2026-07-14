# Style Guide — Titulus broadcast templates (CPU-only OSR)

Authoritative style guide для авторов эфирных шаблонов Titulus. Документ Phase 19,
performance investigation. Цель — чтобы шаблон, красивый в GPU-браузере, оставался
дешёвым в **CPU-only CEF OSR** (`--disable-gpu`) и не убивал unique fps на канале.

## 0. Назначение и контекст

- **Кому:** авторам JSON/CSS-шаблонов, редактору, ревьюерам perf-PR.
- **Что даёт:** список запрещённых / дорогих / предпочтительных паттернов + cost-класс
  свойств + процедуру самопроверки шаблона до эфира.
- **На чём основано:** ablation-атрибуция и trace из doc 01 (см. отчёт
  `reports/p19-01-raster-cost.md`) и cost matrix из doc 00.

**Связанные документы:**

- `01-blink-raster-cost-reduction.md` — doc 01, cost matrix §3, Style Guide §4, mask §9.
- `00-overview-and-cost-model.md` — doc 00, cost model и бюджеты.
- `reports/p19-01-raster-cost.md` — отчёт выполнения doc 01 (измеренные до/после числа).

**Главный вывод, из которого растёт весь guide:** на `test1` узкое место — **растеризация
Skia** (raster.task ≫ style+layout+paint), а не JS-путь runtime. Runtime уже пишет мало DOM
(writes/f≈10, skipped/f≈216, applyMs/f≈0.16). Значит правила ниже целятся в **площадь и
стоимость paint/raster**, а не в число JS-мутаций.

## 1. Constraints проекта (non-negotiable)

Любой шаблон и любая оптимизация обязаны соблюдать:

- **CPU-only render** (`--disable-gpu`) — нет GPU-ускорения фильтров/градиентов/композитинга.
- **HTML5/DOM — единственный runtime** шаблонов (никаких нативных слоёв в обход DOM).
- **DeckLink + genlock** — вывод синхронный к SDI master clock; шаблон не должен ломать pacing.
- **CasparCG только reimplement-by-reference** — идеи можно смотреть, GPL-код копировать нельзя.
- **Масштабирование пропорционально железу** — baseline **AMD Ryzen 5 3600** (6C/12T); стоимость
  на канал линейно бьёт по multi-channel.
- **git merge-commit workflow** — правки шаблонов идут отдельным PR, merge-commit (не squash).

Язык документа: русский текст + английские технические термины (`clip-path`, `translate3d`,
`RasterTask`, `mask-image`, `tabular-nums`) — как в коде и chrome://tracing.

## 2. FORBIDDEN в hot path

Эти паттерны запрещены в анимируемой (покадровой) части шаблона. Разрешены только как
статичный, единожды растеризованный ресурс.

| Паттерн | Почему запрещён | Замена |
| --- | --- | --- |
| Animated gradients (`linear/radial-gradient` со сменой stops/позиции покадрово) | Class C worst: перерисовка всей площади каждый кадр, самый дорогой в cost matrix | Запечь (bake) в bitmap/sprite; solid + статичный overlay |
| `filter: blur()` на большой площади (>~10% кадра) | Пики RasterTask, дорогой paint на CPU | Pre-rendered blur-plate + crossfade opacity |
| `preserve-3d` stacks / 2.5D в эфирном слое | bench-25d ~25 fps — вдвое ниже цели | Плоская композиция; 3D только за отдельным gate |
| Opacity nudge для «awake» (`opacity = 0.999 ± ε`) | Квантуется в тот же 8-bit alpha → compositor не видит damage; конкурирует с системным beacon | Ничего не делать: awake держит системный damage beacon 1×1 |
| `left`/`top` покадрово для x/y анимации | Layout thrashing масштабируется с числом слоёв (Class A regression) | `transform: translate3d(...)` (composited position) |

**Правило:** если эффект меняется каждый кадр и покрывает большую площадь — он в этом списке
либо должен быть запечён.

## 3. EXPENSIVE — с лимитами

Разрешено, но с бюджетом и мемоизацией. Превышение лимита требует явного perf-обоснования в PR.

| Паттерн | Лимит / правило | Обоснование |
| --- | --- | --- |
| Инвертированные / скруглённые маски через SVG `mask-image` | Только когда геометрию нельзя выразить `clip-path`; полноэкранная luminance mask-image — доказанный главный виновник cost на test1 | Ablation: снятие inverted mask давало +8.69 fps |
| `clip-path: polygon()`, пересчитываемый каждый кадр | Только при rotation / non-axis-aligned; memo по geometry key | polygon дороже inset (doc 01 §9) |
| `textContent` churn (частая смена текста / пересборка блока) | Обновлять только изменившиеся text-nodes, не innerHTML всего блока | bench-text-100 заметно дороже baseline (Class D) |
| `drop-shadow` / `text-shadow` на больших слоях | Избегать на fullscreen; на test1 dropShadow=false (выключены намеренно) | Class C, пики raster |
| Несколько одновременных animated masks | Старт-бюджет ≤2–3 тяжёлых masks на канал; калибровать | mask-stack +112% raster vs один wipe |

**Число:** на `test1` — 2 маски (Mask 1 normal rect в группе с картинкой; Mask 2 inverted rect
на всю ширину внизу). Именно Mask 2 (inverted, полноэкранная) была самой дорогой до оптимизации.

## 4. PREFERRED — дешёвые паттерны по умолчанию

| Паттерн | Когда | Заметка |
| --- | --- | --- |
| `transform: translate3d(...)` / composited position | Любая x/y анимация | Runtime Class A path (`compositePosition: true`); `left:0; top:0` |
| `transform: rotate/scale` | Вращение / масштаб | OK в composited схеме, не трогает layout |
| `clip-path: inset(...)` для axis-aligned wipe | Прямоугольные wipes без вращения | Дешевле polygon, мемоизируется |
| Инвертированная rect-маска **без скругления** → `clip-path: polygon(...)` (evenodd) | Прямоугольный вырез, axis-aligned | **Теперь дешёвая:** заменяет полноэкранную SVG mask-image; пиксельно эквивалентно (см. `runtime/src/maskScopes.ts`) |
| Статичный bitmap (PNG/WebP) вместо градиента | Декоративные фоны, плашки | Растеризуется один раз |
| `font-variant-numeric: tabular-nums` для часов/счётчиков | Любые бегущие цифры | Нет прыжка ширины, нет лишнего reflow |

### 4.1 Ключевая оптимизация (уже в runtime)

Инвертированная **axis-aligned rect-маска без скругления** теперь рендерится через
`clip-path: polygon()` с правилом `evenodd`, а **не** через полноэкранную SVG luminance
`mask-image`. Для прямоугольного выреза результат **пиксельно эквивалентен**, но снимает
дорогой mask-image paint с hot path. Файл: `runtime/src/maskScopes.ts`.

### 4.2 Пример BAD vs GOOD

```css
/* BAD — покадровый градиент (Class C worst) */
.lower-third { background: linear-gradient(90deg, #024 var(--g0), #08a var(--g1)); }

/* GOOD — запечённый фон + composited transform */
.lower-third {
  background-image: url(/media/lt-bg.webp);
  transform: translate3d(var(--x), var(--y), 0);
  left: 0; top: 0;
}
```

```css
/* BAD — инвертированная маска через полноэкранную SVG mask-image */
.footer { -webkit-mask-image: url("data:image/svg+xml,..."); mask-mode: luminance; }

/* GOOD — прямоугольный вырез через clip-path polygon evenodd (дёшево) */
.footer { clip-path: polygon(evenodd, /* внешний rect + внутренний вырез */); }
```

## 5. Cost-класс свойств (A/B/C/D)

Обобщение из doc 01 §3 (Phase 15–16 bench + Phase 19 ablation).

| Класс | Что | Примеры | Вердикт |
| --- | --- | --- | --- |
| **A** — позиция/трансформация | translate3d, rotate, scale vs left/top/width | `transform` дёшев; `left/top/width` покадрово → layout thrash | Всегда transform-path on-air |
| **B** — маски / clip | inset, polygon, ellipse, mask-image | inset ≤ polygon ≤ mask-image; inverted mask-image самый дорогой | inset/clip-path polygon по возможности; лимит на masks |
| **C** — фильтры/градиенты/тени | animated gradient, blur, drop-shadow | Пики и worst-case raster | Bake / ban в hot path |
| **D** — текст | textContent churn, text-shaping, text-shadow | Дорого при частой смене строк | min DOM update, tabular-nums |

Приоритет снижения cost: **C (animated gradients) ≫ B (mask stack / inverted) ≫ D (text churn)
≫ C (blur/shadow) ≫ A (leftover layout) ≫ images steady.**

## 6. Как проверить свой шаблон

Перед сдачей шаблона в эфир прогнать его на стенде и глазами в консоли.

### 6.1 Null-прогон (headless)

- Consumer `null`, 1 канал, 60 s, cores как в baseline (`0,6,1,7`), `BG_NUM_RASTER_THREADS=3`.
- Читать `SUMMARY fps` из лога. Ориентир: **≥45 fps** на сложном шаблоне уровня test1
  (baseline сейчас 38–40 fps).
- Контроль: static-beacon в тот же день ≈50 fps (иначе проблема в стенде/CPU, не в шаблоне).

### 6.2 BGSTATS console line (`?stats=1`)

Открыть канал с query `?stats=1` (или `?hud=1`) → в консоли появится строка BGSTATS с
runtime RenderStats. Ожидаемые значения для здорового шаблона уровня test1:

- `writes/f` ≈ **10** (мало реальных DOM-записей на кадр)
- `skipped/f` ≈ **216** (dirty-check отсекает лишнее)
- `mask/f` ≈ **3**
- `text/f` ≈ **0** (текст не churn'ится покадрово)
- `applyMs/f` ≈ **0.16** мс (JS-путь дешёвый)

Если `writes/f` высокий, а `skipped/f` низкий — шаблон делает лишние покадровые записи
(вероятно left/top или textContent churn). Чините по §2–§4, а не «оптимизацией растра».

### 6.3 Что означают числа

Низкий fps при **низком** `writes/f` — это **raster-bound** (Skia), лечится Style Guide
(маски, градиенты, площадь). Низкий fps при **высоком** `writes/f` — JS/DOM-bound, лечится
dirty-check и Class A. На test1 сегодня — первый случай.

## 7. Измеренные до/после (заполняется по мере doc 01)

| Метрика | До | После | Источник |
| --- | --- | --- | --- |
| test1 null fps (median, warm cache) | 40–41 | **50** | reports/p19-01 §4/§7 |
| test1 null gate (median avg, ×3) | ~40 | **49.78** (PASS ≥45) | reports/p19-01 §7 |
| Inverted mask → clip-path выигрыш | — | **+9 fps** (pixel-exact, md5 идентичны) | reports/p19-01 §4 opt1 |
| 1ch DeckLink in_fps | 41.7 | **47.6** | reports/p19-01 §8 |
| 3ch DeckLink in_fps | 25–26 | **29–32** (не true-50p; doc 03/04) | reports/p19-01 §8 |
| writes/f, skipped/f | 10 / 216 | без изменений (fix в rendering-path, не JS) | BGSTATS |

## 8. Чеклист ревью шаблона

- [ ] Нет animated gradient (или запечён в bitmap).
- [ ] Нет blur/drop-shadow на >10% площади в hot path.
- [ ] Нет preserve-3d / 2.5D без отдельного gate.
- [ ] Нет opacity/visibility «awake» хаков (beacon системный).
- [ ] x/y/rotation/scale идут через `transform`, не left/top/width покадрово.
- [ ] Прямоугольные axis-aligned вырезы — через `clip-path`, не SVG mask-image.
- [ ] Число одновременных animated masks ≤ бюджета (старт 2–3).
- [ ] Текст обновляется по изменившимся полям, не innerHTML целиком.
- [ ] Цифры/часы — `tabular-nums`.
- [ ] Null-прогон ≥45 fps; BGSTATS в норме; visual parity подтверждена.

## 9. Rollback / политика

Любая правка шаблона — обратима через `git revert <merge-commit>`. Runtime Class A и
inverted-mask→clip-path уже в main и откатываются только с отдельным gate. Правило: один
PR = одна логическая правка, target `main`, merge-commit.
