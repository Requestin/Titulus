# 01 — Blink/Skia: снижение per-frame raster cost (test1 → ≥45–50 unique fps)

Документ Phase 19 / performance investigation №01. Цель: снизить стоимость кадра Blink/Skia в CPU-only CEF OSR так, чтобы сложный шаблон `tests/templates/test1.json` стабильно давал **≥45–50 unique fps** на `--consumer=null` (headless) за окно 60 с — **до** повторного true-50p DeckLink gate и **до** полноценного layered compositor (док 02).

Контекст: Phase 18 (PR #61) доказала, что на `test1` потолок ~25 unique fps — **content/raster-bound**, а не pump-pacing. Approach A (dual BeginFrame) опровергнут; Approach B (2 raster в 20 мс поле) не обоснован, пока RasterTask CPU-sum ~13.5 мс/frame. Empty/cheap контент уже даёт true 50p. Значит рычаг — **cost model шаблона + runtime dirty-path**, не ещё один pump-трюк.

**Constraints (non-negotiable):** CPU-only (`--disable-gpu`); HTML5/DOM как единственный template runtime; DeckLink — later gate; clean-room (не копировать код CasparCG); масштабирование нагрузкой по CPU (taskset / raster threads), не GPU compositor.

**Связанные артефакты:** `docs/development-phases/phase-12-blink-pipeline.md`, `phase-15-transform-optimization.md`, `phase-16-performance-matrix.md`, `phase-17-raster-latency.md`, `phase-18-true-50p-pipeline.md`; `engine/research/results/p15|p16|p17|p18/`; `bench/*.html`; `runtime/src/{domRenderer,transform,maskGeometry,maskScopes}.ts`; `backend/public/channel.html`.

---

## 0. Как читать этот документ

Каждая крупная секция (§1–§14) построена по единому каркасу:

- **Problem** — что ломает бюджет кадра / уникальный fps;
- **Analysis** — факты из Phase 15–18, формулы, cost matrix;
- **Implementation** — пошаговые действия в runtime / engine / template / ops;
- **Measurement** — bench, trace, frame-log, SUMMARY;
- **Gate** — числовой критерий go/no-go;
- **Rollback** — как откатить без регрессии эфира.

Английские термины (`RasterTask`, `BeginFrame`, `OnPaint`, `clip-path`, `translate3d`, `SUMMARY`) сохраняются как в коде и chrome://tracing. Русский текст — связка смысла и решений.

Gate документа 01: **headless/null `test1` ≥45 fps average over 60s** (unique frames / wall). Только после этого имеет смысл тратить календарь на layered compositor (02) или true-50p soak.

## 0.1 Глоссарий

| Термин | Смысл в Titulus |
| --- | --- |
| unique fps / in_fps | Число различных OnPaint bitmap за секунду (не wall rAF) |
| field budget | 20 мс на одно поле 1080i50; output frame ~40 мс (пара полей) |
| RasterTask | Chromium cc/Skia задача растеризации тайла |
| damage beacon | 1×1px alpha toggle в channel.html — держит OSR awake |
| Class A | Позиция через transform (translate3d) вместо left/top layout |
| Class B | Маски: clip-path inset/polygon, mask-image |
| Class C | Filters / gradients / shadows — тяжёлый paint+raster |
| Class D | Text shaping / font / textContent churn |
| SUMMARY | Строка статистики bg_engine: frames, fps, drops… |
| BG_TRACE_* | Env: категории и длительность chrome trace |
| BG_NUM_RASTER_THREADS | Env → --num-raster-threads renderer |
| composited position | Phase 16: x/y в CSS transform, left/top=0 |
| projected mask | maskGeometry.projectMaskOutline при rotation |
| bake mask | Запечь маску в статичный bitmap/asset вместо live clip |
| OSR | Off-Screen Rendering CEF, CPU path |

## 0.2 Бюджет кадра — формулы

Для progressive 50 Hz self-timer / null consumer целевой период кадра:

```text
T_frame = 1000 / 50 = 20 ms
```

Для 1080i50 DeckLink field:

```text
T_field = 1000 / 50 = 20 ms   # одно поле
T_output_frame ≈ 40 ms     # пара полей (weave)
```

Условие true-50p на сложном контенте (упрощённо):

```text
T_paint_unique + T_ipc + T_queue ≲ T_field   # желательно ≤10 ms wall для 2 unique/40ms
# Phase 18 P0.1: RasterTask CPU-sum ≈ 13.5 ms/frame на test1 → условие НЕ выполнено
```

Связь unique fps и стоимости (грубая модель при sequential paint):

```text
unique_fps ≈ 1000 / max(T_frame_target, T_raster_wall + T_overhead)
# при T_raster_wall ≈ 20–37 ms → unique_fps ≈ 25–45
# цель doc 01: T_effective ≤ 22 ms ⇒ unique_fps ≥ 45 на null
```

Важно: метрика `rasterMs` в `parse-chrome-trace.mjs` — **сумма** `dur` параллельных `RasterTask` в slice кадра, не wall-clock одного кадра. CPU-sum ~13.5 мс/frame уже говорит, что даже «честный» атрибутированный raster >10 мс порога Approach B.

---

## 1. Почему raster cost — первичный bottleneck

### 1.1 Problem

На `test1` headless/`null` Phase 18 зафиксировала ~27 fps при RasterTask CPU-sum ~13.5 мс/frame и Phase-15 rasterMs p95 ~191 мс (sum). Field budget 20 мс. Mojo/IPC Σ dur ≪ RasterTask (~23×). Значит узкое место — **Blink layout/paint + cc/Skia raster/composite**, не DeckLink, не AMCP, не WebSocket control plane.

Empty/cheap шаблон уже даёт `in_fps≈50` и `d_pairs≈125`/5с на DeckLink. Тот же pump, тот же CEF — другой content cost. Это дискриминирует гипотезу «pump сломан» в пользу «шаблон слишком дорог».

### 1.2 Analysis

Цепочка кадра Titulus:

```text
take/update/clear
  → OnAirManager → ChannelClient → TemplateRenderer (runtime)
  → DOM style writes + timeline tick
  → CEF BeginFrame (external)
  → Blink style/layout/paint
  → cc RasterTask (Skia tiles)
  → composite → OnPaint(BGRA)
  → FrameRing → Consumer (null|decklink|…)
```

Phase 18 P0.3 (`engine/research/results/p18/p03-ipc-breakdown.md`):

| Bucket | Σ dur (пример ~15s wall) | Вывод |
| --- | --- | --- |
| RasterTask | ~20 127 ms | Доминирует |
| Mojo/IPC | ~894 ms | ~23× меньше raster |
| ProxyMain::BeginMainFrame p50 | ~2.6 ms | Не главный |
| MainFrame.Draw p50 | ~0.4 ms | Не главный |

Phase 15 baseline: `test1` (с масками) raster p50≈172.6 мс/кадр (sum) vs `test` (без масок) ≈1.85 мс — разница порядка **93×**. Маски и площадь инвалидации, не «магия SDI».

Phase 17: на DeckLink `paint_latency_us` p50 ≈20 мс (весь field). Добавление `BG_NUM_RASTER_THREADS=3` поднимает headless fps на ~5–6%, но не превращает 25p-as-50i в true 50p на `test1`. Throughput-тюнинг — вторичен относительно content cost.

### 1.3 Implementation (диагностика bottleneck)

1. Зафиксировать baseline: один канал, `--consumer=null`, cores как в p18 (`0,6,1,7`), `BG_NUM_RASTER_THREADS=3`, duration 60s, шаблон `test1`.
2. Снять chrome trace: `BG_TRACE_SECONDS=15` `BG_TRACE_CATEGORIES=blink,cc,benchmark`.
3. Разобрать через `engine/research/lib/parse-chrome-trace.mjs` — CPU-sum RasterTask / frame, layout/paint event counts.
4. Параллельно `--frame-log=/tmp/fl.csv` → `analyze-frame-log.mjs` — paint_latency, pump_active_us.
5. Сравнить с cheap template (`test` или static beacon): если cheap ≈50 и test1 ≈25–40 — bottleneck content.
6. Проверить IPC долю: если Mojo ≪ RasterTask — не лечить IPC.

```bash
# Пример baseline null/test1 (адаптировать путь бинарника)
cd /home/requestin/Titulus
export BG_NUM_RASTER_THREADS=3
export BG_TRACE_SECONDS=15
export BG_TRACE_CATEGORIES=blink,cc,benchmark
# оркестраторы: engine/research/p18/run-p18-trace.sh или ручной bg_engine
# Смотреть SUMMARY fps и trace JSON в engine/research/results/
```

### 1.4 Measurement

| Метрика | Источник | Ожидание на test1 (до cost cut) | Цель после doc 01 |
| --- | --- | --- | --- |
| SUMMARY fps | лог bg_engine | ~27–45 (зависит от Class A) | ≥45 avg / 60s |
| RasterTask CPU-sum/frame | parse-chrome-trace | ~13.5 ms | ↓ тренд, ideally ≪10 ms wall |
| Mojo Σ / RasterTask Σ | p03-style breakdown | ~1/23 | остаётся ≪1 |
| paint_latency p50 (null) | frame-log | десятки µs–мс | не расти vs baseline |
| d_late/d_dropped (DeckLink later) | telemetry5s | 0/0 | 0/0 |

### 1.5 Gate

**Gate §1:** подтверждено, что RasterTask/content доминирует над Mojo и над pump idle. Если после свежего CEF upgrade Mojo ≥ RasterTask — остановиться и пересмотреть doc 01 (редко).

### 1.6 Rollback

Диагностика только читает метрики — rollback не требуется. Не оставлять `BG_P18_PIPELINE_PROBE=1` в прод-каналах.

---

## 2. Damage beacon: почему каждый кадр «живой» и полный composite

### 2.1 Problem

CEF OSR с external BeginFrame рисует **только при compositor damage**. Статический take без damage → OnPaint замирает → SDI/null голодает. Исторический anti-pattern `opacity = 0.999 + ε` квантуется в тот же 8-bit alpha → compositor считает, что damage нет.

Решение Phase 10.5: **damage beacon** — fixed 1×1px, alpha 1/255 ↔ 2/255 каждый rAF. Невидимо в key (alpha <3/255 не несёт смысла), но это **реальный** damage.

**Цена:** каждый BeginFrame получает damage → полный (или почти полный) composite path даже при `styleWrites=0` в runtime. Beacon держит канал awake, но **запрещает** «спать» на статике и усложняет классический dirty-rect «рисуй только изменившееся» на уровне всего viewport.

### 2.2 Analysis

Код (`backend/public/channel.html`):

```javascript
var beacon = document.createElement('div');
beacon.style.cssText =
  'position:fixed;left:0;top:0;width:1px;height:1px;' +
  'pointer-events:none;z-index:2147483647;';
document.body.appendChild(beacon);
// в heartbeat(rAF):
beacon.style.background =
  (frameCount & 1) ? 'rgba(0,0,0,0.004)' : 'rgba(0,0,0,0.008)';
```

Запрещено заменять beacon на host-side `Invalidate()` flood — CEF capturer отдаёт blank buffers (чёрный flicker на SDI). См. комментарии §10 в channel.html и Phase 10.

`bench-static-beacon.html` — шумовой floor ~50 fps при почти нулевом content raster. Beacon сам по себе дешёвый; дорог **полный pass** вместе с тяжёлым DOM.

Phase 12: CPU OSR + beacon → compositor pass каждый rAF даже при нулевых style writes шаблона.

### 2.3 Implementation

1. **Не удалять beacon** в engine mode — это correctness для static take.
2. Держать beacon строго 1×1, fixed corner, z-index max, pointer-events none.
3. В bench всегда использовать тот же паттерн (не opacity nudge) — иначе fps = watchdog ~4–25.
4. Исследовать **локализацию** damage: beacon в отдельном layer/promote? Phase 16 will-change/contain на micro-bench ≈0 выигрыша — не рассчитывать на free lunch.
5. Для экспериментов dirty-rect (§6): beacon остаётся; partial invalidation должна **сосуществовать** с 1×1 damage, а не отключать его.
6. Документировать в Style Guide: авторы шаблонов не должны добавлять свои «nudge» opacity/visibility toggles.

### 2.4 Measurement

```bash
# Сравнить beacon on/off на static bench (?beacon=0|1)
# bench/bench-static-beacon.html
# Ожидание: beacon=1 → ~50 fps OnPaint; beacon=0 → затухание / watchdog
```

| Сценарий | Ожидаемый fps | Комментарий |
| --- | --- | --- |
| static + beacon | ~50 | floor |
| static без beacon | ↓ / watchdog | невалидный прод-путь |
| test1 + beacon | content-bound | цель ≥45 после cost cut |
| opacity nudge | ~25–28 или хуже | анти-паттерн |

### 2.5 Gate

Любой patch, который «оптимизирует» awake-path, обязан: static take 60s → OnPaint не останавливается; SDI без black flicker; SUMMARY fps на static ≥49.

### 2.6 Rollback

Вернуть channel.html beacon из git; не оставлять Invalidate flood. `git checkout -- backend/public/channel.html` или revert PR.

## 3. Cost matrix CSS/features (Phase 15–16)

### 3.1 Problem

Без ранжирования свойств команда оптимизирует «наугад». Нужна воспроизводимая матрица: что жжёт RasterTask на CPU-only OSR.

### 3.2 Analysis

**Phase 15 P1** (20s headless, после фикса playTimeline/beacon):

| Bench | fps | Raster totalMs (20s) | Класс | Вердикт |
| --- | --- | --- | --- | --- |
| bench-static-beacon | 49.90 | 17.7 | floor | шум |
| bench-image-left | 49.92 | 0.37 | A | isol. = transform |
| bench-image-transform | 50.01 | 0.37 | A | isol. = left |
| bench-wipe-transform-only | 50.01 | 9.9 | B ctrl | площадь дороже clip |
| bench-wipe-inset | 49.92 | 5.19 | B | дешевле polygon |
| bench-wipe-polygon | 49.84 | 5.9 | B | JS project + clip |
| bench-mask-stack | 49.64 | 20.93 | B | +112% vs один wipe |
| bench-alpha masks OFF | 48.61 | 161.5 | B | контроль |
| bench-alpha masks ON | 41.14 | 267.1 | B | +65% raster, −15% fps |
| bench-25d | 25.16 | 371.6 | — | нет 3D в test1 |

**Phase 16 P0** (расширение):

| Bench | rasterMsTot | rasterP95 | rasterMax | Комментарий |
| --- | --- | --- | --- | --- |
| bench-static-beacon | 3133 | 0.0 | 16.1 | floor |
| bench-clip-circle | 3013 | 0.0 | 3.2 | ellipse дешёвый steady |
| bench-css-blur | 3184 | 0.0 | 16.8 | пики |
| bench-drop-shadow | 3100 | 0.0 | 19.4 | как blur |
| bench-image-stack | 3094 | 0.0 | 21.4 | несколько bitmap |
| bench-text-100 | 19760 | 2.7 | 77.6 | text churn |
| bench-gradients | 194589 | 41.6 | 52.6 | **worst** |

**Class A нюанс:** micro-bench одного 640×360 image — left/top ≡ translate3d. На `test1` (много слоёв) Class A дал **~22.7 → ~44.9** SUMMARY fps (Phase 16 P3). Layout thrashing масштабируется с числом одновременных left/top writes.

**Layer promotion** (`will-change` / `contain`): Δ rasterMsTot ≈ −0.08% — **не применять** в runtime по умолчанию.

Сводная property matrix (Phase 16):

| Свойство/паттерн | Категория | Вердикт |
| --- | --- | --- |
| left / top (массовая анимация) | A | дорого |
| width / height | A | Layout-триггер |
| transform: translate3d | A | дешёвый путь позиции |
| transform: rotate / scale | A | OK в composited схеме |
| clip-path: inset() | B | умеренно |
| clip-path: polygon() | B | дороже inset |
| clip-path: circle/ellipse | B | дёшево steady-state |
| mask-image / mask-size / mask-position | B | зависит от площади |
| filter: blur() / drop-shadow() | C | пики raster |
| background: linear/radial-gradient (animated) | C | очень дорого |
| textContent churn | D | заметно |
| text-shadow | C/D | удорожает текст |
| font-variant-numeric | D | нейтрально/полезно |

### 3.3 Implementation

1. Поддерживать bench/*.html в синхроне с TemplateRenderer API (`playTimeline`, не `.play()`).
2. Любой новый CSS feature → новый bench + строка в матрицу до merge в Style Guide.
3. Приоритет снижения cost: C gradients (animated) ≫ B mask stack ≫ D text churn ≫ C blur/shadow ≫ A leftover layout ≫ images steady.
4. Запретить в Style Guide покадровую анимацию gradient stops / background-position на больших областях.
5. Предпочитать inset() polygon() для axis-aligned wipes; ellipse/circle OK в steady-state.

### 3.4 Measurement

```bash
engine/research/p16/run-p16-bench.sh bench-gradients 20
engine/research/p16/run-p16-bench.sh bench-text-100 20
node engine/research/lib/parse-chrome-trace.mjs <trace.json>
```

### 3.5 Gate

Матрица считается актуальной, если: все bench используют beacon; playTimeline; consumer=null; duration≥20s; результаты записаны в `engine/research/results/`.

### 3.6 Rollback

Удалить новый bench; не менять прод Style Guide на основании сломанного bench (watchdog fps).

## 4. Style Guide для broadcast templates

### 4.1 Problem

Авторы шаблонов оптимизируют «красоту в браузере» (GPU Chrome), а эфир — CPU OSR. Нужен явный Style Guide: forbidden / expensive / preferred, с примерами JSON/CSS bad vs good.

### 4.2 Analysis — категории

| Категория | Паттерны | Действие |
| --- | --- | --- |
| FORBIDDEN в hot path | animated linear/radial-gradient; filter:blur на fullscreen; preserve-3d stacks; opacity nudge awake | Ban / bake |
| EXPENSIVE | clip-path polygon каждый кадр; mask-image анимация; textContent churn 100+; drop-shadow на больших слоях | Лимит + memo |
| PREFERRED | translate3d/composited position; clip-path inset; статичные PNG/WebP ключи; tabular nums; predecoded images | Default |
| NEUTRAL | font-variant-numeric; overflow:hidden на clip-host | OK |

### 4.3 Implementation — правила

#### 4.3.1 Forbidden / заменить

- Не анимировать `background: linear-gradient(...)` / `radial-gradient(...)` покадрово — запечь кадры в sprite/video или сменить на solid + overlay image.
- Не использовать `filter: blur()` на >10% площади кадра в timeline hot path.
- Не использовать `preserve-3d` / 2.5D stacks в эфирных шаблонах уровня test1 без отдельного gate (bench-25d ~25 fps).
- Не будить compositor через opacity jitter.
- Не писать `left`/`top` каждый кадр для x/y анимации — runtime должен идти Class A path.

#### 4.3.2 Expensive — лимиты

- Максимум N одновременных animated masks на канал (калибровать; старт: ≤2–3 тяжёлых polygon).
- Polygon mask только при rotation/non-axis; иначе inset.
- Text updates: diff по полям, не пересоздавать весь textContent блока.
- Images: фиксированный decode size; избегать смены `src` mid-animation.

#### 4.3.3 Preferred

- Позиция/rotation/scale → CSS `transform` (runtime `compositePosition: true`).
- Wipes → `clip-path: inset(...)` с мемоизацией ключа.
- Статичные декоративные градиенты → bitmap asset.
- Шрифты: один family на шаблон, preload, `font-display: optional` где уместно.

#### 4.3.4 Пример BAD vs GOOD (CSS)

```css
/* BAD — покадрово меняющиеся stops (Class C worst) */
.lower-third {
  background: linear-gradient(90deg,
    rgba(0,40,80,0.9) var(--g0),
    rgba(0,80,160,0.6) var(--g1));
}

/* GOOD — статичный фон + дешёвый transform плашки */
.lower-third {
  background-image: url(/media/lt-bg.webp); /* baked */
  background-size: cover;
  transform: translate3d(var(--x), var(--y), 0);
}
```

```css
/* BAD — layout thrash */
.bug {
  position: absolute;
  left: var(--x); /* animated every frame */
  top: var(--y);
}

/* GOOD — Class A */
.bug {
  position: absolute;
  left: 0; top: 0;
  transform: translate3d(var(--x), var(--y), 0) rotate(var(--r));
  transform-origin: 0 0;
}
```

```css
/* BAD — polygon wipe при axis-aligned */
.wipe { clip-path: polygon(0 0, var(--w) 0, var(--w) 100%, 0 100%); }

/* GOOD */
.wipe { clip-path: inset(0 calc(100% - var(--w)) 0 0); }
```

#### 4.3.5 Пример BAD vs GOOD (JSON template fragment)

```json
{
  "id": "lt-bad",
  "type": "group",
  "comment": "BAD: animated gradient fill + left/top tracks + polygon mask without rotation",
  "tracks": {
    "x": [{"t": 0, "v": 0}, {"t": 1, "v": 100}],
    "gradientStop": [{"t": 0, "v": 0}, {"t": 1, "v": 1}],
    "maskPoly": [{"t": 0, "v": 0}, {"t": 1, "v": 1}]
  }
}
```

```json
{
  "id": "lt-good",
  "type": "group",
  "comment": "GOOD: baked bg image, composited x/y, inset wipe, static text",
  "asset": "lt-bg.webp",
  "mask": { "shape": "rect", "mode": "inset" },
  "tracks": {
    "x": [{"t": 0, "v": 0}, {"t": 1, "v": 100}],
    "wipeInset": [{"t": 0, "v": 0}, {"t": 1, "v": 1}]
  }
}
```

#### 4.3.6 Расширенные правила authoring

- Один «дорогой» эффект на beat анимации, не три одновременно (blur + gradient + polygon).
- Предпочитать короткие motion windows: 12–25 кадров, затем hold (hold всё ещё платит beacon composite, но не layout thrash).
- Для crawl/ticker: двигать одним transform-контейнером, не per-glyph left.
- Избегать nested overflow+filter combinations.
- Не анимировать box-shadow spread на fullscreen plates.
- Video/HTML overlays: отдельный audit (вне primary matrix, но decode cost реален).

### 4.4 Measurement

Прогнать упрощённый шаблон (good) vs исходный test1 на одном стенде 60s. Цель good: ≥45–50 fps; delta документировать в results.

### 4.5 Gate

Style Guide merge: (1) forbidden list согласован; (2) хотя бы один refactored template slice показывает ≥+15% fps или −20% RasterTask sum на сопоставимом визуале; (3) editor preview не ломает геометрию.

### 4.6 Rollback

Вернуть JSON/CSS шаблона; Style Guide пометить experimental. Runtime Class A не откатывать без отдельного gate (он уже в main).

## 5. Runtime optimizations (`runtime/src`)

### 5.1 Problem

Даже идеальный Style Guide не поможет, если `domRenderer` каждый кадр пишет лишние style, пересчитывает mask polygon, или двигает layout через left/top.

### 5.2 Analysis — текущее состояние

- `transform.ts`: `compositePosition` / `useCompositedPosition` — Phase 16 Class A.
- `domRenderer.ts`: `applyLayerState` / `applyGroupState` → `applyTransform(..., { compositePosition: true })`; left/top=0; transformOrigin 0 0.
- Mask path: `clipGeoKey` / `maskGeometryKey` — memoization; `projectMaskOutline` только при нужде.
- RenderStats: `styleWrites`, `skippedWrites`, `frameTimeMs` — HUD/onFrame.
- Editor path: `compositePosition: false` для overlay + mask geometry consumers.

### 5.3 Implementation — конкретные шаги

#### 5.3.1 Dirty-check style writes

1. Перед `el.style.X =` сравнивать с last-written cache (string/number).
2. Инкрементировать `skippedWrites` при skip; `styleWrites` только при реальной записи.
3. Не читать `getComputedStyle` в hot path кадра.
4. Батчить записи в один frame callback (уже tick-driven).

#### 5.3.2 transform.ts

1. Сохранять composited path как default для on-air.
2. Гарантировать отсутствие NaN в matrix string.
3. Pivot wrap: translate(origin) rotate/scale translate(-origin) согласован с transform-origin 0 0.
4. Не регрессировать editor: флаг compositePosition=false.

#### 5.3.3 Mask memoization

1. Ключ: shape + mode + inset params + geometry key projected points (квантование).
2. Skip `projectMaskOutline` если ключ равен cache.
3. Axis-aligned + no rotation → inset CSS, не polygon points.
4. Inverted masks: проверить, что memo ключ включает maskMode.
5. При collapsed/invalid polygon — не применять clip (maskGeometry guards).

```typescript
// Псевдокод шага memo (логика уже близка к domRenderer/maskGeometry)
const key = maskGeometryKey(quad) + '|' + mask.maskMode + '|' + shape;
if (key === cache.clipGeoKey) {
  stats.skippedWrites++;
  return;
}
el.style.clipPath = buildClipPath(...);
cache.clipGeoKey = key;
stats.styleWrites++;
```

#### 5.3.4 Group / layer traversal

1. Skip inactive layers (после clear / вне timeline window) целиком.
2. Не обновлять DOM для слоёв с opacity 0 и visibility hidden, если политика продукта позволяет (осторожно с take-in).
3. Избегать создания/удаления DOM nodes mid-play — pool elements.

#### 5.3.5 Text path

1. Обновлять text nodes только при изменении variable value.
2. Не трогать fontSize/letterSpacing каждый кадр без track.
3. Для clock: менять только изменившиеся glyph clusters если возможно (или хотя бы весь clock node, не parent).

#### 5.3.6 Конкретный backlog патчей (порядок)

| ID | Patch | Файлы | Ожидаемый эффект |
| --- | --- | --- | --- |
| R1 | Audit clipGeoKey hit-rate на test1 | domRenderer.ts | меньше polygon rebuild |
| R2 | Quantize projected points (0.5px) | maskGeometry.ts | стабильнее memo keys |
| R3 | Skip apply for dormant layers | domRenderer.ts | ↓ styleWrites |
| R4 | Text variable dirty flags | domRenderer / timeline | ↓ shaping |
| R5 | Image element reuse map | domRenderer | ↓ decode spikes |
| R6 | Assert Class A on-air always | transform.ts | нет left/top regress |

### 5.4 Measurement

```bash
# HUD: hud=1 → stats writes/skipped/frameTimeMs
# Сравнить до/после patch на test1 60s null
# Ожидание: skippedWrites ↑, frameTimeMs ↓, SUMMARY fps ↑
```

| Сигнал | Хороший знак | Плохой знак |
| --- | --- | --- |
| skippedWrites / (writes+skipped) | ↑ к 0.7+ | ≈0 (нет dirty-check) |
| frameTimeMs p95 | ↓ | ↑ после «оптимизации» |
| Layout events/frame (trace) | ↓ как после Class A | ↑ |
| SUMMARY fps | ≥45 | <40 |

### 5.5 Gate

Runtime patch merge: test1 null 60s fps не хуже baseline−1%; editor geometry OK; unit/smoke по запросу. Предпочтительно fps ≥ baseline+5% или skippedWrites заметно↑.

### 5.6 Rollback

Revert commit runtime; пересобрать `cd runtime && npm run build` → `backend/public/bg-runtime.js`. Не коммитить случайно build artifact если policy forbid — но локально нужен rebuild для стенда.

## 6. Dirty-rect / partial invalidation при живом OSR

### 6.1 Problem

Классический dirty-rect: перерисовать только изменившиеся регионы. В Titulus beacon портит «чистую статику», а CEF OSR + Skia tile raster всё равно работает тайлами. Нужна стратегия, которая **не отключает awake**, но уменьшает площадь/стоимость RasterTask.

### 6.2 Analysis

- Beacon = 1×1 damage в углу — минимальный dirty от самого beacon, но full document lifecycle + cc всё равно могут composite весь layer tree.
- Уменьшение **content invalidation area** (меньше layout/paint damage от шаблона) важнее попытки «обмануть» beacon.
- Tile size Chromium влияет на granularity raster; слишком мелкие тайлы → overhead scheduling; слишком крупные → over-raster.
- Partial update на уровне runtime: не трогать style вне bbox анимации.
- Host Invalidate flood — запрещён (flicker).

### 6.3 Implementation

1. **L1 Runtime:** dirty flags per layer; applyState только dirty subtree.
2. **L2 CSS containment осторожно:** Phase 16 contain ≈0 — не как серебряная пуля; точечные эксперименты с измерением.
3. **L3 Mask bake:** статичная маска → pre-raster asset, снять clip-path с hot path.
4. **L4 Beacon isolation experiments:** отдельный stacking context только для beacon; A/B fps/rasterMs; rollback если шум.
5. **L5 Не делать:** отключать beacon; подмена opacity; GPU path.
6. **L6 Документ 02:** layered compositor / promote layers — следующий этап, если L1–L4 исчерпаны а fps <45.

Уровни детализации dirty (практика):

| Уровень | Что помечаем dirty | Стоимость реализации | Риск |
| --- | --- | --- | --- |
| L1a | весь активный template | низкая (уже почти так) | baseline |
| L1b | per-layer flag от tracks | средняя | пропуск обновления |
| L1c | per-property (x vs text) | выше | сложность |
| L3 | bake снимает mask dirty | средняя | visual drift |

### 6.4 Measurement

Использовать `parse-paint-invalidation.mjs` / paint invalidation trace categories если включены; сравнить invalidation display item counts до/после. Параллельно SUMMARY fps.

```bash
export BG_TRACE_CATEGORIES=blink,cc,disabled-by-default-blink.invalidation,benchmark
# затем parse-paint-invalidation.mjs при наличии данных
```

### 6.5 Gate

Стратегия accepted, если: static take alive; test1 fps↑ или RasterTask sum↓ ≥10%; нет visual holes; нет SDI flicker.

### 6.6 Rollback

Выключить feature flag partial path; вернуть полный applyState. Beacon не трогать при rollback.

## 7. Tile size / `--num-raster-threads` / `BG_NUM_RASTER_THREADS`

### 7.1 Problem

Даже при высоком content cost пул raster threads может быть неоптимален. Phase 17: default≈2 vs N=3 vs N=4 на mask 2 phys cores (+SMT).

### 7.2 Analysis

| Вариант (headless, Phase 17) | avg fps | paintLat p95 | ThreadPoolForeg %CPU |
| --- | --- | --- | --- |
| default (2) | 37.30 | 53.3 µs | 134.9 |
| N=3 | 39.40 (+5.6%) | 30.0 µs | 141.5 |
| N=4 | 39.04 | 31.0 µs | 142.3 |

`run-channel.sh` выставляет `BG_NUM_RASTER_THREADS=$((n_cores - 1))` для pinned cores. N=3 — sweet spot на текущем стенде; N=4 без выигрыша (SMT contention).

**Это не заменяет Style Guide:** +5% не превращает 25 → 50 на DeckLink test1.

Tile size: Chromium выбирает tile grid для raster. Явный тюнинг tile size в Titulus сейчас не primary lever (нет стабильного public knob в нашем engine_app); если появится CEF flag — A/B только после threads. Пересекать tile experiments с content cut нельзя в одном PR.

### 7.3 Implementation — A/B протокол

1. Фиксировать: бинарь, шаблон, consumer, duration=60s, cores list, CPU governor, отсутствие лишних bg_engine.
2. Варианты N ∈ {2,3,4} (и default unset).
3. По 3 прогона на вариант; медиана fps + p95 paint_latency.
4. Сэмпл threads: `engine/research/lib/sample-threads.sh`.
5. Оркестратор: `engine/research/p17/run-p17-probe.sh`.
6. Выбрать N с max median fps при отсутствии регрессии latency tail.
7. Записать результат в results/; обновить default в run-channel.sh только после gate.

```bash
export BG_NUM_RASTER_THREADS=3
# taskset пример (2 phys + SMT siblings) — как в p18
# taskset -c 0,6,1,7 ./engine/build/bg_engine ... --consumer=null
```

### 7.4 Measurement

```bash
node engine/research/lib/analyze-frame-log.mjs /tmp/frame-log.csv
# Смотреть pumpActiveRatio, paint_latency percentiles
```

### 7.5 Gate

Принять новый default N только если median fps ≥ baseline+3% на null **и** DeckLink single не хуже baseline−1% по in_fps при d_late=0.

### 7.6 Rollback

Unset `BG_NUM_RASTER_THREADS` или вернуть формулу n_cores-1; revert run-channel.sh.

## 8. Fonts, text shaping, image decode caching

### 8.1 Problem

`bench-text-100` заметно дороже baseline. Image decode mid-play создаёт spike RasterTask/paint. Нужен контроль шрифтов и decode cache.

### 8.2 Analysis

- Text shaping (HarfBuzz в Blink) дорог при частой смене строк/стилей.
- `font-variant-numeric: tabular-nums` — нейтрально/полезно для clock (нет прыжка ширины).
- `text-shadow` увеличивает paint/raster текста.
- Смена `src` у `<img>` / background-image → decode; лучше preload.
- Большие PNG без resize в DOM → лишний raster bandwidth.

### 8.3 Implementation

1. Preload `@font-face` в channel bootstrap или template head.
2. Ограничить число family/weight на эфирный пакет.
3. Clock/scoreboard: обновлять минимальный DOM text node.
4. Image pipeline backend: decode once, отдавать уже нужный размер (если есть media service).
5. Runtime: кэш ImageBitmap / HTMLImageElement по URL; не recreate element.
6. Избегать анимации font-size; scale через transform.

```css
@font-face {
  font-family: "TitulusOnAir";
  src: url("/fonts/TitulusOnAir.woff2") format("woff2");
  font-display: optional; /* или swap — измерить FOIT vs cost */
}
.clock {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
```

Чеклист шрифтового пакета:

- [ ] ≤2 family на канал-пакет
- [ ] woff2 only
- [ ] weights реально используемые
- [ ] preload до take
- [ ] нет web font flash mid-animation
- [ ] tabular nums на цифрах

### 8.4 Measurement

```bash
engine/research/p16/run-p16-bench.sh bench-text-100 20
engine/research/p16/run-p16-bench.sh bench-image-stack 20
# A/B: с preload vs cold start (отдельный cold run)
```

### 8.5 Gate

Text/image patch: bench-text-100 rasterMsTot не хуже; cold-take spike p95 paint↓; test1 без glyph flicker.

### 8.6 Rollback

Убрать preload/cache layer; вернуть прямые src. Шрифты оставить если нет регрессии — откат только проблемного diff.

## 9. Mask strategies: inset vs polygon vs projected; bake

### 9.1 Problem

Маски — главный Class B драйвер на test1-подобных шоу. Неверный выбор алгоритма (polygon всегда) жжёт JS + Skia каждый кадр.

### 9.2 Analysis

| Стратегия | Когда | Стоимость | Заметки |
| --- | --- | --- | --- |
| inset() | axis-aligned wipe/rect | ниже | предпочтительно |
| circle/ellipse | круглые маски steady | низкая steady | P16 clip-circle |
| polygon() projected | rotation / 2.5D | выше | maskGeometry.ts |
| mask-image | сложные alpha matte | зависит от площади | анимация дорогая |
| bake to bitmap | маска статична ≥N кадров | 0 live clip | лучший endgame |
| scaleX fake wipe | эксперимент | не гарантирован | P15: raw transform area может быть дороже clip |

P15: wipe-transform-only (800×650) **дороже** inset/polygon wipe — площадь invalidation важнее алгоритма. Приоритет: memo + inset + bake, не слепой scaleX.

### 9.3 Implementation

1. В maskScopes / domRenderer: if !maskNeedsProjection(t) → inset path.
2. Else projectMaskOutline + polygon CSS; memo by maskGeometryKey.
3. Инструмент редактора: warning «rotated mask = expensive».
4. Bake pipeline (offline или take-time): для static mask layers экспортировать premasked PNG.
5. Лимит одновременных animated projected masks.
6. Не менять visual без screenshot diff / editor check.

```typescript
// Decision tree (runtime)
if (maskNeedsProjection(transform)) {
  const quad = projectMaskOutline(mask, transform, applied);
  if (isCollapsedOrInvalid(quad)) return; // guard
  const key = maskGeometryKey(quad) + mode;
  if (key !== cache.key) applyPolygonClip(el, quad, mode);
} else {
  applyInsetClip(el, mask); // or ellipse
}
```

Когда bake окупается:

- Маска не анимируется ≥1–2 с подряд.
- Геометрия сложнее ellipse/inset (soft alpha matte).
- Один bake переиспользуется на нескольких takes.

### 9.4 Measurement

```bash
engine/research/p16/run-p16-bench.sh bench-wipe-inset 20
engine/research/p16/run-p16-bench.sh bench-wipe-polygon 20
engine/research/p16/run-p16-bench.sh bench-mask-stack 20
engine/research/p16/run-p16-bench.sh bench-alpha 20
# test1 A/B: masks simplified vs full
```

### 9.5 Gate

Mask change: visual parity (operator sign-off); fps↑ or RasterTask↓; alpha key correct (no hole / no opaque trash).

### 9.6 Rollback

Revert mask path to previous clip algorithm; clear bake assets if broken. Keep memoization if independently good.

## 10. Animation / timeline cost: fixed-step ↔ BeginFrame

### 10.1 Problem

Два независимых часов (setInterval timeline vs rAF paint) → judder даже при «правильном» fps. Phase 11.2: fixed-step accumulator на том же rAF timestamp, что и paint/BeginFrame.

### 10.2 Analysis

В engine mode host шлёт external BeginFrame → rAF heartbeat → tickAccum → `client.tick()` → TemplateRenderer applyState → DOM damage (+beacon) → следующий paint видит новое состояние.

Over-ticking (долг > maxTickDebt) ограничен `tickStepMs * 4`.

Sub-frame / fractional seek для true-50p отвергнут в Phase 18 fallback scope — не открывать без нового gate.

Стоимость timeline на кадр:

| Компонент | Где | Как снижать |
| --- | --- | --- |
| sample tracks | runtime timeline | меньше tracks / step holds |
| applyState | domRenderer | dirty flags |
| style→layout | Blink | Class A, меньше width churn |
| paint/raster | Skia | Style Guide / masks |

### 10.3 Implementation

1. Сохранять единый rAF clock в channel.html.
2. Не возвращать setInterval playback в engine mode.
3. Выравнять тяжёлые JS work с tick, не с лишними microtasks.
4. Избегать лишних tick при paused (если продукт позволяет).
5. Профилировать frameTimeMs отдельно от RasterTask — разделить JS vs Skia.

```javascript
// Уже в channel.html (идея)
tickAccumMs += t - lastTickT;
while (tickAccumMs >= tickStepMs) {
  client.tick();
  tickAccumMs -= tickStepMs;
}
```

### 10.4 Measurement

Визуальный judder test + trace BeginMainFrame alignment; SUMMARY fps; stats.frameTimeMs distribution.

### 10.5 Gate

Нет регрессии judder vs main; fps не хуже; debt cap не вызывает visible stall после debugger pause в прод (только eng).

### 10.6 Rollback

Revert channel.html tick section; не трогать consumer clocks.

## 11. Bench protocol для каждой оптимизации

### 11.1 Problem

Без единого протокола «улучшения» оказываются шумом или watchdog-артефактами.

### 11.2 Analysis — обязательные стенды

| Стенд | Путь | Зачем |
| --- | --- | --- |
| Floor | bench/bench-static-beacon.html | шум / awake |
| Class A | bench-image-left vs bench-image-transform | layout vs transform |
| Masks | wipe-inset, wipe-polygon, mask-stack, alpha | Class B |
| C heavy | bench-gradients, css-blur, drop-shadow | запреты Style Guide |
| Text/Img | bench-text-100, image-stack | Class D/C |
| Layer promo | layer-baseline/willchange/contain | не регрессировать миф |
| Real | tests/templates/test1.json | integration gate |
| Cheap ctrl | tests/templates/test.json (если есть) | доказать content-bound |

### 11.3 Implementation — шаг за шагом

1. Собрать runtime + убедиться что /bg-runtime.js свежий.
2. Остановить лишние bg_engine / run-channel (pgrep -af).
3. Выбрать свободный PORT / TITULUS_DATA=/tmp/titulus-perf-XX.
4. Запуск backend не из subshell `( )`.
5. Прогнать micro-bench 20s (матрица) → записать rasterMs.
6. Прогнать test1 null 60s ×3 → median SUMMARY fps.
7. Trace 15s на representative run.
8. frame-log 60s → analyze-frame-log.mjs.
9. Сравнить с baseline commit (git stash / branch).
10. Только затем DeckLink smoke (не true-50p soak).

```bash
# Каркас протокола
export TITULUS_DATA=/tmp/titulus-perf-01
export PORT=3012
export BG_NUM_RASTER_THREADS=3
export BG_TRACE_SECONDS=15
export BG_TRACE_CATEGORIES=blink,cc,benchmark

# 1) micro
engine/research/p16/run-p16-bench.sh bench-gradients 20

# 2) test1 null 60s — через p18 runner или ручной take API
# 3) парсеры
node engine/research/lib/parse-chrome-trace.mjs "$TRACE"
node engine/research/lib/analyze-frame-log.mjs "$FRAMELOG"
```

### 11.4 Measurement — что писать в отчёт

- commit SHA, date, host, cores, N raster threads;
- SUMMARY fps (avg, min);
- RasterTask CPU-sum/frame;
- paint_latency p50/p95;
- styleWrites/skippedWrites;
- visual notes;
- pass/fail vs gate.

### 11.5 Gate

Оптимизация «зелёная» только если test1 protocol pass (§12) **или** micro-bench показывает −≥15% raster на целевом классе **и** test1 не регрессирует >2%.

### 11.6 Rollback

Ветка/PR revert; результаты оставить в research/results как negative proof.

## 12. Gate: headless/null test1 ≥45 fps / 60s

### 12.1 Problem

Phase 18 отложила true-50p до снижения cost. Нужен жёсткий числовой gate, отделяющий «надеемся» от «можно снова открывать DeckLink 50p».

### 12.2 Analysis

| Веха | test1 null fps (примерно) | Комментарий |
| --- | --- | --- |
| До Class A | ~22.7 | layout thrash |
| После Class A (P16) | ~44.9 | single-ch headless |
| P18 P0.1 | ~27 | другой прогон/условия — фиксировать протокол! |
| P17 baseline null | ~41 | N threads / cores |
| Цель doc 01 | ≥45 avg / 60s | стабильно, ×3 медиана ≥45 |

Расхождение 27 vs 44 требует **одного** канонического harness (скрипт + cores + N + duration + take method). Gate привязан к harness, не к анекдоту.

### 12.3 Implementation — канонический gate run

1. Зафиксировать `scripts` или research runner как SSOT.
2. Параметры: consumer=null, 1920×1080@50, duration=60s, cores=0,6,1,7, BG_NUM_RASTER_THREADS=3, template=test1.json.
3. Warmup 5s discard optional; reporting window 60s.
4. Повторы: 3; метрика: median of average fps.
5. Дополнительно: min fps over 5s windows ≥40 (анти-spike-only).
6. Сохранить logs + optional trace в results/p19 или performance investigation/results/.

```text
PASS iff:
  median(avg_fps_60s) >= 45.0
  AND min_5s_fps >= 40.0
  AND no engine crash
  AND static-beacon still ~50 on control run same day
```

### 12.4 Measurement

```bash
# Из лога:
# SUMMARY frames=XXXX fps=YY.YY
# avg_fps = frames / duration_wall
grep SUMMARY /tmp/engine-test1.log
```

### 12.5 Gate

**Документ 01 закрывается по fps gate.** После PASS можно: (a) планировать true-50p re-gate; (b) решать, нужен ли doc 02 urgently. После FAIL — продолжать Style Guide / runtime / masks; **не** начинать true-50p soak как primary.

### 12.6 Rollback

N/A для gate; при ложном PASS из-за watchdog — invalidate results, fix harness.

## 13. Взаимодействие с документом 02 (layered compositor)

### 13.1 Problem

Cost reduction может не хватить: даже «идеальный» test1-lite упрётся в full-frame CPU composite. Doc 02 — layered compositor / иные OSR стратегии. Нужны чёткие критерии handoff.

### 13.2 Analysis

| Ситуация | Действие |
| --- | --- |
| Gate §12 PASS | Doc 02 optional; true-50p re-open first |
| Gate FAIL, matrix показывает gradients/masks легко срезаемы | Остаться в doc 01 |
| Gate FAIL после исчерпания Style Guide+runtime+masks+threads | Открыть doc 02 |
| Layer promotion will-change уже ≈0 | Doc 02 ≠ просто will-change; нужна иная модель слоёв/CEF |
| CEF upgrade меняет P0.2 coalescing | Пересмотреть 02 и 18 вместе |

### 13.3 Implementation

1. Вести checklist исчерпания doc 01 (appendix).
2. Не смешивать PR: один PR = cost reduction XOR compositor experiment.
3. Любой doc 02 spike обязан сохранять beacon semantics и CPU-only.

### 13.4 Measurement

Handoff package: last failing gate logs, cost matrix snapshot, list tried opts, CPU% and RasterTask sums.

### 13.5 Gate

Старт doc 02 официально после written FAIL exhaustion review (короткий ADR).

### 13.6 Rollback

Если doc 02 spike ломает main — revert; doc 01 продолжается независимо.

## 14. Checklists, tables, formulas, shell tracing

### 14.1 Problem

Инженеру нужен one-stop runbook команд и формул без чтения всех phase docs.

### 14.2 Analysis / inventory инструментов

| Инструмент | Путь | Назначение |
| --- | --- | --- |
| BG_TRACE_CATEGORIES | env → engine_app.cpp | категории chrome trace |
| BG_TRACE_SECONDS | env → engine_app.cpp | окно записи |
| BG_NUM_RASTER_THREADS | env → --num-raster-threads | пул Skia/cc |
| --frame-log | bg_engine / BG_ENGINE_FRAME_LOG | CSV per tick |
| parse-chrome-trace.mjs | engine/research/lib/ | RasterTask/layout stats |
| analyze-frame-log.mjs | engine/research/lib/ | latency percentiles |
| sample-threads.sh | engine/research/lib/ | per-thread CPU |
| run-p16-bench.sh | engine/research/p16/ | матрица |
| run-p17-probe.sh | engine/research/p17/ | threads A/B |
| run-p18-trace.sh | engine/research/p18/ | trace orchestration |
| SUMMARY | stdout engine | frames/fps |
| HUD stats | channel.html?hud=1 | styleWrites |

### 14.3 Implementation — команды

```bash
# --- Preflight ---
cd /home/requestin/Titulus
pgrep -af 'bg_engine|run-channel|run-engines' || true
# убить по PID слушателя порта, не pkill -f PORT=

# --- Trace window ---
export BG_TRACE_CATEGORIES=blink,cc,benchmark
export BG_TRACE_SECONDS=15
export BG_NUM_RASTER_THREADS=3

# --- Frame log ---
# bg_engine ... --frame-log=/tmp/p19-frame.csv

# --- Analyze ---
node engine/research/lib/analyze-frame-log.mjs /tmp/p19-frame.csv
node engine/research/lib/parse-chrome-trace.mjs /path/to/trace.json

# --- Thread sample ---
engine/research/lib/sample-threads.sh <renderer_pid>

# --- Bench matrix unit ---
engine/research/p16/run-p16-bench.sh bench-static-beacon 20
```

#### 14.3.1 Формулы быстрого расчёта

```text
avg_fps = SUMMARY.frames / wall_seconds
unique_headroom = avg_fps / 50          # 1.0 = full 50p unique
raster_cpu_share ≈ RasterTask_sum_ms / (frames * 20ms)
# если raster_cpu_share > 0.5 на null — content bound сильно
field_slack_ms = 20 - paint_latency_p50_ms  # decklink
```

#### 14.3.2 Checklist перед PR perf

- [ ] bench beacon-correct
- [ ] test1 null 60s ×3 записан
- [ ] trace или frame-log приложен
- [ ] Style Guide updated если меняется authoring
- [ ] rollback описан
- [ ] не тронут browser/stream path без нужды
- [ ] CPU-only сохранён
- [ ] нет CasparCG code copy

### 14.4 Measurement

Считать runbook рабочим, если новый инженер воспроизводит ±2 fps того же SHA.

### 14.5 Gate

Команды из §14 должны совпадать с реальными entrypoints в repo (при drift — patch этого документа в том же PR).

### 14.6 Rollback

Документальный revert; скрипты research не удалять — помечать deprecated.

---

## Appendix A — Worked example: от 27 fps к плану ≥45

### A.1 Исходные данные

Дано: test1, RasterTask CPU-sum 13.5 мс/frame, unique ~27 fps на одном из p18 прогонов; Class A уже в main; masks ON в шаблоне; gradients в matrix — worst.

### A.2 Разбор вклада (гипотетическая декомпозиция)

```text
T_eff ≈ T_js_apply + T_style_layout + T_paint + T_raster_wall + T_composite + T_overhead
# Цель: T_eff ≤ 22ms для ≥45 fps
# Рычаги:
#  1) убрать animated gradients из test1 clones → огромный выигрыш если есть
#  2) inset вместо polygon где возможно
#  3) memo mask 100% hit rate на static segments
#  4) text churn ↓
#  5) N=3 threads (уже)
#  6) bake static masks
```

### A.3 Пошаговый план на 5 рабочих дней (пример)

1. День 1: канонический harness + baseline median fps.
2. День 2: аудит test1.json на Class C/B; список замен.
3. День 3: template edits (bake gradients, inset) + measure.
4. День 4: runtime memo/dirty gaps + measure.
5. День 5: gate ×3; ADR pass/fail; решение по doc 02.

### A.4 Пример таблицы эксперимента

| Exp | Change | median fps | RasterTask sum/frame | Decision |
| --- | --- | --- | --- | --- |
| E0 | baseline | 41.0 | 13.5 ms | ref |
| E1 | bake LT gradient | 43.5 | 12.1 ms | keep |
| E2 | E1+inset wipes | 46.2 | 10.4 ms | keep |
| E3 | E2+will-change | 46.0 | 10.5 ms | drop |
| E4 | E2+extra memo | 47.1 | 10.0 ms | keep |

## Appendix B — Decision trees

### B.1 Дерево: fps низкий — что делать?

```text
START: SUMMARY fps < 45 on test1 null
  |
  +- static-beacon тоже <45? --yes--> infra/CPU contention / wrong binary
  |
  +- cheap template <50? --yes--> engine/pump regression (не doc 01 content)
  |
  +- Mojo >= RasterTask? --yes--> IPC/CEF issue (редко)
  |
  +- trace: gradients/filters hot? --yes--> Style Guide Class C
  |
  +- masks ON heavy? --yes--> inset/memo/bake (Class B)
  |
  +- Layout events high + left/top writes? --yes--> Class A regression?
  |
  +- styleWrites high, skipped low? --yes--> runtime dirty-check
  |
  +- threads N!=3 and cores=4? --yes--> A/B BG_NUM_RASTER_THREADS
  |
  +- all exhausted --> ADR → document 02
```

### B.2 Дерево: выбор маски

```text
Need mask?
  +- static forever --> BAKE bitmap
  +- axis-aligned animated wipe --> clip-path inset + memo
  +- ellipse/circle --> clip-path ellipse (cheap steady)
  +- rotated / 2.5D --> projected polygon + memo + limit count
  +- complex alpha --> mask-image static; avoid animating mask-position
```

### B.3 Дерево: можно ли true-50p soak?

```text
Doc 01 gate PASS (>=45 median)?
  +- no  --> DO NOT claim true-50p; continue cost work
  +- yes --> optional DeckLink re-gate:
             empty still ~50 pairs?
             test1 in_fps / d_pairs lift?
             visual operator check
             d_late=d_dropped=0
```

## Appendix C — Bad vs Good: расширенные примеры

### C.1 Lower-third package

```css
/* BAD */
.lt {
  background: radial-gradient(circle at var(--px) var(--py), #024, transparent 70%);
  filter: drop-shadow(0 8px 24px rgba(0,0,0,.5));
  left: var(--x); top: var(--y);
  clip-path: polygon(0 0, var(--w) 0, var(--w) 100%, 0 100%);
}

/* GOOD */
.lt {
  background-image: url(lt-baked.webp);
  transform: translate3d(var(--x), var(--y), 0);
  left: 0; top: 0;
  clip-path: inset(0 calc(100% - var(--w)) 0 0);
}
```

### C.2 Scorebug

```html
<!-- BAD: весь блок innerHTML каждый тик -->
<div class="score" id="score"></div>

<!-- GOOD: фиксированная структура, textContent двух span -->
<div class="score"><span id="a">0</span>:<span id="b">0</span></div>
```

### C.3 Fullscreen blur transition

BAD: `filter: blur(0px → 20px)` на 1920×1080 слой. GOOD: pre-rendered blur plate crossfade opacity (два bitmap) или wipe inset без blur.

## Appendix D — Связь фаз (timeline)

| Фаза | Вклад в doc 01 |
| --- | --- |
| 10.5 | damage beacon correct awake |
| 11.2 | fixed-step tick = BeginFrame clock |
| 12 | Blink pipeline research: beacon ⇒ full pass |
| 15 | cost matrix; masks priority; telemetry BG_TRACE |
| 16 | gradients worst; Class A win on test1; no will-change |
| 17 | frame-log; N=3 raster threads; latency-bound decklink |
| 18 | true-50p blocked by raster cost; gate ≥45–50 foreshadowed |
| 19 / doc 01 | Style Guide + cost reduction execution |
| doc 02 | layered compositor if still insufficient |

## Appendix E — Операционные pitfalls

- Не запускать backend из subshell `( )` — сброс CWD.
- Не `pkill -f "PORT=..."` — убивать PID `ss -ltnp`.
- Перед DeckLink: `pgrep -af "bg_engine|run-channel|run-engines"`.
- Остановка канала: run-engines + run-channel, не только bg_engine.
- После правки `.sh` — `chmod +x`.
- TITULUS_DATA=/tmp/... для тестов.
- Не коммитить DeckLink SDK, engine/build, bg-runtime.js если gitignore.
- Единый @titulus/runtime — не дублировать render в frontend.

## Appendix F — Расширенный checklist Style Guide review

1. Есть ли animated gradient? → bake.
2. Есть ли blur/drop-shadow на >10% кадра? → remove/bake.
3. Сколько animated masks? → ≤ budget.
4. Маски axis-aligned? → inset.
5. Текст: частота обновления? → min DOM.
6. Images: размеры и preload?
7. Transforms: Class A path в runtime?
8. 3D/preserve-3d? → ban on-air unless gated.
9. Custom awake hacks? → delete.
10. Соответствие bench protocol после правок?

## Appendix G — Детальный словарь метрик SUMMARY / telemetry

Ниже — практический словарь полей, которые инженер читает в логах Titulus при performance investigation. Точные имена колонок frame-log см. в `engine/src/frame_log.h` и выводе `analyze-frame-log.mjs`.

**G.1. `frames`.** Число доставленных кадров/тиков за интервал SUMMARY.

**G.2. `fps`.** frames / wall time интервала SUMMARY.

**G.3. `in_fps`.** Уникальные входные bitmap/с (DeckLink telemetry) — ключ unique content rate.

**G.4. `d_late`.** Поздние кадры относительно schedule DeckLink; цель 0.

**G.5. `d_dropped`.** Дропы schedule; цель 0.

**G.6. `d_starved`.** Голодание очереди; смотреть вместе с in_fps.

**G.7. `d_pairs`.** Пары полей с двумя разными bitmap (true pair); рост = путь к true 50p.

**G.8. `d_singles`.** Пары с одним bitmap (25p-as-50i).

**G.9. `paint_seq`.** Счётчик OnPaint; delta показывает unique paints.

**G.10. `pump_active_us`.** Время в CefDoMessageLoopWork за тик.

**G.11. `paint_latency_us`.** От SendExternalBeginFrame до готовности кадра.

**G.12. `styleWrites` / `skippedWrites` / `frameTimeMs`.** Runtime RenderStats (HUD).

**G.13. `rasterMsTot` / `rasterP95`.** Парсер trace; помнить — sum parallel RasterTask.

## Appendix H — Пошаговый сценарий воспроизведения Phase 16 Class A win

1. Checkout SHA Phase 16 merge (или main после PR).
2. Убедиться compositePosition:true в domRenderer on-air path.
3. Снять Layout event counts из trace на test1.
4. Временно форсировать compositePosition:false за feature flag (если есть) или local patch.
5. Повторить trace+SUMMARY 60s.
6. Сравнить Layout p95 и fps.
7. Ожидание: legacy left/top хуже на многослойном шаблоне.
8. Откатить local patch.

## Appendix I — Шаблоны отчёта (копипаст)

```markdown
## Perf experiment report

- Date:
- SHA:
- Host / cores / BG_NUM_RASTER_THREADS:
- Template:
- Consumer:
- Duration / repeats:

### Results
| run | SUMMARY fps | RasterTask/frame | paintLat p95 | notes |
|-----|------------:|-----------------:|-------------:|-------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| median | | | | |

### Gate
- [ ] ≥45 median fps (test1 null 60s)
- [ ] control static-beacon ~50
- [ ] no flicker / visual OK

### Decision
keep / drop / needs doc 02

### Rollback
git revert …
```

## Appendix J — Матрица приоритетов работ

| Работа | Reach | Impact | Confidence | Effort | Priority note |
| --- | --- | --- | --- | --- | --- |
| Bake gradients in test1 | high | very high | high | med | делать первым |
| inset vs polygon audit | high | high | high | low | быстрый win |
| mask memo gaps | med | med | high | low | обязательно |
| text churn cut | med | med | med | med | после B/C |
| image decode cache | med | low-med | med | med | spikes |
| raster threads retune | low | low | high | low | уже ~оптимум |
| will-change again | low | none | high | low | не делать |
| doc 02 layered | high | unknown | low | high | после exhaustion |

## Appendix K — Расширенные shell one-liners

```bash
# Найти активный bg_engine (не spare renderer)
ps -eo pid,comm,cmd | awk '$2=="bg_engine"{print}'

# Порт backend
ss -ltnp | grep -E '3002|3012'

# Последний SUMMARY в логе
rg "SUMMARY" /tmp/engine-*.log | tail -20
```

## Appendix L — Почему не копируем CasparCG

CasparCG HTML producer — иной process model и licensing surface. Titulus — clean-room: смотрим поведение/идеи (SDI master clock, frame accurate), но реализуем своим CEF OSR + ChannelClient. Любая оптимизация raster cost должна жить в нашем runtime/DOM/Skia path, без переноса GPL-кода. См. `docs/CASPARRCG_PORTING.md`, `engine/THIRD_PARTY_NOTICES.md`.

## Appendix M — CPU scaling notes

Масштабирование: 1 bg_engine = 1 channel = taskset на 2 physical cores (+ SMT siblings). Не расползать renderer на все ядра машины при 3 каналах — cache thrash. BG_NUM_RASTER_THREADS = n_cores-1 оставляет headroom main/IO. Doc 01 оптимизации **снижают работу на канал**, что линейно помогает multi-channel больше, чем +1 raster thread.

```text
# Грубая модель 3 каналов
# если один канал content-bound 25 unique fps, три канала не станут 50
# cost cut 2× на канал → ближе к unique 45–50 и меньше contention
```

## Appendix N — Visual QA checklist

- Lower-third wipe: край ровный, без missing tiles.
- Alpha key: нет серого мата на чёрном preview.
- Rotated group + mask: нет collapse clip.
- Clock digits: нет jump width (tabular-nums).
- Static hold 30s: картинка жива (beacon), без flicker.
- Take → clear → take: нет stuck mask / leaked DOM.

## Appendix O — Mapping файлов кода к рычагам

| Рычаг | Файлы |
| --- | --- |
| Beacon / tick | backend/public/channel.html |
| Class A transforms | runtime/src/transform.ts, domRenderer.ts |
| Masks | runtime/src/maskGeometry.ts, maskScopes.ts, domRenderer.ts |
| Trace env | engine/src/engine_app.cpp |
| Frame log | engine/src/frame_log.cpp, main.cpp |
| Raster threads | engine_app.cpp, run-channel.sh |
| Bench | bench/*.html, engine/research/p16/* |
| Gate template | tests/templates/test1.json |

## Appendix P — Частые ложные выводы

1. «fps=4» на bench → забыли playTimeline / beacon (Phase 15 lesson).
2. «will-change ускорит» → P16 доказал ≈0 на CPU OSR.
3. «Добавим Invalidate» → чёрный flicker.
4. «dual BeginFrame спасёт test1» → P18 pctTicksDeltaGe2=0%.
5. «N=8 raster threads» → SMT contention, без win.
6. «rasterMs p95 191ms значит кадр 191ms» → это sum parallel tasks.
7. «null 45 fps ⇒ DeckLink true 50p гарантирован» → нет, нужен отдельный re-gate; но 45 — necessary precondition.

## Appendix Q — Долгий FAQ

### Q: Почему цель именно 45, а не 50?

45 даёт запас на DeckLink scheduling/weave и доказывает, что content не на жёстком 25p потолке; 50 — идеал, 45 — go-критерий doc 01.

### Q: Можно ли отключить beacon на static сегментах timeline?

Риск засыпания OSR высок; только под feature flag + watchdog proof. По умолчанию — нет.

### Q: GPU path?

Отдельный gate-doc; вне scope CPU-only non-negotiable.

### Q: Почему editor не всегда composited position?

Overlay и mask projector требуют absolute box left/top математики.

### Q: Что если test1 нельзя упростить визуально?

Тогда bake/assets и doc 02; не бесконечные pump tricks.

### Q: Как понять, что memo работает?

skippedWrites↑, отсутствие лишних clipPath string churn в performance.mark/logs.

### Q: Нужны ли unit tests?

По политике репо — только по явному запросу; perf gate = bench+SUMMARY.

### Q: Где хранить results?

engine/research/results/p19/ или docs/performance investigation/results/.

### Q: Влияет ли WebSocket на raster?

Нет при нормальном take; control plane не в hot path кадра.

### Q: Почему русский документ с English terms?

Термины совпадают с Chromium/кодом; язык команды — русский.

## Appendix R — Sequence diagram (логический)

```text
Operator TAKE test1
    -> backend OnAirManager
    -> WS /ws/renderer
    -> ChannelClient
    -> TemplateRenderer.applyState (JS)
    -> DOM styles (transform/clip)
    -> rAF heartbeat + beacon damage
    -> CEF External BeginFrame
    -> Blink style/layout/paint
    -> cc RasterTask tiles (Skia CPU)
    -> Composite
    -> OnPaint BGRA
    -> FrameRing
    -> null consumer (count fps)  OR decklink WaitForTick path
```

## Appendix S — Definition of Done для документа 01

- Канонический harness записан и воспроизводим.
- Style Guide v1 смержен (forbidden/expensive/preferred).
- test1 (или согласованный successor) проходит ≥45 median fps null 60s.
- Матрица bench обновлена при новых правилах.
- ADR: pass → next true-50p; fail exhaustion → doc 02.
- Этот файл актуален командам §14.

## Appendix T — История ревизий документа

| Версия | Дата | Изменение |
| --- | --- | --- |
| 0.1 | 2026-07-13 | Первичная сборка из Phase 12–18 evidence |

## Appendix U — Exhaustion checklist перед doc 02

- [ ] Style Guide applied to test1 (or successor) with operator visual OK
- [ ] All Class C animated gradients removed or baked
- [ ] Mask path: inset where possible; memo hit-rate measured
- [ ] Runtime dirty-check skippedWrites ratio documented
- [ ] Text/image spikes addressed
- [ ] BG_NUM_RASTER_THREADS A/B redone on current SHA
- [ ] Canonical gate FAIL ×3 with logs archived
- [ ] ADR written: why cost reduction insufficient
- [ ] No open pump-only hypothesis without new CEF evidence

## Заключение

True 50p на сложном эфире упирается не в «ещё один pump», а в **стоимость кадра Blink/Skia**. Damage beacon обязан жить — значит, экономим на content и runtime dirty-path. Cost matrix уже указала врагов: animated gradients, mask stacks, text churn, layout thrash. Class A и N=3 threads дали часть пути; Style Guide + mask strategy + memo + bake должны довести headless test1 до **≥45–50 unique fps**. Пока gate не зелёный — layered compositor (02) и DeckLink true-50p soak не являются главной ставкой.

Rollback любой оптимизации — обязателен и дешёв (feature flag / revert). Измерение — только каноническим протоколом. CPU-only HTML5 path сохраняем.

