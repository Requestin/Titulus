# Контекст сессии разработки — ветка `sergey-v1`

> Сводка диалога агента с пользователем (Sergey).  
> Дата: 30 июня 2026.  
> Transcript: `17aaf61c-d7ff-44fa-aef6-554b480c330a`

---

## Репозиторий и ветка

| Параметр | Значение |
|---|---|
| Workspace | `/home/ladmin/Documents/broadcast-graphics-vasia/Titulus` |
| Remote | `git@github.com:Requestin/Titulus.git` |
| Ветка | `sergey-v1` (tracking `origin/sergey-v1`) |
| База | `main` |

### Коммиты на ветке

| Hash | Сообщение |
|---|---|
| `1a2df0e` | `fix UI editor and mask` |
| `d31b1f1` | `new fix mask` |
| `d396ede` | `fix timeline, add mask, add editor feature` |

**Статус на конец сессии:** working tree clean, всё запушено в `origin/sergey-v1`.

---

## Хронология запросов и решений

### 1. Подключение проекта

- Клонирование через SSH (HTTPS не работал для private repo).
- Создана ветка `sergey-v1` от `main`.

### 2. Сборка engine / CEF

**Проблема:** `engine/third_party/fetch-cef.sh` был захардкожен на `/root/Titulus/...`.

**Решение:** путь к CEF определяется относительно расположения скрипта. CEF скачан, `bg_engine` собирается.

### 3. Запуск dev-окружения

**Скрипт:** `./dev-start.sh` (не ручной запуск из RUNBOOK по отдельности).

- Frontend: порт **3011**
- Backend: порт **3002**
- Для engine supervisor использовать backend на **3002**, не 3001.

**Проблема save template:** `template validation failed`.

**Причина:** в `shared/template.schema.json` у `layer` стояло `additionalProperties: false`, а type-specific поля (`content`, `style`, `fill` и т.д.) были только в `allOf/then` — AJV считал их лишними.

**Решение:** type-specific поля перенесены в основной `layer.properties`.

**Дополнительно:** иногда мешал «зависший» backend на порту 3002 после неудачного `dev-start` — нужен kill процесса на порту и перезапуск.

### 4. DeckLink SDI

**Настройки канала (пользователь):** DeckLink SDI, device 0, HD1080i50, external keyer.

**Запуск engine:**

```bash
BACKEND_URL=http://127.0.0.1:3002 \
TITULUS_API_USER=admin \
TITULUS_API_PASSWORD='admin123' \
./engine/run-engines.sh
```

#### Ошибка 1: `dlsym(CreateDeckLinkIteratorInstance) failed`

**Причина:** установленная `/usr/lib/libDeckLinkAPI.so` экспортирует версионированные символы `_0002/_0003/_0004`, а не старое имя.

**Решение:** в `engine/src/consumers/decklink_consumer.cpp` добавлен fallback по списку символов:

```
CreateDeckLinkIteratorInstance
CreateDeckLinkIteratorInstance_0004
CreateDeckLinkIteratorInstance_0003
CreateDeckLinkIteratorInstance_0002
```

#### Ошибка 2: `EnableVideoOutput failed`

**Статус:** не полностью решено. После фикса символов карта определяется как `DeckLink 8K Pro`, но драйвер не включает output mode. Требует настройки Blackmagic Desktop Video / профиля устройства / занятости выхода — вне scope кода.

### 5. Доступ к веб-интерфейсу с другого ПК (LAN)

**Изменения:**

- `dev-start.sh` — bind `0.0.0.0` по умолчанию (`TITULUS_HOST`), внутренние health/proxy через `127.0.0.1` (`TITULUS_CONNECT_HOST`).
- `frontend/vite.config.ts` — `allowedHosts: true` для доступа по IP.
- `docs/RUNBOOK.md` — заметки про LAN URL.

**Проблема:** на удалённом Chrome не создавались слои (клик по типу элемента — список не закрывается).

**Причина:** `crypto.randomUUID()` недоступен на non-secure HTTP (LAN по IP).

**Решение:** `frontend/src/core/id.ts` с `createId()` и fallback; замена прямых вызовов `crypto.randomUUID()` в editor/control.

### 6. Панель Layers — drag & drop, группы, multi-select

**Реализовано в** `frontend/src/editor/panels/LayersPanel.tsx`:

- Перетаскивание объектов в группы с подсветкой.
- Режим **Select** (кнопка с галочкой) — checkbox у каждого объекта, multi-select.
- Перетаскивание выделенного набора за 6 точек.
- Вложение группы в группу (исправлено «сбрасывание» при наведении).
- Drop indicator — полоска между строками (исправлен сдвиг «на строку выше»).
- Режимы зоны drop: левая часть — reorder по дереву; правая половина строки группы — вложение на верхний уровень группы.

### 7. Диалог несохранённых изменений

**Файл:** `frontend/src/pages/EditorPage.tsx`

При выходе из редактора с dirty state — модалка:

- Текст: `You have unsaved changes`
- Кнопки: **Save and exit** (красная), **Discard and exit**, **Cancel**
- Перехват внутренних ссылок + `beforeunload`

### 8. Маски (runtime)

**Файлы:** `runtime/src/maskScopes.ts`, `runtime/src/maskGeometry.ts`, `runtime/src/domRenderer.ts`

#### Исходные баги

1. Маска влияла на объекты **выше** в дереве — должна только на **ниже**.
2. Добавление маски сдвигало координаты других объектов.
3. Режим `inverted` не работал / давал артефакты.

#### Исправления

| Проблема | Решение |
|---|---|
| Неверный порядок affected siblings | `computeMaskScopes`: mask clips entries **before** mask in stack array (ниже в visible tree) |
| Сдвиг координат | Убран offset mask-origin в `domRenderer.ts`; clip host — полный размер контейнера |
| `inverted` + `polygon(evenodd)` | Треугольные артефакты слева — заменено на SVG `<mask>`: белый фон + чёрная дырка + `mask-mode: luminance` |
| `normal` | `clip-path` в px-координатах canvas |

**Важно:** после изменений runtime — `cd runtime && npm run build` → обновляется `backend/public/bg-runtime.js` (gitignored). Hard refresh редактора: `Ctrl+Shift+R`.

#### Grid snap

По умолчанию выключен: `frontend/src/editor/store.ts` → `gridSnap: false`.

### 9. Timeline UX

| Фича | Файл | Описание |
|---|---|---|
| Resizable timeline | `EditorPage.tsx` | Drag за верхний край, default 256px, min 160, max 520 |
| + Track menu | `TimelinePanel.tsx` | Меню открывается вниз (`top-9` вместо `bottom-9`) |
| Timeline rework | `TimelinePanel.tsx`, `store.ts`, `effectiveValues.ts` | Улучшения в коммите `d396ede` |

#### Как пользоваться таймлайном (кратко)

1. Выбрать layer/group на canvas или в Layers.
2. **+ Track** → выбрать анимируемое свойство (`x`, `y`, `opacity`, …).
3. Поставить keyframes в разных позициях playhead.
4. Directors задают duration/loop/offset.
5. Dope sheet vs Curve editor для редактирования кривых.

### 10. Числовые поля в Properties

**Файлы:** `frontend/src/components/ui/form.tsx`, `frontend/src/editor/panels/PropertiesPanel.tsx`, `runtime/src/domRenderer.ts`

**Реализовано (коммит `d396ede`):**

1. Отрицательные числа — `NumberInput` как text input с `inputMode="decimal"`.
2. Drag left/right на поле — изменение значения с шагом `step`.
3. Кнопка **R** — reset к `resetValue` (X/Y → 0).
4. Transform группы редактируется; child + group transforms комбинируются (`effectiveValues.ts` + runtime).
5. W/H убраны из UI transform для **group** (не влияют на группу).
6. `applyGroupState` в `domRenderer.ts` — теперь применяет `left/top/width/height` на group elements (раньше только CSS transform).

#### Открытый follow-up (запрошен, требует проверки)

Пользователь сообщил **после** коммита `d396ede`:

1. **Каждый числовой параметр на отдельной строке** — поля слишком узкие в 2-column grid; не видно значения.
2. **Drag должен сразу обновлять отображаемое значение** в input во время перетаскивания (сейчас может не обновляться до blur/другого клика).

В текущем коде `Section` уже использует `space-y-2` (по одному полю в строке), `NumberInput` вызывает `setDraft` в `onPointerMove` — возможно баг в синхронизации `useEffect` ↔ drag state или проблема в другой секции панели. **Нужна верификация в UI.**

---

## Ключевые изменённые файлы

| Область | Файлы |
|---|---|
| Schema / validation | `shared/template.schema.json` |
| Runtime masks | `runtime/src/maskScopes.ts`, `runtime/src/maskGeometry.ts`, `runtime/src/domRenderer.ts` |
| Editor UI | `EditorPage.tsx`, `LayersPanel.tsx`, `PropertiesPanel.tsx`, `TimelinePanel.tsx`, `CanvasArea.tsx`, `store.ts`, `effectiveValues.ts` |
| UI components | `frontend/src/components/ui/form.tsx` |
| IDs (LAN) | `frontend/src/core/id.ts` |
| Dev / LAN | `dev-start.sh`, `frontend/vite.config.ts`, `docs/RUNBOOK.md` |
| Engine | `engine/third_party/fetch-cef.sh`, `engine/src/consumers/decklink_consumer.cpp` |

---

## Операционные заметки

```bash
# Dev stack
./dev-start.sh
# Остановка
./dev-stop.sh

# После изменений runtime
cd runtime && npm run build

# Typecheck
cd runtime && npm run typecheck
cd frontend && npm run typecheck

# Engine rebuild
cd engine/build && cmake .. && cmake --build .

# Kill backend на порту (если завис)
PID=$(ss -ltnp | grep ':3002' | grep -oP 'pid=\K[0-9]+' | head -1)
kill "$PID"
```

- LAN URL показывается при `dev-start` (например `http://192.168.x.x:3011`).
- `TITULUS_DATA` для тестов лучше в `/tmp/...` (избегать SQLITE_IOERR в repo data dir).
- Node.js 20+.

---

## Следующие шаги (приоритет)

1. **UI:** верифицировать/доделать layout числовых полей (одна строка = один параметр) и live-update при drag.
2. **Mask:** проверить `inverted` в браузере после SVG mask fix.
3. **DeckLink:** `EnableVideoOutput failed` — Desktop Video profile, mode 1080i50, external keyer vs fill-only на DeckLink 8K Pro.
4. **Git workflow:** когда задача завершена — PR из `sergey-v1` в `main` по правилам проекта (merge commit, не squash).

---

## Предпочтения пользователя

- Общение на русском.
- Короткие commit messages (`fix UI editor and mask`, `new fix mask`).
- Работа в ветке `sergey-v1`, push в origin по запросу.
- Коммиты только по явной просьбе пользователя.
