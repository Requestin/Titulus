# Phase 16 — Performance Matrix + Layer Promotion

Дата: 8 июля 2026.

Цель фазы:
- расширить матрицу стоимости CSS-свойств в CPU-only OSR;
- проверить layer promotion (`will-change` / `contain`) на реальных замерах;
- реализовать Class A (left/top -> composited transform) с сохранением визуальной корректности;
- подтвердить результат на `test1` и 3-канальном DeckLink soak.

## Контекст

Phase 15 завершилась с `in_fps≈25` на 3 каналах (`test1`) и главным выводом:
маски (Class B) дают основной raster-cost, а изолированный bench `left/top` vs
`translate3d` не показывал выигрыша для одиночного элемента малого размера.

В Phase 16 проверяем это на более широком наборе и на реальном `test1` с
группами, масками и множеством одновременно анимируемых элементов.

## P0 — Performance Matrix (расширение bench-набора)

Добавлены стенды:
- `bench/bench-clip-circle.html`
- `bench/bench-css-blur.html`
- `bench/bench-drop-shadow.html`
- `bench/bench-text-100.html`
- `bench/bench-image-stack.html`
- `bench/bench-gradients.html`
- `bench/bench-layer-baseline.html`
- `bench/bench-layer-willchange.html`
- `bench/bench-layer-contain.html`

И использованы существующие:
- `bench/bench-static-beacon.html` (шумовой floor)
- `bench/bench-wipe-inset.html` и `bench/bench-wipe-polygon.html` (из Phase 15)

Запуск: `engine/research/p16/run-p16-bench.sh <bench> 20`, `--consumer=null`,
`BG_TRACE_SECONDS=20`, анализ через `engine/research/lib/parse-chrome-trace.mjs`.

Результаты (основные метрики):

| bench | rasterMsTot | rasterP95 | rasterMax | rasterEvMax | комментарий |
|---|---:|---:|---:|---:|---|
| bench-static-beacon | 3133.0 | 0.0 | 16.1 | 78 | шумовой baseline |
| bench-clip-circle | 3013.0 | 0.0 | 3.2 | 14 | ellipse mask, дешёвый steady-state |
| bench-css-blur | 3184.0 | 0.0 | 16.8 | 102 | blur-пики заметны в max |
| bench-drop-shadow | 3100.0 | 0.0 | 19.4 | 102 | похожий профиль с blur |
| bench-image-stack | 3094.0 | 0.0 | 21.4 | 54 | движение нескольких bitmap |
| bench-text-100 | 19760.0 | 2.7 | 77.6 | 270 | текстовый churn дороже baseline |
| bench-gradients | 194589.0 | 41.6 | 52.6 | 214 | доминирующий raster-cost |

Выводы P0:
1. Градиентные фоны с покадровым изменением параметров — самый дорогой
   сценарий в матрице (кратно выше остальных стендов).
2. Маски `circle/ellipse` в steady-state заметно дешевле градиентного
   перерисовывания больших областей.
3. Текстовая нагрузка (`textContent` churn) ощутима, но далеко от градиентного
   worst-case.

## P1 — Layer promotion A/B

Стенды:
- baseline: `bench-layer-baseline.html`
- will-change: `bench-layer-willchange.html`
- contain: `bench-layer-contain.html`

Результат:
- baseline: `rasterMsTot=3574.0`, `rasterMax=57.1`
- will-change: `rasterMsTot=3571.0`, `rasterMax=65.8`
- contain: `rasterMsTot=3571.0`, `rasterMax=66.7`

Разница baseline -> will-change/contain около `-0.08%` по `rasterMsTot`
(в пределах шума), при этом `rasterMax` хуже у обоих вариантов.

Решение P1:
- **Layer promotion в runtime не применять** (P2 отменён).
- Для CPU-only OSR на текущем профиле контента ни `will-change`, ни
  `contain: layout style paint` не дали измеримого выигрыша.

## P3 — Class A (left/top -> composited transform)

### Что изменено

`runtime/src/transform.ts`:
- `AppliedTransform` расширен полем `useCompositedPosition`.
- `applyTransform()` получил опцию `compositePosition`.
- при `compositePosition: true` позиция упаковывается в `transform` через:
  - `translate3d(left, top, 0)` + pivot wrap
  - `translate(origin) ... rotate/scale ... translate(-origin)`
- при `compositePosition: false` сохранено legacy-поведение (для editor overlay
  и mask geometry-потребителей).

`runtime/src/domRenderer.ts`:
- `applyLayerState` и `applyGroupState` вызывают `applyTransform(..., { compositePosition: true })`;
- при composited-режиме пишут в DOM:
  - `left: 0px`, `top: 0px`
  - `transformOrigin: 0px 0px`
  - `transform: <composited>`
- `width/height` продолжают писаться как прежде.

Это убирает покадровые `left/top` writes для x/y/rotation анимаций.

### Headless валидация на test1 (single-channel)

После P3:
- `SUMMARY fps=44.92` (раньше в baseline было ~22.71 на этом же сценарии)
- в trace: `Layout events p95=26` (существенно ниже baseline класса Phase 15)

Вывод:
- На реальном `test1` (много слоёв/групп/масок) Class A даёт крупный выигрыш,
  несмотря на нулевой эффект в изолированном micro-bench из Phase 15.

## P4 — Editor regression

Проверено в editor на `test1`:
- шаблон загружается и проигрывается;
- слои рендерятся корректно;
- группы с rotation имеют корректные неединичные matrix (rotation + translate);
- computed style для layer/group в новом режиме:
  - `left=0`, `top=0`, `transform-origin=0 0`, `transform=matrix(...)`
  - без NaN/битой геометрии.

Вывод: регрессий визуальной геометрии не обнаружено.

## P4 — 3-channel DeckLink soak (15 мин)

Сценарий:
- 3 канала на backend `:3003` с `test1` (из `tests/templates/test1.json`);
- 3 процесса `bg_engine --consumer=decklink` на `device-index=1/2/3`;
- длительность 900с (15 минут);
- trace: `BG_TRACE_SECONDS=60` (канал 1).

SUMMARY:
- Ch1: `frames=22499 fps=24.97`
- Ch2: `frames=22691 fps=25.05`
- Ch3: `frames=22471 fps=24.92`
- среднее: **24.98 fps**

Telemetry (`telemetry5s`) за весь прогон:
- `d_late` max = 0 на всех 3 каналах;
- `d_dropped` max = 0 на всех 3 каналах;
- `d_starved` avg ~= 4.3 (ch1), 4.2 (ch2), 4.4 (ch3).

Итог:
- 3-канальный DeckLink режим стабилен около потолка 25p-as-50i;
- Class A не вызвал деградации SDI-вывода.

## Property Matrix (сводка 20+ свойств/паттернов)

| Свойство/паттерн | Категория | Источник | Вердикт |
|---|---|---|---|
| `left` | A | `test1`, Class A | дорого при массовой анимации |
| `top` | A | `test1`, Class A | дорого при массовой анимации |
| `width` | A | mask wipe benches | Layout-триггер |
| `height` | A | mask wipe benches | Layout-триггер |
| `transform: translate3d` | A | image/layer benches | дешёвый путь позиции |
| `transform: rotate` | A | group tracks | работает в composited схеме |
| `transform: scale` | A | runtime path | работает в composited схеме |
| `transform-origin` | A | Class A fix | в runtime -> `0 0` + pivot wrap |
| `clip-path: inset()` | B | `bench-wipe-inset` | умеренная стоимость |
| `clip-path: polygon()` | B | `bench-wipe-polygon` | дороже inset |
| `clip-path: circle/ellipse` | B | `bench-clip-circle` | дёшево в steady-state |
| `mask-image` | B | mask path | зависит от области/анимации |
| `mask-size` | B | mask path | вклад в B-класс |
| `mask-position` | B | mask path | вклад в B-класс |
| `overflow` clip-host | B | mask path | служебный, недорогой сам по себе |
| `filter: blur()` | C | `bench-css-blur` | пики raster в max |
| `filter: drop-shadow()` | C | `bench-drop-shadow` | пики raster в max |
| `background: linear-gradient` | C | `bench-gradients` | очень дорогой при покадровом изменении |
| `background: radial-gradient` | C | `bench-gradients` | очень дорогой при покадровом изменении |
| `background-position` анимация | C | `bench-gradients` | критичный raster-driver |
| `textContent` churn | D | `bench-text-100` | заметная стоимость |
| `font-variant-numeric` | D | clock/text benches | нейтрально, полезно для стабильности |
| `text-shadow` | C/D | `bench-text-100` | увеличивает paint/raster текста |
| множественные image bitmap | B/C | `bench-image-stack` | умеренный raster overhead |

## Промежуточный итог Phase 16

1. P0 выполнен: матрица расширена, ключевые hot path подтверждены числами.
2. P1 выполнен: layer promotion (`will-change`, `contain`) не даёт выигрыша.
3. P3 выполнен: Class A реализован корректно и дал сильный прирост на `test1`
   в single-channel headless проверке (`fps ~22.7 -> 44.9`).
4. P4 (editor + 3-channel DeckLink soak) пройден без визуальных регрессий
   и без `d_late/d_dropped`.
5. Следующий шаг: Phase 17 (почему CPU не насыщается полностью и где
   throughput/latency bottleneck после Class A).

