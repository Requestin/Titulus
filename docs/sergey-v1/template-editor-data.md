# Template Editor → Data — как работать и что означают параметры

Раздел **Data** в Template Editor настраивает **внутренний data pipeline** шаблона:

```
файл / inline → parse → select строки → map в variables → слои / Control / эфир
```

Выбор строки делает **дизайнер** (в шаблоне), не оператор в Control. Оператор видит уже заполненные значения (или не видит driven-переменные вовсе).

| | |
|---|---|
| UI | вкладка **Data** справа в редакторе (`DataPanel`) |
| Хранение | `template.data` (`TemplateData`) |
| Runtime | `runtime/src/dataPipeline.ts` → `runTemplateData` |
| Перед эфиром | `frontend/src/core/prepareTemplateData.ts` (`prepareTemplateForAir`) |

Связанный раздел: **Variables** (флаги `drivenBy` / Show in Control).

---

## Зачем это нужно

Типичный сценарий: гости / новости / титры из `.txt` или `.json`.

1. В файле строки вида `Имя|Должность|asset:<uuid>`.
2. Pipeline выбирает нужную строку (первая, индекс, по ключу…).
3. Колонки пишутся в переменные шаблона (`name`, `title`, `photo`).
4. Слои Text/Image/Video/Crawl привязаны к этим переменным.
5. На **TAKE** / preview pipeline прогоняется автоматически → в эфир уходит уже заполненный шаблон.

Оператор **не** выбирает строку в Control — логика закреплена в шаблоне.

---

## Быстрый старт (чек-лист)

1. **Variables** — создайте переменные нужных типов (`text`, `multitext`, `image`, `video`, `number`, `time`…).
2. **Data** → **Enable Data pipeline** — появится пример source + pipeline `main`.
3. Настройте **Source**: путь к файлу, format, delimiter, columns.
4. Настройте **Pipeline**: source, **Select**, **Map** (колонка → variable, тип `as`).
5. При map переменной автоматически ставится `drivenBy = pipeline id`, `exposed = false` (скрыта в Control).
6. Слои: Text/Image/Video → bind `{ }` к переменной.
7. В файле для медиа используйте токен **`asset:<uuid>`** (кнопка Copy token в Media library), не display name.
8. **Preview pipeline** — проверить `overrides` / `errors` без TAKE.
9. Save → TAKE из Control / Templates.

Чтобы убрать pipeline целиком: иконка корзины в шапке Data → `template.data` сбрасывается.

---

## Корневые параметры `template.data`

| Параметр | Default | Значение |
|---|---|---|
| `version` | `1` | Версия контракта (сейчас только `1`) |
| `sources[]` | `[]` | Источники данных (файлы / inline) |
| `pipelines[]` | `[]` | Цепочки select + map |
| `runOn` | `take,load` | Когда запускать pipeline |
| `onError` | `block` | Поведение при ошибке / сбое |

### `runOn` (триггеры)

Список через запятую в UI. Допустимые значения:

| Триггер | Когда срабатывает |
|---|---|
| `take` | Перед TAKE в эфир (`prepareTemplateForAir`) |
| `load` | При загрузке/preview в редакторе (и Preview pipeline) |
| `update` | Перед live UPDATE |
| `refresh` | Явное обновление (если вызывающий код передаёт этот trigger) |

Если текущего триггера нет в `runOn` — pipeline **не выполняется** (ok, пустые overrides).

Пример: только на эфир — `take`. На TAKE и UPDATE — `take,update`.

### `onError`

Глобальная политика при ошибках чтения/parse/map (и когда pipeline не нашёл source):

| Значение | Поведение |
|---|---|
| `block` | Ошибка → `ok: false`, TAKE блокируется (типичный production-режим) |
| `keep` | Ошибка → overrides не пишутся, старые значения переменных остаются |
| `clear` | Ошибка → mapped / driven переменные очищаются (`''` / `0`) |

Локально у pipeline есть ещё `onEmpty` (пустой select) — см. ниже; в UI DataPanel сейчас не выведен, задаётся в JSON шаблона.

---

## Sources — источники

Каждый source читает «сырой» текст и парсит его в массив **записей** (`DataRecord`: плоский словарь `string → string` + служебное поле `index`).

### Поля source (UI)

| Поле | Описание |
|---|---|
| **id** | Уникальный id; на него ссылается pipeline.`sourceId`. Переименование id обновляет ссылки в pipelines |
| **type** | Откуда брать текст |
| **format** | Как парсить |
| **path / content** | Путь к файлу или inline-текст |
| **delimiter / columns** | Для format=`delimited` |

### `type`

| Type | Что делает |
|---|---|
| `textfile` | Читает файл по `path` (`.txt` / text) |
| `jsonfile` | Читает файл по `path` (`.json`); при выборе типа format часто ставят `json` |
| `inline` | Текст прямо в шаблоне (`content`), без файла — удобно для тестов |

### `path`

Только для `textfile` / `jsonfile`:

| Режим | Смысл |
|---|---|
| **path literal** | Строка пути: `/uploads/guests.txt`, `https://…`, или allow-listed путь через `POST /api/files/read` |
| **path from variable** | Путь берётся из значения переменной (оператор/другой pipeline может подставить другой файл) |

Поддерживаемые расширения при чтении: **`.txt`**, **`.json`** (и text/json content-type для URL).

### `format` — как парсятся строки

| Format | Результат записей | Типичный файл |
|---|---|---|
| `lines` | Одна запись на строку: поля `line`, `index` | Простой список |
| `delimited` | Колонки по разделителю → имена из `columns` (или header / `col0`…) | `name\|title\|photo` |
| `kv` | **Одна** запись: все `key=value` строки файла | Конфиг-титры |
| `json` | Массив объектов → много записей; один объект → одна запись | JSON API dump |

#### Delimited — детали

| Option | Default | Смысл |
|---|---|---|
| `delimiter` | `\|` | Разделитель ячеек |
| `columns` | задаёте вручную | Имена полей слева→направо: `name,title,photo` |
| `commentPrefix` | часто `#` в шаблоне Enable | Строки с этим префиксом пропускаются |
| `skipEmpty` | `true` | Пустые строки пропускаются |
| `trim` | `true` | Trim ячеек/строк |
| `hasHeader` | `false` | Первая строка = имена колонок (если `columns` не заданы) |

`columns` в UI: любое число через запятую, trailing comma при вводе допускается.

Пример файла:

```text
# comment
Иванов|Корреспондент|asset:11111111-1111-4111-8111-111111111111
Петрова|Ведущая|asset:22222222-2222-4222-8222-222222222222
```

При `columns = name,title,photo` первая data-строка даст:

```json
{ "index": "1", "name": "Иванов", "title": "Корреспондент", "photo": "asset:..." }
```

#### Lines

Каждая непустая строка → `{ "line": "…", "index": "1" }`. В map поле `from` обычно `line`.

#### KV

Строки `key=value` (разделитель `kvSeparator`, default `=`). Весь файл → **одна** запись с ключами. Select почти всегда `first`.

#### JSON

- Корень — **массив** объектов → N записей (плоские поля; вложенные объекты пропускаются).
- Корень — **объект** → одна запись.
- `options.rootPath` — JSON Pointer (`/items`) или dotted path (`items`) до массива/объекта (в UI не выведен — правьте JSON шаблона).

---

## Pipelines — выбор строки и map

Pipeline связывает один source с набором переменных.

### Поля pipeline (UI)

| Поле | Описание |
|---|---|
| **Pipeline id** | Имя цепочки (`main`). Должно совпадать с `variable.drivenBy` |
| **source** | Какой source читать |
| **Select** | Какую запись (или все) взять — **только дизайнер**, не Control |
| **Map** | Список: поле записи → variable + тип `as` |

Дополнительно в схеме (частично без UI): `enabled`, `onEmpty`, `mediaResolve`, `join`, `map[].transform`.

### Select (designer-only)

| Mode | Поведение |
|---|---|
| `first` | Первая запись |
| `last` | Последняя |
| `index` | 1-based номер строки (`index: 1` = первая) |
| `byKey` | Первая запись, где `record[key] === value` |
| `match` | Первая, где `record[key]` матчит regex `pattern` |
| `all` | Все записи → склейка (см. Join / single map) |

Пустой select → ошибка `EMPTY_SELECTION`; политика `pipeline.onEmpty` (`keep` / `clear` / `block`, default в runtime при отсутствии — `keep`; в стартовом Enable-шаблоне часто `block`).

### Map → variables

Каждая строка map:

| Поле | Смысл |
|---|---|
| **from** | Имя поля в записи (`name`, `title`, `line`, `photo`…) |
| **to** | Variable (по id) |
| **as** | Как интерпретировать значение |

При выборе variable в map редактор ставит:

- `drivenBy = <pipeline id>`
- `exposed = false` → в Control переменная **скрыта** (пока не включите Show in Control).

#### `as` — типы map

| `as` | Эффект |
|---|---|
| `text` | Строка как есть (после optional transform) |
| `multitext` | Многострочный текст (для Crawl / multitext var) |
| `number` | `Number(value)`; нечисло → ошибка (block) |
| `time` | Строка времени для clock/time-переменных |
| `image` | Медиа-токен → URL картинки через `mediaResolve` |
| `video` | То же для видео; после resolve создаётся/обновляется clip на timeline (`videoProgress`) |

### Select `all` — склейка

- Если задан `join` (`field` + `separator`, default `\n`) — склеиваются значения поля `join.field` по всем строкам, результат пишется в **первый** map entry.
- Иначе нужен **ровно один** map entry: склеиваются `record[from]` через `\n` (удобно для multitext / Crawl из всех строк файла).

### Медиа в файле (`as: image|video`)

В ячейке файла указывайте один из форматов:

| Токен | Пример |
|---|---|
| `asset:<uuid>` | `asset:3fa85f64-5717-4562-b3fc-2c963f66afa6` — **рекомендуется** (Copy token в MAM) |
| bare UUID | тот же uuid без префикса |
| URL | `https://…` или `/uploads/…` |

**Нельзя** резолвить по display name файла в медиатеке — только token / url / path.

Политика `mediaResolve` (default при Enable):

```json
{ "strategy": ["assetId", "url", "path"], "onMiss": "clear" }
```

| `onMiss` | Если токен не найден |
|---|---|
| `clear` | В переменную `''` (или `fallbackUrl`) |
| `keep` | Не перезаписывать (ошибка без block) |
| `block` | Падать pipeline / блокировать TAKE |

---

## Variables ↔ Data (связанные флаги)

В панели **Variables**:

| Поле | Смысл |
|---|---|
| **Data-driven** (`drivenBy`) | Id pipeline, который заполняет переменную (например `main`) |
| **Show in Control** (`exposed`) | Показать оператору; для driven по умолчанию выкл. |
| **Value** | Default до прогона pipeline / fallback при `keep` |

Правила:

- Driven + не exposed → Control **не показывает** поле (оператор не правит вручную).
- Driven + Show in Control → видно; pipeline на TAKE всё равно может перезаписать.
- Смена Pipeline id в Data обновляет `drivenBy` у привязанных переменных.

Слои привязываются к переменным как обычно (`{ }` / binding). Image/Video: bind к image/video variable; в Properties для pipeline-токенов подсказка про `asset:<uuid>`.

---

## Когда pipeline реально выполняется

| Место | Trigger | Зачем |
|---|---|---|
| Editor **Preview pipeline** | `load` | Отладка overrides/errors |
| Canvas preview (при data) | `load` | Живой preview с данными |
| TAKE (Templates / Rundown / DataElement) | `take` | Эфирный снимок |
| Live UPDATE | `update` (если в `runOn`) | Обновление в эфире |

Порядок в `prepareTemplateForAir` (упрощённо):

1. Crawl Use File Parse (если есть).
2. `runTemplateData` → overrides.
3. Merge в variable map.
4. Пересчёт Crawl directors под новый текст.
5. Video clips из image/video переменных.
6. Отправка TAKE/UPDATE.

При `onError: block` и ошибке pipeline TAKE **не уходит** (ошибка пользователю).

---

## Preview pipeline

Кнопка внизу вкладки Data:

- Гоняет текущий `template.data` с trigger `load`.
- Показывает JSON: `{ ok, overrides, errors }`.
- `overrides` — `variableId → value` (не имена переменных).
- Удобно проверить path, columns, select и media resolve до эфира.

---

## Пример end-to-end

**Файл** `/uploads/guests.txt`:

```text
# name|title|photo
Иванов|Корреспондент|asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
Петрова|Ведущая|asset:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

**Variables:** `guestName` (text), `guestTitle` (text), `guestPhoto` (image).

**Source:**

- type=`textfile`, format=`delimited`
- path literal=`/uploads/guests.txt`
- delimiter=`|`, columns=`name,title,photo`
- commentPrefix=`#` (в options JSON / Enable-шаблон)

**Pipeline `main`:**

- select=`index`, index=`1` (первый гость) или `byKey` / смена index под нужную строку
- map:
  - `name` → guestName, as=`text`
  - `title` → guestTitle, as=`text`
  - `photo` → guestPhoto, as=`image`

**Слои:** Text ← guestName / guestTitle; Image ← guestPhoto.

**runOn:** `take,load` · **onError:** `block`.

На TAKE в эфир уйдёт Иванов + фото; Control переменные не покажет (driven hidden).

---

## Типичные ошибки

| Симптом | Что проверить |
|---|---|
| TAKE blocked / Preview `ok: false` | path файла, format, delimiter, columns, `onError` |
| Пустые overrides | `runOn` не содержит текущий trigger; select мимо строк; `from` ≠ имя колонки |
| Картинка пустая | В файле display name вместо `asset:<uuid>`; Copy token из MAM |
| Переменная видна в Control | Выключить Show in Control или проверить `drivenBy` |
| Video без клипа на timeline | `as: video` + успешный resolve; клип ставится после pipeline |
| JSON «не парсится» | Корень не object/array; нужен `rootPath` до массива |
| `all` падает | Нужен `join` или ровно один map entry |

---

## Поля схемы без полного UI (правка JSON / будущий UI)

Задаются в `template.data` напрямую (Save шаблона), если нужны тонкие настройки:

| Поле | Где | Смысл |
|---|---|---|
| `source.options.commentPrefix` | source | Префикс комментариев (`#`) |
| `source.options.hasHeader` | source | Первая строка = header |
| `source.options.kvSeparator` | source | Разделитель для `kv` |
| `source.options.rootPath` | source | Путь внутри JSON |
| `pipeline.enabled` | pipeline | `false` — пропустить |
| `pipeline.onEmpty` | pipeline | `keep` / `clear` / `block` при 0 строк |
| `pipeline.mediaResolve` | pipeline | strategy + onMiss + fallbackUrl |
| `pipeline.join` | pipeline | Склейка при select=`all` |
| `map[].transform` | map entry | `trim` / `prefix` / `suffix` / `replace` |

---

## Где смотреть в коде

| Area | Path |
|---|---|
| UI Data | `frontend/src/editor/panels/DataPanel.tsx` |
| Variables driven/exposed | `frontend/src/editor/panels/VariablesPanel.tsx` |
| Pre-TAKE / read / media | `frontend/src/core/prepareTemplateData.ts` |
| Runtime pipeline | `runtime/src/dataPipeline.ts` |
| Типы | `runtime/src/schema.ts` (`TemplateData`, …) |
| JSON Schema | `shared/template.schema.json` |
| Control hide driven | `frontend/src/control/ControlVariablesPanel.tsx` |
| Files API | `backend/src/routes/files.js` |
| Smoke | `cd runtime && npm test` |

После правок runtime: `cd runtime && npm run build` + hard refresh редактора.
