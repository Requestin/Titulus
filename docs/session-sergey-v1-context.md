# Ветка `sergey-v1` — контекст и changelog

> Сводка работы Sergey + агент Cursor на ветке `sergey-v1`.  
> Обновлено: **6 июля 2026**.

---

## Репозиторий и ветка

| Параметр | Значение |
|---|---|
| Workspace | `/home/ladmin/Documents/broadcast-graphics-vasia/Titulus` |
| Remote | `git@github.com:Requestin/Titulus.git` |
| Ветка | `sergey-v1` (tracking `origin/sergey-v1`) |
| База | `main` |

### Коммиты на ветке (хронология)

| Hash | Дата | Сообщение |
|---|---|---|
| `1a2df0e` | 30 июн | `fix UI editor and mask` |
| `d31b1f1` | 30 июн | `new fix mask` |
| `d396ede` | 30 июн | `fix timeline, add mask, add editor feature` |
| `1b0eadb` | 1 июл | `add axis center, fix some bugs` |
| `7dfcdfe` | 3 июл | `add copy in tree, fix axis center, ui editor` |
| `98bdadf` | 3 июл | `fix db folder` |
| `0690c87` | 6 июл | `change md context` |
| `3dd193f` | 6 июл | `add media mam for video and images` |

---

## 6 июля 2026 — Media library (изображения и видео)

Медиа-библиотека для редактора темплейтов: выбор файлов с диска сервера без повторной конвертации, единые теги, автоимпорт через Refresh.

### Папки на диске

Медиа хранятся в подпапках uploads (регистр важен):

| Тип | Путь |
|-----|------|
| Изображения | `/var/lib/titulus/uploads/Image/` |
| Видео | `/var/lib/titulus/uploads/Video/` |

**Первичная настройка (обязательно, один раз):**

```bash
sudo mkdir -p /var/lib/titulus/uploads/Image /var/lib/titulus/uploads/Video
sudo chown -R $USER:$USER /var/lib/titulus
chmod -R u+rwX /var/lib/titulus/uploads
```

Без этих папек и прав на запись импорт, Refresh и транскод видео не работают.

### Backend

- Таблицы SQLite: `media_tags`, `media_assets`, `media_asset_tags` (общие теги для image и video).
- Сервис `backend/src/mediaLibrary.js`: import, refresh, delete, finalize-job.
- `backend/src/mediaProbe.js` — метаданные через ffprobe.
- REST `/api/media/*`: tags, list, lookup, import, refresh, PATCH, DELETE, finalize-job.
- Видео `.webm` в `Video/` — as-is; `.mp4`/`.mov` — VP9/WebM alpha (async); исходник удаляется после успешного транскода.
- **Refresh:** сканирует папку; неподдерживаемые изображения конвертируются в PNG; для видео создаётся placeholder `status=processing`, `locked=true` — повторный Refresh не дублирует конвертацию.

### Frontend (редактор)

- Кнопка **Choose file** вместо прямого upload в Properties (поле Source убрано).
- Модальное окно **3 столбца:** Tags | Files | Info.
- Теги: поиск, мультивыбор, **Unselect**, Add tag (создание/удаление с подтверждением).
- Files: поиск, OK / Cancel / Import / Refresh; hover — карандаш, замок, корзина.
- Import → редактирование имени и тегов; Info — метаданные + список тегов объекта.
- Под кнопкой выбора в Properties: имя файла и метаданные (каждое поле с новой строки).
- Видео при Refresh: в списке сразу `(converting)`, автообновление каждые 2 с до `ready`.

### Ключевые файлы (media)

| Область | Файлы |
|---------|-------|
| Backend library | `backend/src/mediaLibrary.js`, `mediaProbe.js`, `routes/media.js` |
| DB | `backend/src/db.js` (media_* tables, `status`, `source_relative_path`) |
| Transcode | `backend/src/media.js` (`ingestTo`, удаление исходника после job) |
| API client | `frontend/src/core/api.ts` |
| UI | `frontend/src/editor/media/MediaPickerModal.tsx`, `MediaSourcePicker.tsx`, `MediaFileInfo.tsx` |
| Properties | `frontend/src/editor/panels/PropertiesPanel.tsx` |

### Чеклист media

- [ ] Папки `Image/` и `Video/` созданы, права на запись
- [ ] Choose file → выбор из библиотеки, метаданные в Properties
- [ ] Import изображения/видео, теги, редактирование, lock, delete
- [ ] Положить файл в папку вручную → Refresh → появляется в списке
- [ ] MP4/MOV: один Refresh → converting → ready, исходник удалён, повторный Refresh не дублирует


Шаблоны, каналы, rundowns, settings, on-air, users и загруженные медиа **не в git** — в SQLite и uploads на диске.

| Компонент | Путь |
|-----------|------|
| SQLite (`app.db`) | `/var/lib/titulus/app.db` |
| Медиа (legacy) | `/var/lib/titulus/uploads/` |
| Изображения | `/var/lib/titulus/uploads/Image/` |
| Видео | `/var/lib/titulus/uploads/Video/` |

Переопределение: **`TITULUS_DATA`** (для тестов/CI).

**Проблема (до fix):** `dev-start.sh` использовал `/tmp/titulus-dev` — данные пропадали после reboot.

**Решение (коммит `98bdadf`):** единый default `/var/lib/titulus` в `backend/src/index.js`, `dev-start.sh`, `start.sh`.

### Первичная настройка (один раз)

```bash
sudo mkdir -p /var/lib/titulus/uploads/Image /var/lib/titulus/uploads/Video
sudo chown -R $USER:$USER /var/lib/titulus
chmod -R u+rwX /var/lib/titulus/uploads
./dev-stop.sh && ./dev-start.sh
```

В логе: `[titulus-backend] db: /var/lib/titulus/app.db`

### Миграция со старых путей

```bash
# из /tmp (если файл ещё есть)
cp /tmp/titulus-dev/app.db /var/lib/titulus/app.db
cp -r /tmp/titulus-dev/uploads/* /var/lib/titulus/uploads/ 2>/dev/null || true

# из <repo>/data/
cp data/app.db /var/lib/titulus/app.db
cp -r data/uploads/* /var/lib/titulus/uploads/ 2>/dev/null || true
```

---

## 30 июня 2026 — editor foundation

- Engine CEF path fix, dev-start LAN (`0.0.0.0`), template schema validation fix.
- DeckLink `dlsym` fallback (EnableVideoOutput — открытый вопрос на железе).
- `createId()` fallback для LAN HTTP (без `crypto.randomUUID`).
- Layers panel: DnD, multi-select, вложенные группы.
- Unsaved changes modal при выходе из редактора.
- Mask stack-scoped fix (`maskScopes`, `maskGeometry`, SVG inverted mask).
- Resizable timeline, grid snap off by default.
- NumberInput: negative values, drag, R reset.

---

## 1 июля 2026 — axis center, groups, UI polish

### Axis center (pivot)

`transform.anchorX` / `anchorY` (0…1); в UI — пиксели от bbox.

- Подраздел **Axis center** в Properties (X, Y), пресеты L/C/R и B/C/T.
- Crosshair на canvas при выделении.
- Модули: `frontend/src/editor/pivot.ts`, `groupBounds.ts`.
- Для **слоёв**: компенсация через `anchorCompensatedUpdate()` — визуальная позиция не прыгает.

### Rotation

Подраздел **Rotation**: X → `rotationX`, Y → `rotationY`, Z → `rotation`; кнопки ±45°; **Perspective** внутри Rotation.

### Timeline

Отображаемые имена: `rotation` → `rotationZ` (`TimelinePanel.tsx`).

### NumberInput

Stepper ↑↓, `extraActions` для rotation.

### Группы — width/height = 0

Размеры группы не в transform; selection box по union детей (`groupCanvasAabb`).

### Save indicator

Жёлтый dot на кнопке Save при `dirty` (`Toolbar.tsx`).

### Прочее

- Fix чёрной страницы редактора (восстановлены импорты в `PropertiesPanel.tsx`).
- **Director** — отдельная анимационная под-последовательность; keyframes через `trackDirectors`.

---

## 2–3 июля 2026 — copy in tree, axis center groups, reparent, UI

### Copy в дереве слоёв

- **Ctrl/Cmd + drag** — deep clone слоя/группы с поддеревом.
- Новые `id`, timeline (`trackDirectors`, keyframes), зелёная подсказка drop.

### Delete в дереве

- Trash на строке (hover); `store.deleteEntry()` с purge поддерева и timeline.
- Delete убран из Toolbar.

### Axis center — группы

**Смена anchor:** только `anchorX`/`anchorY` — дети на месте, двигается crosshair.

**Вращение:** `runtime/src/groupBounds.ts` — bbox детей → `transform-origin`; `applyGroupTransform` в `domRenderer`; editor overlay синхронизирован.

### Reparent в/из группы — без компенсации координат

- Вложение в группу: `x/y` **не меняются** — transform группы применяется через иерархию.
- Вытаскивание на root/выше: `x/y` **не меняются**; убраны `captureGlobalPivots` / `unparentEntriesToCanvas` при reparent.

> Ранее (1 июля) была компенсация через `inverseMapPointThroughTransform` для сохранения canvas-позиции — **отменена** 3 июля.

### UI Properties

**Transform** → **Size** (W/H layer, Scale) + **Position** (X/Y, Rotation, Axis center).

### Canvas overlay

`layerCanvasAabb`, mask projection через group chain, `groupPivotCanvasPoint` (timeline-aware).

### Новые слои

`createEditorTransform()` — anchor top-left `(0,0)`, position `(0,0)`.

### Runtime refactor

`computeGroupBbox` / `computeGroupUnion` в `@runtime`; editor реэкспортирует.

---

## Ключевые файлы

| Область | Файлы |
|---|---|
| Data path | `backend/src/index.js`, `dev-start.sh`, `start.sh` |
| Axis center / groups | `frontend/src/editor/groupBounds.ts`, `pivot.ts` |
| Group bbox (runtime) | `runtime/src/groupBounds.ts`, `domRenderer.ts` |
| Layers tree | `frontend/src/editor/panels/LayersPanel.tsx` |
| Properties | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Media library | `frontend/src/editor/media/*`, `backend/src/mediaLibrary.js` |
| Canvas | `frontend/src/editor/CanvasArea.tsx` |
| Store | `frontend/src/editor/store.ts` |
| Factories | `frontend/src/editor/factories.ts` |
| Timeline | `frontend/src/editor/panels/TimelinePanel.tsx` |
| UI forms | `frontend/src/components/ui/form.tsx` |

---

## Операционные заметки

```bash
./dev-start.sh          # FE :3011, BE :3002, data: /var/lib/titulus
cd runtime && npm run build   # после изменений runtime
cd frontend && npx tsc --noEmit
git push -u origin sergey-v1
```

- Hard refresh редактора: `Ctrl+Shift+R`.
- Тесты backend: `TITULUS_DATA=/tmp/... node src/index.js`.

---

## Чеклист проверки

**Editor:**
- [ ] Ctrl/Cmd+drag копирует слой/группу в дереве
- [ ] Delete на строке дерева удаляет элемент
- [ ] Axis center группы — crosshair двигается, дети на месте
- [ ] Rotation группы — вокруг выбранного axis center
- [ ] Drag в/из группы — координаты в Properties не пересчитываются

**Data:**
- [ ] `ls -la /var/lib/titulus/` — `app.db`, `uploads/`
- [ ] Шаблон + канал переживают reboot

---

## Следующие шаги

1. PR `sergey-v1` → `main` (merge commit), включая media library.
2. Проверить axis center + groups на шаблонах с вложенностью и rotation.
3. DeckLink `EnableVideoOutput` — валидация на железе.
4. Drag группы на canvas (сейчас только layers).

---

## Предпочтения

- Общение на русском.
- Ветка `sergey-v1`, коммиты по запросу.
- Короткие commit messages.
