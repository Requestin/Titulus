# Ветка `sergey-v1` — контекст и changelog

> Сводка работы Sergey + агент Cursor на ветке `sergey-v1`.  
> Обновлено: **9 июля 2026**.

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
| `426fc10` | 7 июл | `change timeline,directors` |
| `2eb7940` | 7 июл | `fix bugs at timeline` |
| `71390b0` | 7 июл | `fix bugs at timeline(change runtime)` |
| `d2e3562` | 7 июл | `docs(sergey-v1): fix commit hash in session context` |
| `512cbd0` | 9 июл | `fix ui` |

---

## 9 июля 2026 — Control, Templates, Editor UI fixes

Пакет правок по операторскому UI (Control/Rundowns), шаблонам, медиа-библиотеке и редактору.

### Control — Rundowns: drag-and-drop reorder

- Список **rundown** и список **slots** внутри rundown: перетаскивание через grip (6 точек, `GripVertical`) слева от текста — по аналогии с деревом слоёв в редакторе (`@dnd-kit`).
- Кнопки-стрелки ↑↓ для сортировки **убраны** (и у rundown, и у slots).
- Порядок rundown сохраняется через `api.rundowns.reorder`; порядок slots — autosave rundown.

### Control — TAKE не двигает курсор

- После TAKE (кнопка transport, TAKE на слоте, Space) **фокус остаётся** на текущей строке — не переходит на следующую.
- PREV/NEXT по-прежнему меняют `focusIdx` и берут выбранный слот.

### Control — копирование Browser Source URL

- Кнопка Copy рядом с URL рендера в шапке Control: `navigator.clipboard` + fallback `document.execCommand('copy')`.
- При успехе: toast **«Copied»**, иконка галочки на 1.5 с.

### Control — кнопка Update (справка)

- **Update** обновляет переменные **уже эфирного** шаблона без повторного TAKE (без перезапуска in-анимации).
- WS: `{ type: 'update', channelId, templateId, variables }`.
- Активна только если шаблон в `live`; при правке полей в панели — debounce ~400 ms и update уходит сам.

### App shell — убран «Open renderer»

- Ссылка **Open renderer** (`/renderer`) удалена из левого меню — для OBS/vMix используются per-channel URL (`/channel.html?channel=<id>`) из Control.

### Templates — подтверждение удаления in-app

- Вместо `window.confirm` — модальный диалог в стиле приложения.
- Текст: `Delete "<name>"? This cannot be undone.`
- Кнопки: **Delete** (красная, `variant="danger"`) и **Cancel**.

### Media picker — обновление списка тегов

- После **Add tag** в `TagManagerModal` или в `AssetEditModal` список тегов в окне выбора файла и панель Info обновляются **сразу** при возврате (без перезахода и без поиска).
- `AssetEditModal`: `onTagsChanged`, `refreshTags()` при закрытии tag manager; Info показывает выбранные теги до сохранения (`previewAsset`).

### Editor — clock layer: start/target time

- В Properties для слоя **clock**:
  - `countup` → поле **Start time** (`datetime-local` → `startTime` epoch ms).
  - `countdown` → поле **Target time** (`datetime-local` → `targetTime` epoch ms).

### Editor — Variables panel UX

- Переработан layout строки переменной: stacked labels, редактируемый **ID** (карандаш → inline input).
- Подсказки через `title` на label.

### Ключевые файлы (9 июля)

| Область | Файлы |
|---|---|
| Rundown DnD + TAKE | `frontend/src/control/RundownTab.tsx` |
| Copy URL | `frontend/src/pages/ControlPage.tsx` |
| Delete confirm | `frontend/src/pages/TemplatesPage.tsx` |
| Open renderer removed | `frontend/src/components/AppShell.tsx` |
| Media tags refresh | `frontend/src/editor/media/MediaPickerModal.tsx` |
| Clock start/target | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Variables UX | `frontend/src/editor/panels/VariablesPanel.tsx` |

### Чеклист (9 июля)

**Control / Rundowns:**
- [ ] Grip слева — drag rundown и slots; стрелок нет
- [ ] TAKE не сдвигает выделение на следующую строку
- [ ] Copy URL → toast «Copied», вставка в буфер работает
- [ ] Update на Templates tab меняет переменные у live-шаблона

**Templates:**
- [ ] Корзина → in-app диалог Delete/Cancel, не browser confirm

**Media picker:**
- [ ] Add tag в edit asset → тег сразу в списке слева и в Info

**Editor:**
- [ ] Clock countup/countdown — datetime-local в Properties
- [ ] Variables — редактирование ID, новый layout

---

## 7 июля 2026 — Runtime: per-property tracks в одном director

### Bugfix: opacity + X в одном director — анимация за 1 кадр

**Симптом:** у одного слоя треки `opacity` и `x` в **одном** director — один из них анимируется за 1 кадр вместо 100; в **разных** director'ах всё работает.

**Причина:** `normalizeTimeline` компилировал все свойства слоя в **один** список keyframe'ов по кадрам. Keyframe только с `x` на кадре 50 «ломал» интервал для `opacity` (0→50 вместо 0→100), или давал скачок за 1 кадр между соседними точками общего списка.

**Fix (`runtime/src/timeline.ts`):** у каждого `(target, prop)` свой независимый `CompiledTrackEntry[]`; `samplePropTrack` интерполирует только между keyframe'ами **этого** свойства. `pushPropEntry` при compile вместо merge bag'ов на target.

После изменения: `cd runtime && npm run build` + hard refresh редактора.

### Чеклист

- [ ] Opacity 0→1 и X за 100 кадров на одном слое в **одном** director — оба трека за полную длительность
- [ ] Разные keyframe-кадры у opacity и x (напр. x только 0/100, opacity 0/50/100) — каждый трек интерполируется по своим точкам

---

## 7 июля 2026 (продолжение) — Timeline bugs: global playhead, multi-director preview

Исправления после timeline v2: воспроизведение, глобальный playhead, preview при редактировании нескольких директоров.

### Global playhead

- Строка **Global** вверху dope sheet: белая подпись и белая линия playhead (директорские — красные `bg-live`).
- Scrub global ruler → `setGlobalPlayhead(frame)` — все директоры на тот же локальный кадр (clamp по `durationFrames`).
- **SkipBack** и счётчик transport (`текст белее`) используют global playhead.
- Store: `setGlobalPlayhead`, `deriveGlobalPlayhead` в UI.

### Bugfix: первый кадр при Play «из середины»

- **Причина:** `directorRel` мог расходиться с `playheads`; первый rAF сразу сдвигал время.
- **Fix:** `setPlaying(true)` синхронизирует `directorRel` ← `playheads`; playback loop делает seek на стартовых позициях, первый rAF без advance (baseline).

### Bugfix: второй объект исчезает при drag/edit (2 директора)

- **Причина:** `syncTemplate` после patch всегда вызывал `applyState(globalFrame=0)`, игнорируя per-director playhead'ы; async font reload повторял сброс.
- **Fix runtime:** `applyCurrentState()` — если заданы `directorLocalFrames`, использует `applyStateFromLocals` (в `syncTemplate` и font callback).
- **Fix store:** `syncAnimatedPropsAtPlayhead` пишет keyframes по **director'у трека** и его playhead, не только `activeDirectorId`.
- **PropertiesPanel:** `effectiveTransform` / `effectiveOpacity` со **всеми** playhead'ами (не `effectiveTransformForDirector`).
- **CanvasArea:** drag от effective-позиции; после commit — `seekDirectorLocals`; select слоя → `primaryDirectorForTarget`.

### Ключевые файлы (timeline bugfixes)

| Область | Файлы |
|---------|-------|
| Global playhead UI | `TimelinePanel.tsx`, `store.ts` |
| Multi-director preview | `runtime/src/domRenderer.ts`, `CanvasArea.tsx` |
| Keyframe sync | `store.ts` (`syncAnimatedPropsAtPlayhead`) |
| Properties | `PropertiesPanel.tsx` |
| Helpers | `timelineTracks.ts` (`primaryDirectorForTarget`) |

### Чеклист bugfixes

- [ ] Global scrub → все director playhead'ы синхронны; SkipBack → 0 везде
- [ ] Play с кадра 0 — первый кадр = keyframe на 0, без «прыжка из середины»
- [ ] 2 объекта в разных директорах, global playhead — оба видны; drag/edit одного — второй не исчезает
- [ ] Properties X/Y drag при multi-director — canvas не сбрасывается

---

## 7 июля 2026 — Timeline v2: directors tree, dope sheet, multi-playhead

Крупный рефакторинг панели таймлайна: директора как дерево папок, неограниченное число треков на директора, независимые playhead'ы, drag-and-drop треков и сегментов анимации.

### Модель данных

| Поле | Назначение |
|------|------------|
| `timeline.trackDirectors` | Ключ трека `layer:<id>:<prop>` / `group:<id>:<prop>` → `directorId` |
| `timeline.trackOrder` | Порядок треков внутри каждого директора (`Record<directorId, trackKey[]>`) |
| `timeline.directors[]` | Независимые под-последовательности: `durationFrames`, `loop`, `swing` |

- Схема: `shared/template.schema.json` — добавлен optional `trackOrder` (fix validation при Save).
- Runtime: `timelineTrackKey`, `resolveTrackDirector`, `sampleAtDirectorLocals`, `seekDirectorLocals` — превью с учётом swing и локальных playhead'ов директоров.
- `domRenderer.ts` — сэмплинг анимации через director-local координаты.

### UI таймлайна (`TimelinePanel.tsx`)

- **Дерево директоров:** collapse/expand, иконка папки, удаление на hover; ruler и playhead **на каждый директор**.
- **Dope sheet:** треки вложены под директором; клик по треку — только выбор (без создания keyframe по клику на lane).
- **+D** — новый директор внизу; **+Track** — меню свойств (portal, fixed z-index); **+K / −K** — add/delete keyframe у выбранного трека.
- **DnD треков** (dnd-kit): reorder внутри директора, перенос между директорами, drop-line before/after, `DragOverlay` с подписью.
- **Drag сегментов** — горизонтальные линии между keyframe с разными значениями; двигает связанную группу keyframe с сохранением интервалов.
- **Transport:** `SkipBack` (все playhead → 0) слева от Play; Stop только останавливает playback.
- **Views:** Dope sheet | Curve (один активный трек).
- **Горизонтальный скролл:** sticky-колонка названий `z-[30]`, непрозрачный `bg-surface`, тень — кейфреймы и линии не просвечивают под заголовками.

### Store (`store.ts`)

- Transient: `playheads`, `directorRel`, `activeDirectorId`, `playing`.
- `addDirector` / `removeDirector`, `moveTrackToDirector`, `reorderTracks`, `moveKeyframeSegment`.
- При добавлении трека без директоров — auto `default` director.
- При duplicate слоя в дереве — копирование per-prop `trackDirectors` (`LayersPanel.tsx`).

### Preview

- `CanvasArea.tsx` + `effectiveValues.ts` — multi-director preview, swing через `directorRelToLocal`, scrub/playhead по активному директору.
- `PropertiesPanel.tsx` — привязка к активному director/track.

### Ключевые файлы (timeline v2)

| Область | Файлы |
|---------|-------|
| UI | `frontend/src/editor/panels/TimelinePanel.tsx` |
| Helpers | `frontend/src/editor/timelineTracks.ts` (новый) |
| Store | `frontend/src/editor/store.ts` |
| Preview | `frontend/src/editor/CanvasArea.tsx`, `effectiveValues.ts` |
| Runtime | `runtime/src/timeline.ts`, `schema.ts`, `domRenderer.ts` |
| Schema | `shared/template.schema.json` |

### Чеклист timeline v2

- [ ] +D → директор, +Track → свойство слоя/группы, трек появляется под директором
- [ ] Drag трека между директорами и reorder внутри
- [ ] +K / −K на выбранном треке; drag keyframe и сегмента между keyframe
- [ ] Play / swing / loop per director; SkipBack сбрасывает все playhead'ы
- [ ] Save шаблона с двумя директорами и перенесённым треком — без validation error
- [ ] Горизонтальный скролл — названия треков поверх линий и ромбов keyframe

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
| Timeline | `frontend/src/editor/panels/TimelinePanel.tsx`, `timelineTracks.ts` |
| Timeline runtime | `runtime/src/timeline.ts`, `shared/template.schema.json` |
| UI forms | `frontend/src/components/ui/form.tsx` |
| Control / Rundowns | `frontend/src/control/RundownTab.tsx`, `frontend/src/pages/ControlPage.tsx` |
| Templates list | `frontend/src/pages/TemplatesPage.tsx` |
| App shell | `frontend/src/components/AppShell.tsx` |
| Variables | `frontend/src/editor/panels/VariablesPanel.tsx` |

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

1. PR `sergey-v1` → `main` (merge commit): media library + timeline v2 + timeline bugfixes.
2. Ручная проверка timeline (чеклисты v2 + bugfixes выше).
3. Проверить axis center + groups на шаблонах с вложенностью и rotation.
4. DeckLink `EnableVideoOutput` — валидация на железе.
5. Drag группы на canvas (сейчас только layers).

---

## Предпочтения

- Общение на русском.
- Ветка `sergey-v1`, коммиты по запросу.
- Короткие commit messages.
