# Changelog — ветка `sergey-v1` (2–3 июля 2026)

> Сводка изменений в editor / runtime за **2 и 3 июля 2026**.  
> Коммит: `add copy in tree, fix axis center, ui editor`

---

## 2 июля 2026

Отдельных коммитов на `sergey-v1` за этот день в git нет. Актуальное состояние ветки на конец 1 июля — коммиты `1b0eadb` (axis center, UI) и `82150e8` (session context doc).

---

## 3 июля 2026 — editor: copy in tree, axis center, groups, UI

### 1. Copy в дереве слоёв (LayersPanel)

- **Ctrl/Cmd + drag** — копирование перетаскиваемых элементов (deep clone) вместо перемещения.
- Клонирование слоя или целой группы с поддеревом: новые `id`, перепривязка `groupId` / `parentId`, дублирование timeline-треков (`trackDirectors`, keyframes).
- Визуальная подсказка при copy-drag: зелёная линия drop / подсветка группы (`copyHint`).
- После drop копии автоматически выделяется первый склонированный элемент.

### 2. Удаление из дерева слоёв

- Кнопка **Delete** (Trash) на каждой строке дерева (по hover).
- `store.deleteEntry(kind, id)` — удаление слоя или группы целиком с поддеревом, очистка stack, timeline (`purgeTimelineTargets`, `collectGroupSubtree`).
- Кнопка Delete убрана из верхнего Toolbar (удаление только из дерева).

### 3. Axis center — группы

**Смена axis center группы:**
- Обновляются только `anchorX` / `anchorY` — без компенсации `x/y` группы.
- Дети остаются на месте в canvas; двигается только crosshair pivot.

**Вращение группы:**
- Новый модуль `runtime/src/groupBounds.ts`: bbox детей → `transform-origin`.
- `applyGroupTransform` / `mapPointThroughGroupTransform` — origin из `bbox.minL/minT + size × anchor`.
- `domRenderer.applyGroupState` использует bbox-based origin (раньше `width/height = 0` → вращение всегда вокруг `(0,0)`).
- Editor overlay (`groupPivotCanvasPoint`, `walkAncestorGroups`) синхронизирован с runtime.

### 4. Reparent в/из группы — без компенсации координат

**Было:** при drag в группу / из группы координаты пересчитывались через `inverseMapPointThroughTransform` / `captureGlobalPivots`, чтобы сохранить глобальную позицию на canvas.

**Стало:**
- Вложение в группу — `x/y` объекта **не меняются**; смещение/rotation/scale группы применяются через иерархию.
- Вытаскивание на root или в родительскую группу — `x/y` **не меняются**; убрана `unparentEntriesToCanvas`.
- `reparentEntriesIntoGroup` только обновляет bounds группы (`width/height = 0`).

### 5. UI Properties — раздел Transform

- **Transform** разбит на две секции:
  - **Size** — Width/Height (только layer), Scale X/Y.
  - **Position** — X/Y, Rotation (X/Y/Z + Perspective), Axis center.
- Для групп отдельная **Size** и **Position** (без Width/Height у группы).

### 6. Canvas overlay

- Selection bbox слоёв учитывает ancestor group transforms (`layerCanvasAabb`, `mapLayerPointToCanvas`).
- Mask outline проецируется через group chain.
- Group pivot crosshair через `groupPivotCanvasPoint` + `groupTransformResolver` (timeline-aware).

### 7. Новые слои — anchor top-left

- `createEditorTransform()` — `anchorX: 0`, `anchorY: 0`, position `(0, 0)`.
- Все типы слоёв (text, rect, image, video, clock, mask) создаются с top-left pivot.

### 8. Store / groupBounds refactor

- Убраны `updateGroupBounds` / `updateAncestorGroupBounds` при каждом `updateTransform`.
- `computeGroupBbox` / `computeGroupUnion` перенесены в `@runtime` (`runtime/src/groupBounds.ts`), реэкспорт в editor.
- `setLayerGroup`: при снятии с группы — `addEntry` в root без пересчёта координат.

---

## Затронутые файлы

| Файл | Изменения |
|------|-----------|
| `frontend/src/editor/panels/LayersPanel.tsx` | Copy-drag, delete row, reparent без компенсации |
| `frontend/src/editor/groupBounds.ts` | Group axis/reparent/pivot; делегирование в runtime |
| `frontend/src/editor/pivot.ts` | Group-aware `walkAncestorGroups` |
| `frontend/src/editor/panels/PropertiesPanel.tsx` | Size / Position sections |
| `frontend/src/editor/CanvasArea.tsx` | Group-aware overlay, mask projection |
| `frontend/src/editor/store.ts` | `deleteEntry`, subtree purge, reparent |
| `frontend/src/editor/factories.ts` | `createEditorTransform` |
| `frontend/src/editor/Toolbar.tsx` | Убран Delete |
| `runtime/src/groupBounds.ts` | **новый** — bbox, group transform-origin |
| `runtime/src/domRenderer.ts` | `applyGroupTransform` для групп |
| `runtime/src/index.ts` | export groupBounds |
| `package-lock.json` | lockfile update |

---

## Проверка

```bash
cd runtime && npm run build && npx tsc --noEmit
cd ../frontend && npx tsc --noEmit
```

Ручная проверка в editor:
- [ ] Ctrl/Cmd+drag копирует слой/группу в дереве
- [ ] Delete на строке дерева удаляет элемент
- [ ] Axis center группы — crosshair двигается, дети на месте
- [ ] Rotation группы — вокруг выбранного axis center
- [ ] Drag в/из группы — координаты в Properties не пересчитываются
