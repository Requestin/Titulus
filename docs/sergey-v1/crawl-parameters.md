# Crawl — параметры объекта и влияние на анимацию

Слой **Crawl** (бегущая строка / карусель строк). Параметры лежат в `layer.crawl` (`CrawlProps`) и в связанных полях слоя (`content`, `style`, `crawlDirectorId`).

Источник типов: `runtime/src/schema.ts`. Движение: `runtime/src/crawl.ts`. UI: `frontend/src/editor/CrawlProperties.tsx`.

---

## Быстрый старт

1. Добавьте слой **Crawl** — создаётся директор **Crawl** и трек `crawlProgress`.
2. Задайте текст в **Content** (или привяжите переменную / файл).
3. Выберите **Type** (`ticker` / `carousel`), направления **In** / **Out**, **Speed**.
4. При необходимости — **Pause**, разделитель, режим **Anim**.
5. Длительность директора пересчитывается автоматически от текста, размера бокса, speed/pause и направлений.

Play таймлайна крутит директор Crawl → текст едет по In/Out.

---

## Объект `crawl` (`CrawlProps`)

| Параметр | Тип | Default | Что делает |
|---|---|---|---|
| `type` | `'ticker' \| 'carousel'` | `ticker` | Ось движения и набор направлений |
| `directionIn` | `'left' \| 'right' \| 'up' \| 'down'` | `right` | Откуда въезжает контент |
| `directionOut` | то же | `left` | Куда выезжает |
| `speed` | `number` (> 0) | `5` | Скорость: `1` ≈ **60 px/s**, значит `5` ≈ **300 px/s** |
| `pause` | `number` (кадры ≥ 0) | `0` | Пауза hold, когда строка полностью в кадре |
| `separatorMode` | `'none' \| 'text' \| 'image'` | `none` | Разделитель между строками ленты |
| `separatorText` | `string` | `''` | Текст разделителя (режим `text`); пробелы значимы |
| `separatorImage` | `string` (URL) | `''` | Картинка-разделитель (режим `image`) |
| `animationType` | `'batch' \| 'continuous'` | `batch` | Разовый проход vs бесшовный цикл |
| `useFile` | `boolean` | `false` | Контент из файла + Parse |
| `filePath` | `string` | `''` | Путь/URL файла (`.txt`) |
| `maxTextLengthEnabled` | `boolean` | `false` | Обрезать каждую строку по длине |
| `maxTextLength` | `number` | `80` | Макс. символов на строку (если enabled) |

---

## Type — `ticker` vs `carousel`

### Ticker (горизонталь)

- Движение по **X**: направления только `left` / `right`.
- Default: In=`right`, Out=`left` (классическая бегущая строка справа налево).
- Длина строки по оси оценивается от числа символов × размер шрифта (пробелы считаются).

### Carousel (вертикаль)

- Движение по **Y**: направления только `up` / `down`.
- Default при смене типа: In=`up`, Out=`down`.
- «Длина» строки по оси ≈ высота строки/бокса (не ширина текста).

Смена Type в редакторе сбрасывает In/Out на defaults для выбранного режима.

---

## Direction In / Out

| | Смысл |
|---|---|
| **In** | Стартовая позиция (за кадром с этой стороны) |
| **Out** | Финальная позиция (уезд за кадр) |

Типичные схемы:

- **Ticker classic:** In=`right`, Out=`left` — въезд справа, уезд влево.
- **Ticker reverse:** In=`left`, Out=`right`.
- **Carousel classic:** In=`up`, Out=`down` (или наоборот).

Если In === Out (одинаковое направление), enter и exit симметричны относительно rest-позиции (hold).

---

## Speed

- Единица: множитель к **60 px/s**.
- Формула: `pxPerSec = speed × 60`.
- Влияет на число кадров проезда (`enter` / `exit` / длина strip) → на **`durationFrames` директора Crawl**.
- Больше speed → короче анимация; меньше → длиннее.

Примеры: `1` ≈ 60 px/s, `5` ≈ 300 px/s, `10` ≈ 600 px/s.

---

## Pause (в кадрах, не секундах)

| Значение | Поведение |
|---|---|
| `pause = 0` | Режим **ленты (strip)**: все строки едут одной полосой |
| `pause > 0` | Режим **построчно (per-line)**: въезд → hold N кадров → выезд → следующая строка |

Работает и для Ticker, и для Carousel.

### Связь с Align (стиль текста слоя)

| Режим | Align |
|---|---|
| Carousel | всегда учитывается (выравнивание по поперечной оси / CSS) |
| Ticker + Pause > 0 | учитывается в rest-позиции hold (`left` / `center` / `right`) |
| Ticker + Pause = 0 | **Align игнорируется** |

---

## Animation Type — Batch vs Continuous

### Batch (по умолчанию)

- Один проход: контент въезжает, проходит путь, уезжает.
- При `pause = 0`: travel ≈ длина контента + ширина/высота бокса (полный заезд–выезд).
- Длительность директора ≈ один такой проход.

### Continuous

- Бесшовный цикл (marquee): контент визуально дублируется, стык незаметен.
- При `pause = 0`: период = длина ленты (+ separator), без «зазора бокса».
- При `pause > 0`: у **последней** строки hold принудительно `0`, чтобы первая шла сразу без паузы на стыке цикла.

Директор обычно с `loop: true` для непрерывного эфира; длина директора = один период schedule.

---

## Separator

Вставляется **между** строками ленты (не после последней в оценке периода).

| Mode | Эффект |
|---|---|
| `none` (UI: **X**) | Без разделителя, gap = 0 |
| `text` | Текст `separatorText` между строками; пробелы сохраняются (`white-space: pre`) |
| `image` | Картинка `separatorImage` (URL медиа); ширина в оценке ≈ clamp по высоте бокса |

Разделитель увеличивает период ленты → длиннее анимация при тех же Speed/Pause.

---

## Content (поле слоя, не внутри `crawl`)

| Способ | Как |
|---|---|
| Литерал | Multiline textarea; `\n` = новая строка данных |
| Переменная | Bind к `multitext` / `textfile` / `text` (кнопка `{ }`) |
| Файл | `useFile` + `filePath` + **Parse** |

Правила:

- Строки режутся только по **жёстким** переводам `\n` (пробелы внутри строки не схлопываются).
- При смене текста (в т.ч. defaultValue переменной или live UPDATE) длительность Crawl-директора **пересчитывается**.
- Перед **TAKE**, если `useFile = true`, Parse выполняется автоматически; ошибка чтения файла → TAKE не уходит.

### Use File / Parse / Filepath

| Поле | Влияние |
|---|---|
| `useFile` | Блокирует ручной Content/bind; ждёт Parse или auto-Parse на TAKE |
| `filePath` | Upload URL (`/uploads/...`) или allow-listed путь (`POST /api/files/read`) |
| Parse | Читает файл → записывает в `content` → сразу пересчитывает director |

### Maximum text length

| Поле | Влияние |
|---|---|
| `maxTextLengthEnabled` | Вкл. обрезку каждой строки |
| `maxTextLength` | `line.slice(0, max)` при enabled |

Короче строки → короче span → короче анимация (при прочих равных).

---

## Связанные поля слоя (не в `crawl`, но влияют)

| Поле | Влияние |
|---|---|
| `content` | Текст строк / binding |
| `style` (шрифт, size, align, shadow, color, …) | Визуал; `fontSize` участвует в оценке длины; Align — см. Pause |
| `transform` / Size / Position | Бокс клипа: `width`/`height` задают «окно» crawl и clearance при batch |
| `crawlDirectorId` | ID dedicated-директора; трек `crawlProgress` 0→1 на его длительности |
| Visibility / opacity слоя | Как у любого слоя; не меняет schedule |

**Shadow** (Color/X/Y/Blur) обновляется каждый paint в preview.

---

## Что пересчитывает длительность директора

`durationFrames` ≈ f(

- число и длина строк (`content` + max length),
- `type` / `directionIn` / `directionOut`,
- `speed`,
- `pause`,
- `animationType`,
- separator,
- размер бокса слоя,
- fps шаблона,
- align (только когда Align активен)

).

Любое изменение этих параметров в редакторе вызывает `recomputeCrawlDirectorDuration`. На эфире при TAKE/UPDATE с корректным текстом переменных — то же через `prepareTemplateForAir` → `recomputeAllCrawlDirectors`.

---

## Практические рецепты

| Задача | Настройки |
|---|---|
| Классическая бегущая строка | Type=`ticker`, In=`right`, Out=`left`, Pause=`0`, Anim=`continuous`, Speed=`5` |
| Строка с остановкой по центру | Type=`ticker`, Pause=`50`…`100`, Align=`center`, Anim=`batch` |
| Вертикальные титры построчно | Type=`carousel`, Pause=`25`+, In/Out `up`/`down` |
| Новости из `.txt` | Use File + filepath + Parse; на TAKE Parse автоматический |
| Лента с « • » между новостями | Separator=`text`, Sep text=` • ` (пробелы сохранятся) |
| Обрезка длинных строк | Maximum text length + Max chars |

---

## JSON-пример

```json
{
  "type": "crawl",
  "content": "Первая новость\nВторая новость",
  "crawlDirectorId": "<uuid>",
  "crawl": {
    "type": "ticker",
    "directionIn": "right",
    "directionOut": "left",
    "speed": 5,
    "pause": 0,
    "separatorMode": "text",
    "separatorText": "  •  ",
    "separatorImage": "",
    "animationType": "continuous",
    "useFile": false,
    "filePath": "",
    "maxTextLengthEnabled": false,
    "maxTextLength": 80
  }
}
```

---

## Где смотреть в коде

| Area | Path |
|---|---|
| Типы / defaults / normalize | `runtime/src/schema.ts` |
| Schedule, pause, align, speed | `runtime/src/crawl.ts` |
| Отрисовка | `runtime/src/domRenderer.ts` (`paintCrawl`) |
| UI параметров | `frontend/src/editor/CrawlProperties.tsx` |
| Длительность директора | `frontend/src/editor/crawlTimeline.ts` |
| Parse / TAKE file | `frontend/src/core/crawlFile.ts` |
| JSON Schema | `shared/template.schema.json` |

После правок runtime: `cd runtime && npm run build`, затем hard refresh редактора.
