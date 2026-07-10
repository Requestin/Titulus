# Ветка `sergey-v1` — контекст и changelog

> Сводка работы Sergey + агент Cursor на ветке `sergey-v1`.  
> Обновлено: **10 июля 2026**.

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
| `2613074` | 9 июл | `docs(sergey-v1): fix commit hash in session context` |
| `ec8e872` | 9 июл | `fix scale bug` |
| `42a18bc` | 10 июл | `fix group at tree, lock for scale` |
| `c209386` | 10 июл | `docs(sergey-v1): fix commit hash in session context` |
| `d6d2c76` | 10 июл | `move tab templates from control` |
| `2701e68` | 10 июл | `docs(sergey-v1): fix commit hash in session context` |
| `a922d93` | 10 июл | `big change Control page, add dataelements, change db` |

---

## 10 июля 2026 (вечер) — Control: channel-scoped rundowns + DataElements

Крупный рефакторинг Control: rundowns привязаны к каналу из шапки; сайдбар Rundowns/Templates/DataElements; DnD в слоты; отдельная SQLite для DataElements; панель Variables; NOT FOUND.

### Channel → rundowns

- Верхний Select канала — **источник правды**: `GET /api/rundowns?channelId=` загружает только rundowns этого канала.
- Создание rundown всегда с `channel_id` = выбранный канал.
- Убран Select канала из transport bar (PREV/TAKE/NEXT).
- Убрана кнопка **Add slot** — слоты добавляются только DnD из Templates / DataElements.
- **Last rundown per channel:** `localStorage` `titulus.control.lastRundown.<channelId>`.
- **Fix:** убрано auto-create `Rundown 1` при открытии пустого канала (создавало дубликаты); create только по кнопке **+**. Очищены пустые rundowns в `/var/lib/titulus/app.db` (43 пустых удалены).

### Sidebar mode dropdown

Заголовок «Rundowns» → Select: **Rundowns** | **Templates** | **DataElements** (default Rundowns).

| Mode | Поведение |
|---|---|
| Rundowns | Список канала: CRUD, reorder DnD, import/export |
| Templates | Все templates A–Z, строки без trash/pencil; click → Variables; DnD → slots |
| DataElements | Все DE; default sort `updated_at` desc; колонки Name \| Updated; click Name → sort by name; DnD → slots |

Active rundown сохраняется при смене mode (нужен как DnD target).

### Slots + DnD

- Drop Template → `{ slotId, templateId, name, vars: defaults, dataElementId?: absent }`
- Drop DataElement → `{ slotId, templateId, name: de.name, vars: clone(de.vars), dataElementId }`
- Источник списка **не** удаляется.
- Отображаемое имя: актуальное имя template из API (не устаревший `slot.name`).
- Битая ссылка (нет template или нет DE при `dataElementId`) → красный **NOT FOUND IN DB**; TAKE disabled; CLEAR если on-air — можно.

### Variables panel (справа под Preview / On air)

| Selection | Кнопки |
|---|---|
| Template | **Save as DataElement** (danger), Cancel |
| DataElement | Save as new, Save, Cancel |
| Slot | Save as new (всегда), Save (disabled until dirty), Cancel |

Modal «Enter name for DataElement» → POST. Save на slot обновляет `slot.vars` в rundown (+ live UPDATE если on-air). Save as new с slot **не** меняет слот.

### DataElements DB (отдельный файл)

- Путь: **`$TITULUS_DATA/app.db-dataelements`** (рядом с `app.db`, default `/var/lib/titulus/`).
- Модуль: [`backend/src/dataElementsDb.js`](backend/src/dataElementsDb.js)
- Таблица `data_elements`: `id`, `template_id`, `name`, `vars` (JSON), `created_at`, `updated_at`, `created_by`, `updated_by`
- REST `/api/data-elements` (`?sort=updated|name`): list/get/create/update/delete; auth required; username из `req.auth`
- Cascade: DELETE template → `removeByTemplateId`
- Slot normalize в `db.js` сохраняет optional `dataElementId`

### Ключевые файлы (Control + DataElements)

| Область | Файлы |
|---|---|
| Control page | `frontend/src/pages/ControlPage.tsx` |
| Rundown UI | `frontend/src/control/RundownTab.tsx` |
| Variables panel | `frontend/src/control/ControlVariablesPanel.tsx` |
| API client | `frontend/src/core/api.ts` (`DataElement`, `dataElements.*`, `rundowns.list({channelId})`) |
| DataElements DB | `backend/src/dataElementsDb.js`, `backend/src/routes/dataElements.js` |
| Wire-up | `backend/src/index.js` |
| Rundowns filter / slots | `backend/src/db.js`, `backend/src/routes/rundowns.js` |
| Template cascade | `backend/src/routes/templates.js` |

### Чеклист (Control DataElements)

- [ ] Смена канала → только его rundowns; create → привязан к каналу
- [ ] Нет auto-create при открытии пустого канала; + создаёт вручную
- [ ] Templates / DataElements DnD в slots; источник остаётся
- [ ] Variables: Save as DataElement / Save / Save as new / Cancel
- [ ] NOT FOUND IN DB при удалённом template/DE; TAKE нельзя, CLEAR можно
- [ ] Имя слота = актуальное имя template после rename
- [ ] Файл `/var/lib/titulus/app.db-dataelements` появляется после первого API-вызова

---

Перенос операторского playout шаблонов из **Control** в раздел **Templates**; Control остаётся только для rundowns.

### Templates — переключатель EDITOR | PLAY

- По центру страницы `/templates` (над контентом) — сегментированный переключатель **EDITOR** | **PLAY** (`role="tablist"`).
- По умолчанию выбран **EDITOR** — прежняя библиотека шаблонов (карточки, New template, duplicate, delete modal).
- **PLAY** — бывшая вкладка Control → **Templates** (без Rundowns):
  - шапка: выбор канала, статус WS (`WsBadge`), Browser Source URL + Copy, **Clear all**;
  - слева: список шаблонов + панель переменных + TAKE / UPDATE / CLEAR;
  - справа: Program Monitor + On air.
- WS `/ws/control` подключается при входе в режим PLAY (`useControlWs`).

### Control — только Rundowns

- Вкладки **Templates | Rundowns** и полоска выбора вкладок **убраны**.
- `/control` сразу открывает **RundownTab** (активный rundown, slots, transport PREV/TAKE/NEXT).
- Шапка Control: канал (fallback), WS status, Browser Source URL — monitor привязан к каналу активного rundown.
- **Clear all** убран из Control (остался в Templates → PLAY).

### Рефакторинг модулей

| Модуль | Назначение |
|---|---|
| `frontend/src/control/TemplatesTab.tsx` | Список шаблонов + prep panel + TAKE/UPDATE/CLEAR (вынесено из `ControlPage`) |
| `frontend/src/control/controlShared.tsx` | `WsBadge`, `BrowserSourceUrl`, `copyTextToClipboard`, `normalizeRundown`, `displayOnAirName` |
| `frontend/src/pages/TemplatesPage.tsx` | `ModeToggle` + `EditorLibrary` + `PlayTemplates` |
| `frontend/src/pages/ControlPage.tsx` | Только rundowns + monitor/on-air |

### Ключевые файлы (Templates PLAY)

| Область | Файлы |
|---|---|
| Templates hub | `frontend/src/pages/TemplatesPage.tsx` |
| Play templates UI | `frontend/src/control/TemplatesTab.tsx` |
| Shared control chrome | `frontend/src/control/controlShared.tsx` |
| Control rundowns | `frontend/src/pages/ControlPage.tsx`, `frontend/src/control/RundownTab.tsx` |

### Чеклист (Templates PLAY / Control)

**Templates → EDITOR:**
- [ ] По умолчанию EDITOR; карточки, New template, duplicate, delete — как раньше

**Templates → PLAY:**
- [ ] Переключение на PLAY → канал, WS status, URL + Copy, Clear all
- [ ] Выбор шаблона → переменные → TAKE/UPDATE/CLEAR
- [ ] Program Monitor и On air справа
- [ ] Rundowns **нет** на этой странице

**Control:**
- [ ] Нет вкладок Templates/Rundowns — сразу rundown workflow
- [ ] Rundown transport, slots, monitor — как раньше на вкладке Rundowns
- [ ] Шаблоны на эфир — через **Templates → PLAY**, не через Control

---

Пакет правок редактора: DnD в дереве слоёв (вложенные группы, drop-линии), связка Scale X/Y, шире поля Properties, рекурсивный bbox вложенных групп.

### Layers tree — неограниченная вложенность групп

- Группу можно вкладывать в группу **без ограничения глубины** (DnD вправо на строку группы ≈62% ширины → `inside`).
- `parentId` / `groupStacks` обновляются при переносе; защита от циклов (`wouldCreateCycle`).
- **Runtime:** `computeGroupUnion` в `runtime/src/groupBounds.ts` — рекурсивный учёт bbox вложенных групп (раньше дочерняя группа с `width/height=0` не попадала в union родителя).

### Layers tree — drop-линии above/below групп (развёрнутые)

**Симптомы (до fix):**
- Нельзя вытащить объект **выше** первой группы в root, если группа развёрнута — не появлялась полоса drop.
- Нельзя положить объект **ниже** последней группы в root при развёрнутой группе (работало только при collapse).

**Fix (`LayersPanel.tsx`):**
- `ContainerDropPad` + `useDroppable` в начале/конце каждого контейнера (`container:root:start|end`, `container:<groupId>:start|end`).
- `moveEntriesToContainerEdge()` — вставка в начало/конец стека контейнера.
- Коллизии: `pointerWithin` с приоритетом container-падов, иначе `closestCenter`.
- Линия `after` перенесена **под** развёрнутых детей (не между заголовком группы и children).
- `DropLine` after: `bottom-0` вместо `top-8`.
- Зона «внутрь группы»: порог `inside` с 55% → 38% ширины строки (проще попасть в nest, левее — before/after).

### Properties — Scale X/Y lock (chain icon)

- Иконка **Link2 / Unlink** (цепочка) между подписями Scale X и Scale Y, слева на линии текста.
- По умолчанию **locked** — изменение одной оси синхронизирует вторую.
- Сетка `grid-rows-[2rem_3px_2rem]`, `gap-x-2` — выравнивание подписей и полей как у Height; зазор между строками Scale минимальный.

### Properties — шире поля значений (+20px влево)

- Новый компонент `PropertyField` в `form.tsx`: `grid-cols-[68px_minmax(0,1fr)]`, wrapper `-ml-5 w-[calc(100%+20px)]`.
- Все редактируемые поля в Properties переведены с `Field` на `PropertyField`.

### Ключевые файлы (10 июля)

| Область | Файлы |
|---|---|
| Layers DnD | `frontend/src/editor/panels/LayersPanel.tsx` |
| Scale lock + PropertyField | `frontend/src/editor/panels/PropertiesPanel.tsx`, `frontend/src/components/ui/form.tsx` |
| Nested group bbox | `runtime/src/groupBounds.ts` |

### Чеклист (10 июля)

**Layers tree:**
- [ ] Группа в группу на любой глубине — DnD вправо на строку группы
- [ ] Вытащить слой **над** первой развёрнутой группой в root — синяя drop-линия вверху
- [ ] Положить слой **под** последнюю развёрнутую группу в root — линия внизу списка
- [ ] Ctrl/Cmd+drag copy по-прежнему работает

**Properties:**
- [ ] Link2 между Scale X/Y; locked по умолчанию
- [ ] Поля Scale той же ширины, что Height/Width
- [ ] Остальные поля Properties на ~20px шире (влево)

**Runtime (после `npm run build`):**
- [ ] Вложенная группа участвует в bbox родителя (selection/crosshair)

---

## 9 июля 2026 (вечер) — Scale на SDI + Size presets

Коммит `ec8e872` — scale работал в редакторе, но не на SDI/engine.

### Bugfix: Scale не применялся на SDI

**Причина:** `transformHas3D()` считал default `perspective: 1000` за 3D → `preserve-3d` на каждом слое → CSS `scale()` ломался в CEF CPU raster (в браузере/GPU выглядело нормально).

**Fix:**
- `runtime/src/transform.ts` — 3D только при `rotationX/Y ≠ 0`.
- `runtime/src/domRenderer.ts` — perspective на группах только при реальном tilt/subtree 3D.
- `runtime/src/maskGeometry.ts` — `maskNeedsProjection` учитывает non-1 scale.

### Properties — Size presets + первый Scale lock

- Кнопки **Screen / Height / Width** (canvas 1920×1080) в секции Size для слоёв.
- Первая версия **Scale X/Y lock** (Lock icon, до редизайна Link2 10 июля).

### Ключевые файлы (scale bug)

| Область | Файлы |
|---|---|
| 3D/scale runtime | `runtime/src/transform.ts`, `domRenderer.ts`, `maskGeometry.ts` |
| Size UI | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Docs | `docs/phase9-25d-masks.md` |

### Чеклист (scale bug)

- [ ] Scale X/Y в редакторе = на channel.html / engine (SDI path)
- [ ] Screen → width+height = canvas; Height/Width — по одной оси
- [ ] После `cd runtime && npm run build` — `bg-runtime.js` обновлён

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
| Layers tree / DnD | `frontend/src/editor/panels/LayersPanel.tsx` |
| Properties / Scale | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| UI forms | `frontend/src/components/ui/form.tsx` (`PropertyField`) |
| Group bbox (runtime) | `runtime/src/groupBounds.ts`, `domRenderer.ts`, `transform.ts` |
| Media library | `frontend/src/editor/media/*`, `backend/src/mediaLibrary.js` |
| Canvas | `frontend/src/editor/CanvasArea.tsx` |
| Store | `frontend/src/editor/store.ts` |
| Factories | `frontend/src/editor/factories.ts` |
| Timeline | `frontend/src/editor/panels/TimelinePanel.tsx`, `timelineTracks.ts` |
| Timeline runtime | `runtime/src/timeline.ts`, `shared/template.schema.json` |
| UI forms | `frontend/src/components/ui/form.tsx` |
| Control / Rundowns | `frontend/src/control/RundownTab.tsx`, `frontend/src/pages/ControlPage.tsx` |
| Control Variables | `frontend/src/control/ControlVariablesPanel.tsx` |
| DataElements | `backend/src/dataElementsDb.js`, `backend/src/routes/dataElements.js` |
| Templates EDITOR + PLAY | `frontend/src/pages/TemplatesPage.tsx`, `frontend/src/control/TemplatesTab.tsx` |
| Control shared UI | `frontend/src/control/controlShared.tsx` |
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

**Templates / Control:**
- [ ] `/templates` — EDITOR по умолчанию; PLAY = бывший Control Templates (TAKE/UPDATE/CLEAR)
- [ ] `/control` — channel-scoped rundowns; sidebar Rundowns/Templates/DataElements; Variables; no auto-create rundown
- [ ] DataElements в `$TITULUS_DATA/app.db-dataelements`; cascade при delete template

**Editor:**
- [ ] Ctrl/Cmd+drag копирует слой/группу в дереве
- [ ] Группа в группу; drop выше первой / ниже последней развёрнутой группы
- [ ] Scale lock (Link2); поля Properties шире на 20px
- [ ] Scale на engine/SDI совпадает с редактором (`ec8e872`)
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
