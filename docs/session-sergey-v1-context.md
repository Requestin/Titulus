# Контекст сессии разработки — ветка `sergey-v1`

> Сводка работы Sergey + агент Cursor.  
> Обновлено: **1 июля 2026**.

---

## Репозиторий и ветка

| Параметр | Значение |
|---|---|
| Workspace | `/home/ladmin/Documents/broadcast-graphics-vasia/Titulus` |
| Remote | `git@github.com:Requestin/Titulus.git` |
| Ветка | `sergey-v1` (tracking `origin/sergey-v1`) |
| База | `main` |

### Коммиты на ветке (актуально)

| Hash | Сообщение |
|---|---|
| `1b0eadb` | `add axis center, fix some bugs` |
| `d396ede` | `fix timeline, add mask, add editor feature` |
| `d31b1f1` | `new fix mask` |
| `1a2df0e` | `fix UI editor and mask` |

---

## Сессия 1 июля 2026 — editor: axis center, groups, UI polish

### 1. Axis center (ось координат / pivot)

**Смысл:** параметр задаёт точку, относительно которой считаются координаты позиции и вращение объекта. В данных — `transform.anchorX` / `anchorY` (0…1), в UI показываются **пиксели** относительно bounding box.

**UI (`PropertiesPanel.tsx`):**
- Подраздел **Axis center** в конце Transform (X, Y).
- Числовое поле + drag, кнопка **R** (сброс в центр).
- Пресеты: X → **L / C / R**, Y → **B / C / T**.
- На canvas при выделении — перекрестие осей (красный/live) в точке pivot.

**По умолчанию:** `createDefaultTransform()` → `anchorX: 0.5`, `anchorY: 0.5` (`runtime/src/schema.ts`).

**Новые модули:**
- `frontend/src/editor/pivot.ts` — `pivotCanvasPoint`, `mapPointThroughTransform`, `inverseMapPointThroughTransform`, `localDeltaToCanvas`.
- `frontend/src/editor/groupBounds.ts` — axis center helpers, group bounds, reparent.

**Компенсация позиции** при смене anchor: `anchorCompensatedUpdate()` из `@runtime` (визуальная позиция не прыгает).

---

### 2. Rotation — подраздел Transform

Бывшие **Tilt X / Tilt Y / Rotate** объединены в подраздел **Rotation**:

| UI | Поле transform |
|---|---|
| X | `rotationX` |
| Y | `rotationY` |
| Z | `rotation` |

Справа от **R** — кнопки **+45** / **-45** (шаг 45°).

**Perspective** перенесён в подраздел Rotation (последним после X, Y, Z).

---

### 3. Timeline — имена rotation-треков

Отображаемые имена (внутренние ключи без изменений):

| Было | Стало |
|---|---|
| `rotation` | `rotationZ` |
| `rotationX` | `rotationX` |
| `rotationY` | `rotationY` |

Файл: `frontend/src/editor/panels/TimelinePanel.tsx` (`trackPropLabel`).

---

### 4. NumberInput — stepper ↑↓

**Файл:** `frontend/src/components/ui/form.tsx`

Между значением и **R** — две кнопки (↑ / ↓), ±1 (или `stepperStep`).  
Дополнительно: `extraActions` (используется для +45 / -45 на rotation).

---

### 5. Группы — reparent без «улёта» объектов

**Проблема:** при добавлении в группу объекты прыгали на координаты группы.

**Решение (`groupBounds.ts`, `LayersPanel.tsx`, `store.ts`):**
1. До смены родителя — `captureGlobalPivots()` (canvas pivot каждого объекта).
2. Пустая группа принимает pivot **верхнего по z-order** объекта из выделения (`topmostMovingEntry`).
3. Каждый объект переводится в локальные координаты группы через `inverseMapPointThroughTransform` — **глобальная позиция сохраняется**.
4. `updateGroupBounds` нормализует локальный origin детей с компенсацией pivot группы.

При выносе из группы (dropdown «(none)» или DnD на root) — координаты возвращаются в canvas-space.

---

### 6. Группы — width/height всегда 0

**Требование:** размеры группы не участвуют в позиционировании, всегда `width = 0`, `height = 0`.

- Убраны поля Width/Height из UI группы.
- Принудительно при: создании, `load()`, `updateTransform`, `updateGroupBounds`, `setEntryTransform`.
- Selection box группы строится по union детей на canvas (`groupCanvasAabb`), не по `transform.width/height`.
- Axis center группы в UI использует union детей только для отображения/редактирования anchor (без записи размеров в transform).

---

### 7. Save — индикатор несохранённых изменений

**Файл:** `frontend/src/editor/Toolbar.tsx`

При `dirty === true` — жёлтый кружок в левом верхнем углу кнопки **Save**. После сохранения исчезает. Текст «Unsaved» убран.

---

### 8. Баг: чёрная страница редактора

**Причина:** в `PropertiesPanel.tsx` случайно удалены импорты `useEditor`, `effectiveTransform`, helpers из `groupBounds` → `ReferenceError` при рендере.

**Исправление:** восстановлены импорты.

---

### 9. Directors (справка, без кода)

**Director** — отдельная анимационная под-последовательность в темплейте. Переключение director в timeline меняет контекст редактирования keyframes (активный director, playhead, duration). Keyframes привязываются к director через `trackDirectors`. Dope sheet показывает все треки; playhead относится к выбранному director.

---

## Ключевые файлы (сессия 1 июля)

| Область | Файлы |
|---|---|
| Axis center / groups | `frontend/src/editor/groupBounds.ts`, `pivot.ts` |
| Properties UI | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Canvas overlay | `frontend/src/editor/CanvasArea.tsx` |
| Layers DnD + groups | `frontend/src/editor/panels/LayersPanel.tsx` |
| Store | `frontend/src/editor/store.ts` |
| Timeline labels | `frontend/src/editor/panels/TimelinePanel.tsx` |
| NumberInput | `frontend/src/components/ui/form.tsx` |
| Toolbar dirty dot | `frontend/src/editor/Toolbar.tsx` |
| Default anchor | `runtime/src/schema.ts` |

---

## Сессия 30 июня 2026 (краткая сводка)

Ранее на ветке `sergey-v1`:

- Engine CEF path fix, dev-start LAN (`0.0.0.0`), template schema validation fix.
- DeckLink `dlsym` fallback (EnableVideoOutput — открытый вопрос на железе).
- `createId()` fallback для LAN HTTP (без `crypto.randomUUID`).
- Layers panel: DnD, multi-select, вложенные группы.
- Unsaved changes modal при выходе из редактора.
- Mask stack-scoped fix (`maskScopes`, `maskGeometry`, SVG inverted mask).
- Resizable timeline, grid snap off by default.
- NumberInput: negative values, drag, R reset.

Подробности предыдущей сессии — в git history коммитов `1a2df0e`…`d396ede`.

---

## Операционные заметки

```bash
# Dev stack
./dev-start.sh
# Frontend :3011, Backend :3002

# После изменений runtime
cd runtime && npm run build

# Typecheck
cd frontend && npx tsc --noEmit

# Push ветки
git push -u origin sergey-v1
```

- После изменений `runtime/` — пересобрать `bg-runtime.js`.
- Hard refresh редактора: `Ctrl+Shift+R`.
- `TITULUS_DATA=/tmp/...` для тестов backend.

---

## Следующие шаги

1. Push `sergey-v1` → PR в `main` (merge commit).
2. Проверить axis center + group reparent на реальных шаблонах с вложенными группами и rotation.
3. DeckLink `EnableVideoOutput` — валидация на железе.
4. При необходимости — drag группы на canvas (сейчас только layers).

---

## Предпочтения пользователя

- Общение на русском.
- Ветка `sergey-v1`, коммиты по запросу.
- Короткие commit messages.
