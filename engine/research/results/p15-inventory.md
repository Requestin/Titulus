# Phase 15 P2 — Полный инвентарь setStyle и потребителей AppliedTransform

## 1. Вызовы `applyTransform(...)` в кодовой базе

| Файл:строка | Контекст | Потребитель результата |
|---|---|---|
| [runtime/src/domRenderer.ts:596](../../src/../../../runtime/src/domRenderer.ts) | `applyLayerState` — обычный слой | `setStyle` (left/top/width/height/transform) |
| [runtime/src/domRenderer.ts:633](../../src/../../../runtime/src/domRenderer.ts) | `applyMaskScopes` — сам mask-layer | вычисление `clipAt`/projected outline |
| [runtime/src/domRenderer.ts:647](../../src/../../../runtime/src/domRenderer.ts) | `applyMaskScopes` — родительская маска (для nested) | `containerW/H`, оффсет `clipAt` |
| [runtime/src/domRenderer.ts:745](../../src/../../../runtime/src/domRenderer.ts) | `applyGroupState` — группа | `setStyle` (left/top/width/height/transform) |
| [frontend/src/editor/CanvasArea.tsx:125](../../../frontend/src/editor/CanvasArea.tsx) | `overlayForTransform` — маска (editor overlay) | `projectMaskOutline` для полигона выделения |
| [frontend/src/editor/CanvasArea.tsx:145](../../../frontend/src/editor/CanvasArea.tsx) | `overlayForTransform` — обычный слой (editor overlay) | `at.left/top/width/height * zoom` |
| [frontend/src/editor/CanvasArea.tsx:306](../../../frontend/src/editor/CanvasArea.tsx) | drag-handler — обновление позиции во время драга | `d.el.style.left/top` (прямая запись в DOM во время drag) |

**Вывод:** editor читает `left`/`top`/`width`/`height` НАПРЯМУЮ в трёх местах.
Контракт `AppliedTransform` **обязан** сохранить эти поля — расширение, а не
замена, как и запланировано в P3.

## 2. Полный список `setStyle`/`style.` вызовов в domRenderer.ts (классификация)

| Свойство | Строки | Элемент | Источник | Кадр-в-кадр? | Класс |
|---|---|---|---|---|---|
| `display` | 587, 743 | layer, group | visible | редко | non-concern |
| `opacity` | 592 | layer | anim.opacity | ДА | non-concern (compositable) |
| `mixBlendMode` | 593 | layer | blendMode | редко | minor |
| `left`, `top` | 601-602 | layer | `at.left/top` ← x,y,anchor,width,height | **ДА** при анимации x/y | **A** |
| `width`, `height` | 603-604 | layer | `at.width/height` | **ДА** при анимации width/height | **A** |
| `transformOrigin` | 605 | layer | originX/Y ← width\*anchorX | ДА (зависит от width) | **A** (производное) |
| `transform` | 606 | layer | rotate/rotateX/Y/scale/perspective | ДА | non-concern (compositable) |
| `transformStyle` | 609-611 | layer | needs3d | редко | minor |
| `left`, `top` (=0) | 689-690, 717-718 | mask clip-host | константа `'0'` | нет | non-concern |
| `width`, `height` | 691-692, 719-720 | mask clip-host | containerW/H | иногда (при resize контейнера) | B (косвенно) |
| `overflow` | 693, 721 | mask clip-host | clip.overflow | иногда | **B** |
| `clipPath` | 697, 722 | mask clip-host | projected polygon / inset | **ДА** для анимированной маски | **B (главный)** |
| `borderRadius` | 698, 723, 818, 830, 869 | mask clip-host, fill, media | cornerRadius | редко | C |
| `maskImage`+Webkit | 699-700, 724-725 | mask clip-host | `clip.maskImage` | ДА для non-projected динамической | **B** |
| `maskMode`+Webkit | 701-702, 726-727 | mask clip-host | константа | нет | non-concern |
| `maskSize`+Webkit | 703-704, 728-729 | mask clip-host | `clip.maskSize` | ДА | **B** |
| `maskRepeat`+Webkit | 705-706, 730-731 | mask clip-host | константа | нет | non-concern |
| `maskPosition`+Webkit | 707-708, 732-733 | mask clip-host | `clip.maskPosition` | ДА | **B** |
| `left`, `top` | 750-751 | group | `at.left/top` | ДА при анимации | **A** |
| `width`, `height` | 752-753 | group | `at.width/height` | ДА | **A** |
| `transformOrigin` | 754 | group | originX/Y | ДА (производное) | **A** |
| `transform` | 755 | group | rotate/scale/perspective | ДА | non-concern |
| `perspective` | 756 | group | gt.perspective | редко | minor |
| `transformStyle` | 758 | group | needs3d | редко | minor |
| `background` | 817, 828 | fill (rect) | layer.fill / 'transparent' | ДА только если fill анимируется | C |
| `border` | 822, 829 | fill (rect) | layer.border | редко | C |
| `clipPath` | 831 | fill (rect, non-mask) | `'none'` | нет | non-concern |
| `pointerEvents` | 832 | fill (rect) | константа | нет | non-concern |
| `fontFamily/Size/Weight` | 839-841 | text | style + bindings | при data binding, не кадр-в-кадр | D |
| `color` | 842 | text | `resolveBinding(s.fill,v)` | при data binding | D |
| `textAlign`/`justifyContent`/`alignItems` | 843-846 | text | style.align | редко | D |
| `lineHeight`/`letterSpacing` | 847-848 | text | style | редко | D |
| `whiteSpace` | 849 | text | константа | нет | non-concern |
| `webkitTextStroke`/`textShadow` | 850-852 | text | style | редко, но ДА если анимируется | C |
| `borderRadius`/`objectFit` | 869-870 | media (image) | cornerRadius/fit | редко | non-concern/C |
| `objectFit` | 881 | media (video) | layer.fit | нет | non-concern |

## 3. Потребители геометрических полей `AppliedTransform` вне `setStyle`

| Файл | Что читает | Зачем |
|---|---|---|
| [runtime/src/maskGeometry.ts:78-79](../../src/../../../runtime/src/maskGeometry.ts) | `at.width`, `at.height` | Сэмплирование контура эллипса/rounded-rect для projected mask |
| [runtime/src/maskGeometry.ts:97-98](../../src/../../../runtime/src/maskGeometry.ts) | `at.originX`, `at.originY` | Пивот для проекции |
| [runtime/src/maskGeometry.ts:152-153](../../src/../../../runtime/src/maskGeometry.ts) | `at.left`, `at.top` | Абсолютные координаты контура маски в контейнере |
| [runtime/src/maskScopes.ts (hasZRotation)](../../src/../../../runtime/src/maskScopes.ts) | `at.transform` (строка) | Определение, повёрнута ли маска (T2 path) |
| [frontend/src/editor/CanvasArea.tsx:125-149](../../../frontend/src/editor/CanvasArea.tsx) | `at.left/top/width/height` | Overlay/selection box для UI редактора |
| [frontend/src/editor/CanvasArea.tsx:306-308](../../../frontend/src/editor/CanvasArea.tsx) | `at.left/top` | Прямая запись в DOM во время drag (editor, не движок) |

**Вывод:** `maskGeometry.ts` — самый плотный потребитель полей `left/top/
width/height/originX/originY`. Любое изменение семантики этих полей в P3
ломает projected-mask расчёты. План P3 сохраняет их как есть (только
добавляет новые поля), поэтому `maskGeometry.ts` не требует правок в P3-A.

## 4. Итоговая классификация (сводка) с учётом P1 cost-matrix

По результатам [p15-cost-matrix.md](p15-cost-matrix.md):

- **Класс A** (left/top/width/height на layer/group) — миграция на
  `translate3d`/`scale` **не показала выигрыша** в изолированном bench-тесте.
  Приоритет: низкий, точечный эксперимент прямо на `test1` (не полный
  рефакторинг).
- **Класс B** (clipPath/maskImage на mask clip-host) — **главный источник
  raster-cost**, подтверждено и в P0 baseline (93x разница test/test1), и в
  P1 matrix (маски измеримо дороже, масштабируются с количеством). Приоритет:
  **высокий**, основной фокус P3.
- **Класс C** (background/textShadow/borderRadius) — не выявлено активных
  анимаций этих свойств в `test`/`test1` по данным P0 (paint.paint
  составляет менее 4% от raster.task по длительности). Приоритет: низкий,
  проверить только если после P3-B остаётся значимый paint-вклад.
- **Класс D** (текстовые стили) — меняются только при data binding (часы
  обновляются раз в секунду, не 50 раз). Приоритет: не требуется.
