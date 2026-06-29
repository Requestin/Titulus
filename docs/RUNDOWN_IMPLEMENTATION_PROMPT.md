# Промпт: реализация механизма Rundown с нуля

Документ описывает полную спецификацию механизма **Rundown** (пошаговый эфирный сценарий) для системы broadcast-graphics. Предполагается, что механизма ещё нет — его нужно реализовать **точно** по этой спецификации.

---

## 1. Назначение и концепция

**Rundown** — это упорядоченный список **слотов**, каждый из которых ссылается на графический **шаблон** (template) и хранит собственные значения **переменных**. Оператор ведёт эфир пошагово: выбирает слот, нажимает TAKE, графика уходит в выход; затем переходит к следующему слоту.

Ключевое архитектурное решение: **слот имеет собственный `slotId`**, отличный от `templateId` шаблона. При команде TAKE в WebSocket уходит `templateId = slotId`, а не ID шаблона. Это позволяет:

- держать в эфире **один и тот же шаблон несколько раз** (в разных слотах или рандаунах);
- не конфликтовать с вкладкой **Templates**, где `templateId` совпадает с ID шаблона;
- независимо управлять переменными каждого слота.

Rundown — это **не** отдельный рендерер и **не** отдельный WebSocket-протокол. Это слой данных + UI поверх существующей инфраструктуры:

- REST API + SQLite для персистентности;
- WebSocket `/ws/control` для команд `take` / `clear` / `update`;
- существующая система шаблонов и каналов DeckLink.

---

## 2. Модель данных

### 2.1. RundownSlot

```ts
interface RundownSlot {
  slotId: string;       // UUID, уникальный идентификатор слота (используется как templateId в WS-командах)
  templateId: string;   // UUID шаблона из таблицы templates
  name: string;         // отображаемое имя (копируется из имени шаблона при добавлении)
  vars: Record<string, string>;  // значения переменных шаблона, специфичные для этого слота
}
```

- `vars` — плоский словарь `{ variableId: stringValue }`.
- При добавлении слота `vars` инициализируется пустым объектом `{}`.
- При TAKE значения собираются так: `slot.vars[v.id] ?? String(v.defaultValue ?? '')` для каждой переменной шаблона.

### 2.2. RundownData

```ts
interface RundownData {
  id: string;              // UUID рандауна
  name: string;            // произвольное имя, по умолчанию "Rundown" / "Rundown N"
  slots: RundownSlot[];    // упорядоченный массив слотов
  channelId: string | null; // UUID канала DeckLink или null ("Нет канала")
  created_at: number;      // Unix timestamp (секунды)
  updated_at: number;      // Unix timestamp (секунды)
}
```

### 2.3. Хранение в SQLite

Таблица `rundowns`:

```sql
CREATE TABLE IF NOT EXISTS rundowns (
  id TEXT PRIMARY KEY,
  data TEXT,           -- JSON-сериализованный RundownData
  position INTEGER,    -- порядок в списке рандаунов
  created_at INTEGER,
  updated_at INTEGER
);
```

- Весь объект `RundownData` хранится в колонке `data` как JSON.
- Порядок рандаунов определяется колонкой `position` (ASC), при равенстве — `created_at ASC`.
- Миграция из legacy `data/db.json`: при первом запуске, если таблицы пусты и есть `db.json`, рандауны импортируются с `position = index` в массиве.

---

## 3. Backend: DAO и REST API

### 3.1. DAO (`rundownsDao`)

Реализовать в `backend/src/db.js`:

| Метод | Поведение |
|-------|-----------|
| `list()` | `SELECT data FROM rundowns ORDER BY position ASC, created_at ASC` → массив распарсенных объектов |
| `get(id)` | Один рандаун по ID или `null` |
| `nextPosition()` | `MAX(position) + 1` (если пусто → 0) |
| `upsert(rundown, position)` | `INSERT OR REPLACE` с JSON.stringify(rundown) |
| `remove(id)` | `DELETE FROM rundowns WHERE id=?` |
| `reorder(ids)` | Транзакция: для каждого ID в массиве `UPDATE position = index` |

### 3.2. REST-маршруты (`backend/src/routes/rundowns.js`)

Подключить роутер на `/api/rundowns` в `backend/src/index.js`.

| Метод | URL | Тело запроса | Ответ | Описание |
|-------|-----|--------------|-------|----------|
| GET | `/api/rundowns` | — | `RundownData[]` | Список всех рандаунов в хранимом порядке |
| GET | `/api/rundowns/:id` | — | `RundownData` / 404 | Один рандаун |
| POST | `/api/rundowns` | `{ name?, slots?, channelId? }` | `RundownData` | Создать: генерировать `id` (uuid v4), `created_at`/`updated_at` = now, `name` default `"Rundown"`, `slots` default `[]`, `channelId` default `null`; position = `nextPosition()` |
| PUT | `/api/rundowns/:id` | `{ name?, slots?, channelId? }` | `{ ok: true }` / 404 | Частичное обновление: менять только переданные поля; сохранять текущую `position` |
| DELETE | `/api/rundowns/:id` | — | `{ ok: true }` | Удалить рандаун |
| POST | `/api/rundowns/reorder` | `{ ids: string[] }` | `{ ok: true }` / 400 | Переставить рандауны; `ids` — полный упорядоченный список ID |

**Важно:** маршрут `POST /reorder` должен быть зарегистрирован **до** `GET /:id`, иначе Express воспримет `"reorder"` как ID.

---

## 4. Интеграция с эфиром (WebSocket и on-air state)

Rundown **не** имеет собственного backend-обработчика. Слоты используют общий контур:

### 4.1. WebSocket `/ws/control`

Команды (JSON):

```jsonc
// TAKE слота
{ "type": "take", "templateId": "<slotId>", "template": { /* полный объект Template */ }, "variables": { "varId": "value" }, "channelId": "<channelId или опущен>" }

// CLEAR слота
{ "type": "clear", "templateId": "<slotId>", "channelId": "<channelId или опущен>" }

// Live update переменных слота в эфире
{ "type": "update", "templateId": "<slotId>", "variables": { "varId": "value" }, "channelId": "<channelId или опущен>" }
```

- `channelId` берётся из `activeRundown.channelId`; если `null` — поле не передаётся, backend использует `"default"`.
- Backend (`backend/src/index.js`) маршрутизирует команды рендерерам канала и зеркалит состояние в SQLite-таблицу `onair`.

### 4.2. GET `/api/onair`

Возвращает `{ [channelId]: string[] }` — массивы ID (templateId/slotId) в эфире по каналам.

При загрузке Control Panel:

1. `Promise.all([GET /api/rundowns, GET /api/onair])`
2. `onAirSet` = все ID из всех каналов (глобальный набор)
3. `rdOnAirSet` = подмножество `onAirSet`, где ID совпадает с `slotId` хотя бы одного слота в любом рандауне

Это восстанавливает индикацию «ON AIR» после перезагрузки страницы или рестарта backend.

---

## 5. Frontend: Control Page

Вся логика rundown живёт в `frontend/src/pages/ControlPage.tsx`. Это вкладка **Rundown** внутри Control Panel (рядом с вкладкой Templates).

### 5.1. Зависимости UI

- `@dnd-kit/core` — `DndContext`, `DragEndEvent`, `closestCenter`
- `@dnd-kit/sortable` — `SortableContext`, `useSortable`, `verticalListSortingStrategy`, `arrayMove`
- `@dnd-kit/utilities` — `CSS.Transform.toString`
- `lucide-react` — иконки
- Существующие компоненты: `TemplateThumbnail`, `ProgramMonitor`, `ChannelBadge`, `ControlVideoField`, `uploadMedia`

### 5.2. Состояние React

```ts
// Управление рандаунами
rundowns: RundownData[]
activeRundownId: string | null
loadingRundowns: boolean
renamingId: string | null      // ID рандауна в режиме переименования
renameVal: string

// Производное
activeRundown = rundowns.find(r => r.id === activeRundownId)
rundown = activeRundown?.slots ?? []   // alias для слотов активного рандауна

// Эфир
onAirSet: Set<string>    // все ID в эфире (шаблоны + слоты)
rdOnAirSet: Set<string> // только slotId рандаунов в эфире

// Навигация по слотам
rdFocusIdx: number       // индекс сфокусированного слота (0-based)

// UI слотов
showAddMenu: boolean
expandedSlots: Set<string>  // slotId с раскрытой панелью переменных
fullCache: Record<string, FullTemplate>  // кэш загруженных шаблонов

// Таймеры
saveTimerRef       // debounce автосохранения (500ms)
liveUpdateTimer    // debounce live update (300ms)
```

### 5.3. Proxy-setter `setRundown`

Обновляет `slots` только у **активного** рандауна:

```ts
setRundown(updater) => setRundowns(prev => prev.map(r => {
  if (r.id !== activeRundownId) return r;
  const newSlots = typeof updater === 'function' ? updater(r.slots) : updater;
  return { ...r, slots: newSlots, updated_at: Math.floor(Date.now() / 1000) };
}));
```

---

## 6. Жизненный цикл при загрузке страницы

1. `setLoadingRundowns(true)`
2. Параллельно: `GET /api/rundowns` + `GET /api/onair`
3. Восстановить `onAirSet` из on-air данных
4. Если список рандаунов **пуст** → автоматически `POST /api/rundowns` с `{ name: "Rundown 1", slots: [] }`, установить его активным
5. Иначе → `setRundowns(list)`, `setActiveRundownId(list[0].id)` (первый в порядке хранения)
6. Вычислить `rdOnAirSet` как пересечение on-air ID с множеством всех `slotId`
7. `setLoadingRundowns(false)`

---

## 7. Автосохранение

`useEffect` на `[rundowns, activeRundownId]`:

- Пропускать, если нет `activeRundownId` или `loadingRundowns`
- Debounce **500 ms**
- `PUT /api/rundowns/:activeRundownId` с телом `{ name, slots }` активного рандауна

Переименование и смена канала сохраняются **отдельными** немедленными `PUT` (не через debounce).

---

## 8. CRUD рандаунов

### 8.1. Создание (`createRundown`)

- Имя: `Rundown ${rundowns.length + 1}`
- `POST /api/rundowns` с `{ name, slots: [] }`
- Добавить в начало локального массива (`[created, ...prev]`)
- Сделать созданный рандаун активным

### 8.2. Удаление (`deleteRundown`)

- **Запрет**, если `rundowns.length <= 1` (всегда должен остаться минимум один рандаун)
- `DELETE /api/rundowns/:id`
- Если удалён активный → переключить на `next[0]`

### 8.3. Дублирование (`duplicateRundown`)

- `POST /api/rundowns` с `{ name: src.name + " (копия)", slots: src.slots.map(s => ({ ...s, slotId: crypto.randomUUID() })) }`
- Новые `slotId` обязательны (иначе конфликт on-air ID)
- Добавить в начало, сделать активным

### 8.4. Переименование (`commitRename`)

- Inline-редактирование в сайдбаре
- `PUT /api/rundowns/:id` с `{ name: trimmed }`
- Enter / blur → commit; Escape → cancel
- Пустое имя → отмена без сохранения

### 8.5. Экспорт (`exportRundown`)

- `JSON.stringify(rd, null, 2)` → Blob → скачивание `{sanitized_name}.json`
- Имя файла: `rd.name` с заменой не-буквенно-цифровых символов на `_`

### 8.6. Импорт (`importRundown`)

- Парсинг JSON-файла как `Partial<RundownData>`
- `POST /api/rundowns` с `{ name: data.name ?? "Импортированный rundown", slots: data.slots.map(s => ({ ...s, slotId: crypto.randomUUID() })) }`
- Регенерация `slotId` обязательна

### 8.7. Reorder рандаунов (drag & drop в сайдбаре)

- `DndContext` + `SortableContext` с `items = rundowns.map(r => r.id)`
- `handleRundownsDragEnd`: `arrayMove`, затем `POST /api/rundowns/reorder` с `{ ids: next.map(r => r.id) }`

---

## 9. Управление слотами

### 9.1. Добавление слота

- Кнопка «+ Добавить шаблон» внизу списка слотов
- Выпадающее меню со списком шаблонов из `GET /api/templates`
- По клику: `setRundown(prev => [...prev, { slotId: crypto.randomUUID(), templateId: t.id, name: t.name, vars: {} }])`
- Автосохранение через debounce

### 9.2. Удаление слота (`rdRemoveSlot`)

- Если слот в эфире → сначала `rdClearSlot(slotId)`
- Затем фильтрация из массива слотов

### 9.3. Reorder слотов (drag & drop)

- `SortableContext` с `items = rundown.map(s => s.slotId)`
- `rdHandleDragEnd`: splice/move внутри массива слотов
- Сохранение через автосохранение (debounce PUT)

### 9.4. Привязка канала (`setRundownChannel`)

- `ChannelBadge` в transport bar активного рандауна
- Локально обновить `channelId` в объекте рандауна
- Немедленный `PUT /api/rundowns/:id` с `{ channelId }`
- Каналы загружаются из `GET /api/channels`; цвет бейджа — `CHANNEL_COLORS[idx % length]`

---

## 10. Эфирные операции со слотами

### 10.1. TAKE (`rdTakeAt(index)`)

1. Проверить границы массива
2. `GET /api/templates/:slot.templateId` → полный шаблон
3. Кэшировать в `fullCache`
4. Собрать `vars` из `slot.vars` + defaults шаблона
5. `send({ type: 'take', templateId: slot.slotId, template: full.data, variables: vars, channelId: activeRundown?.channelId ?? undefined })`
6. `onAirSet.add(slot.slotId)`, `rdOnAirSet.add(slot.slotId)`

### 10.2. CLEAR (`rdClearSlot(slotId)`)

- `send({ type: 'clear', templateId: slotId, channelId })`
- Удалить из `onAirSet` и `rdOnAirSet`

### 10.3. CLEAR ALL (`rdClearAll`)

- Очистить только слоты **текущего** рандауна, которые есть в `rdOnAirSet`
- Для каждого — `send clear`
- Удалить их ID из обоих Set

### 10.4. Live Update (`updateSlotVar`)

- Обновить `slot.vars` локально
- Если слот **не** в `rdOnAirSet` → только локальное сохранение
- Если в эфире → debounce **300 ms**, затем `send({ type: 'update', templateId: slotId, variables, channelId })`
- Переменные для update собираются из актуальных `slot.vars` + defaults

---

## 11. Навигация и transport

### 11.1. Фокус слота (`rdFocusIdx`)

- Клик по строке слота → `setRdFocusIdx(i)`
- При смене `activeRundownId` → сброс фокуса на `0`
- При уменьшении длины списка → clamp: `Math.min(i, rundown.length - 1)`
- Автоскролл: `document.getElementById('rd-slot-${slotId}')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })`

### 11.2. Статус слота в UI

```ts
const onAir = rdOnAirSet.has(slot.slotId);
const slotStatus = onAir ? 'on-air' : i === rdFocusIdx ? 'next' : 'pending';
```

Тип `'played'` объявлен в компоненте `SortableRundownRow`, но **не используется** в текущей логике — зарезервирован для будущего.

Визуальные состояния:

| status | Стиль |
|--------|-------|
| `on-air` | красная рамка, фон `red-500/10`, бейдж «ON AIR», кнопка CLEAR |
| `next` | accent-рамка, бейдж «NEXT» |
| `pending` | нейтральная серая рамка |
| focused (не on-air) | `ring-2 ring-white/30`, маркер ▶ |

### 11.3. Кнопки PREV / NEXT

Transport bar над списком слотов:

- **PREV**: `i = rdFocusIdx - 1`; `setRdFocusIdx(max(0, i))`; **`rdTakeAt(max(0, i))`** — берёт предыдущий слот в эфир
- **NEXT**: `i = rdFocusIdx + 1`; `setRdFocusIdx(min(len-1, i))`; **`rdTakeAt(i)`** — берёт следующий слот
- Счётчик: `{rdFocusIdx + 1} / {rundown.length || '—'}`
- PREV disabled при `rdFocusIdx === 0`; NEXT disabled при `rdFocusIdx === rundown.length - 1`

### 11.4. TAKE на строке слота

- Кнопка TAKE на не-эфирном слоте: `rdTakeAt(i)` + `setRdFocusIdx(min(i + 1, len - 1))`

### 11.5. Горячие клавиши (только вкладка Rundown)

Игнорировать, если фокус в `INPUT`, `TEXTAREA`, `SELECT`:

| Клавиша | Действие |
|---------|----------|
| `ArrowDown` | `rdFocusIdx + 1` (clamp) |
| `ArrowUp` | `rdFocusIdx - 1` (clamp) |
| `Space` | TAKE текущего слота + сдвиг фокуса на +1 |
| `Backspace` / `Delete` | CLEAR текущего слота, если он в эфире |

---

## 12. UI-компоненты

### 12.1. `SortableRundownItem` (левая панель, w-52)

Для каждого рандауна в сайдбаре:

- Drag handle (`GripVertical`), `useSortable({ id: rd.id })`
- Клик → активация рандауна
- Активный: `bg-accent-500/10 border-l-2 border-accent-500`
- Индикатор канала (цветная точка), если `channelId` задан
- Счётчик слотов: `N слот / слота / слотов` (русская плюрализация)
- Пульсирующая красная точка, если `onAirCount > 0` (число слотов рандауна в `rdOnAirSet`)
- Hover/active actions: Rename (Pencil), Duplicate (Copy), Export (FileDown), Delete (Trash2, disabled если `rundownsLength <= 1`)
- Inline rename input с Enter/Escape

Заголовок сайдбара: «Rundowns» + кнопки Import (FileUp, hidden file input `.json`) и Create (+).

### 12.2. `SortableRundownRow` (правая панель)

Для каждого слота:

- Drag handle, thumbnail (`TemplateThumbnail` 160×90), номер, имя
- Кнопки: expand variables (Chevron), TAKE/CLEAR, Remove (X)
- Раскрываемая панель переменных: text/number/color/video поля
- Color: color picker + text input
- Video: `ControlVideoField` с upload
- Lazy load шаблона при expand: `GET /api/templates/:templateId` → `fullCache`

### 12.3. Layout вкладки Rundown

```
┌─────────────────────────────────────────────────────────────┐
│ Header: Control Panel, ON AIR count, WS status              │
├─────────────────────────────────────────────────────────────┤
│ Tabs: [Шаблоны] [Rundown (count)]                           │
├──────────┬──────────────────────────────────────────────────┤
│ Sidebar  │ Transport: PREV | pos | NEXT | CLEAR ALL | name  │
│ w-52     │ ChannelBadge                                     │
│ rundowns │──────────────────────────────────────────────────│
│ list     │ Slot list (DndContext) + Add template button       │
│ (Dnd)    │                                                  │
└──────────┴──────────────────────────────────────────────────┘
│ Program Monitor (preview panel, общий с Templates tab)      │
└─────────────────────────────────────────────────────────────┘
```

---

## 13. Preview (Program Monitor)

При фокусе на слоте (вкладка Rundown):

- `useEffect` на `[tab, rdFocusIdx, rundown.length]`
- Загрузить шаблон слота (из кэша или API)
- Вызвать `selectPreview(slot.slotId, slot.name, template, vars)` — превью в iframe через `postMessage`

Превью использует `templateId: '__preview__'` в iframe, не влияет на эфир.

---

## 14. WebSocket-хук `useControlWs`

Определить **внутри** `ControlPage.tsx` (не выносить):

- Подключение к `ws://{host}/ws/control` (или `wss://`)
- Автореконнект через 3 секунды при disconnect
- `send(cmd)` — JSON.stringify, только если `readyState === OPEN`
- Экспорт: `{ status, send, reconnect }`
- `WsStatusBadge` в header: connected / connecting / disconnected

---

## 15. Ограничения и инварианты

1. **Минимум один рандаун** — нельзя удалить последний.
2. **slotId уникален** — при duplicate/import всегда генерировать новые UUID.
3. **Rundown не очищает чужие on-air** — CLEAR ALL затрагивает только слоты текущего рандауна в `rdOnAirSet`.
4. **Канал на уровне рандауна**, не слота — все TAKE/CLEAR/UPDATE слотов идут на `activeRundown.channelId`.
5. **Порядок рандаунов** — отдельный API `reorder`; порядок слотов — через PUT slots.
6. **Нет валидации** существования `templateId` на backend при сохранении слотов — фронтенд отвечает за корректность.
7. **Удаление рандауна** не очищает его слоты из эфира на backend — оператор должен снять их вручную (или они останутся в on-air до CLEAR).

---

## 16. Файлы для реализации

| Слой | Файл | Что добавить |
|------|------|--------------|
| DB | `backend/src/db.js` | Таблица `rundowns`, `rundownsDao`, миграция из JSON |
| API | `backend/src/routes/rundowns.js` | REST-роутер (новый файл) |
| API | `backend/src/index.js` | `app.use('/api/rundowns', rundownRouter)` |
| UI | `frontend/src/pages/ControlPage.tsx` | Вкладка Rundown, компоненты, state, WS-интеграция |
| Docs | `README.md` | Секции API Rundowns, модель данных (опционально) |

**Не требуется** менять: `runtime/`, `engine/`, рендерер, схему шаблонов, протокол WS (кроме использования `slotId` как `templateId`).

---

## 17. Порядок реализации (рекомендуемый)

1. SQLite-таблица + `rundownsDao` + миграция
2. REST API `/api/rundowns` (+ тесты curl)
3. Типы и загрузка списка на Control Page
4. Сайдбар: список, create/delete/rename, reorder
5. Правая панель: список слотов, add/remove/reorder
6. `rdTakeAt` / `rdClearSlot` / интеграция с `useControlWs`
7. Восстановление on-air из `/api/onair`
8. Автосохранение, channel binding
9. Live update переменных
10. PREV/NEXT, горячие клавиши, preview
11. Import/export, duplicate

---

## 18. Критерии готовности (acceptance)

- [ ] При первом запуске автоматически создаётся «Rundown 1»
- [ ] Можно создать несколько рандаунов, перетащить их в сайдбаре, порядок сохраняется после перезагрузки
- [ ] В рандаун можно добавить шаблоны, перетащить слоты, значения переменных сохраняются (debounce 500ms)
- [ ] TAKE слота выводит графику на канал рандауна; тот же шаблон в другом слоте может быть в эфире параллельно
- [ ] ON AIR / NEXT / pending корректно отображаются; CLEAR снимает слот
- [ ] PREV/NEXT делают TAKE на соседний слот и двигают фокус
- [ ] Пробел / стрелки / Backspace работают на вкладке Rundown
- [ ] Live update переменных слота в эфире (debounce 300ms)
- [ ] После F5 on-air индикация восстанавливается из `/api/onair`
- [ ] Import/export JSON, duplicate с новыми slotId
- [ ] Нельзя удалить последний рандаун
- [ ] Program Monitor показывает превью сфокусированного слота

---

## 19. Примеры API-запросов

```bash
# Список
curl http://localhost:3001/api/rundowns

# Создать
curl -X POST http://localhost:3001/api/rundowns \
  -H 'Content-Type: application/json' \
  -d '{"name":"Вечерний выпуск","slots":[],"channelId":null}'

# Добавить слоты
curl -X PUT http://localhost:3001/api/rundowns/{id} \
  -H 'Content-Type: application/json' \
  -d '{"slots":[{"slotId":"...","templateId":"...","name":"Заставка","vars":{"v1":"Новости"}}]}'

# Привязать канал
curl -X PUT http://localhost:3001/api/rundowns/{id} \
  -H 'Content-Type: application/json' \
  -d '{"channelId":"channel-uuid"}'

# Переставить рандауны
curl -X POST http://localhost:3001/api/rundowns/reorder \
  -H 'Content-Type: application/json' \
  -d '{"ids":["id2","id1","id3"]}'
```

---

## 20. Отличия Rundown от вкладки Templates

| Аспект | Templates | Rundown |
|--------|-----------|---------|
| ID в WS-командах | `templateId` = ID шаблона | `templateId` = `slotId` слота |
| Канал | `tmplChannelId` (локальный state) | `rundown.channelId` (персистентный) |
| Переменные | В карточке шаблона | В каждом слоте отдельно (`slot.vars`) |
| Порядок | По `updated_at` шаблонов | Явный drag & drop слотов |
| Навигация | Список шаблонов | PREV/NEXT по слотам |
| On-air tracking | `onAirSet` | `onAirSet` + `rdOnAirSet` |
| Персистентность | Шаблоны в DB | Рандауны + слоты в DB |

Оба режима используют один WebSocket, один backend on-air state и одни и те же рендереры.
