# ТЗ: Actions + Continue/Update + Login logo

> Статус: **DRAFT** (решения зафиксированы 2026-07-16, уточнения A–E).  
> Источник: `/home/ladmin/Documents/actions.txt` + ответы на спорные вопросы.  
> Legacy schema Actions (`startDirector|stopDirector|setTag`) — **заменяется** моделью ниже; breaking bump — §8.

---

## Задача 1 — Login: логотип ×3

### Цель

На `/login` увеличить изображение логотипа в **3 раза**. Поля логина/пароля оставить по центру.

### As-is

`frontend/src/pages/LoginPage.tsx` — `<img src="/titulus-logo.png" …>`.

### Acceptance

- [ ] Логотип визуально ~3× текущего размера
- [ ] Поля username/password остаются по центру
- [ ] Не ломает mobile/desktop layout login

---

## Задача 2 — Timeline object: Action

### Цель

Тип объекта **Action** на timeline: привязан к director; исполняется, когда playhead **этого** director доходит до frame Action (с учётом Direction item’а).

### UI: кнопки toolbar

`… | -K | +A | -A | …`

| Кнопка | Поведение |
| ------ | --------- |
| **+A** | Правее `-K`. Добавляет Action на **выделенный director** в кадр **playhead** этого director. Если на этом `(directorId, frame)` cue уже есть — добавляет **новый item внутрь существующего cue** (не второй marker). |
| **-A** | Правее `+A`. Disabled, пока не выделен Action-marker. Удаляет **весь cue** (все nested items на этом marker). Отдельный item — кнопкой `-Action` в Properties. |

**Предусловия +A:** выделен director → playhead на кадре → `+A`.

**Перемещение:** drag влево/вправо только внутри своего director; между directors — нельзя.

**Удаление director:** все его Action cue удаляются. Исключение: director `Update` **нельзя удалить / переименовать** (см. §4).

---

### 2.1 Модель данных

Один визуальный marker = один cue на `(directorId, frame)` = N command-items.

```ts
type ActionCommand =
  | 'startDirector'
  | 'stopDirector'
  | 'stopDirectorAndWaitContinue'
  | 'pauseDirector'
  | 'tag';

type ActionDirection = 'both' | 'normal' | 'reverse';

type ActionTag = 'endScene' | 'updateData';

interface ActionCommandItem {
  id: string;
  command: ActionCommand | null;   // default null
  parameterDirectorId?: string | null;
  parameterTag?: ActionTag | null;
  lengthFrames: number;            // pauseDirector; default 0
  direction: ActionDirection;      // default 'both'
}

/** Один marker на timeline */
interface TimelineActionCue {
  id: string;
  directorId: string;
  frame: number;
  name: string;                    // глобально для marker; default ''; tooltip на hover
  items: ActionCommandItem[];      // минимум 1
}
```

`timeline.actions: TimelineActionCue[]`.

---

### 2.2 Properties

При создании / клике по marker — Properties:

| Поле | UI | Правила |
| ---- | -- | ------- |
| **Name** | text (уровень **cue/marker**, не item) | default `''`; необязательно; hover tooltip |
| **Command** | select (per item) | Start / Stop / Stop and wait continue / Pause / Tag. Default: ничего |
| **Parameter** | select (per item) | зависит от Command |
| **Length** | number frames (per item) | editable только при Pause; **default = 0** |
| **Direction** | 3 exclusive toggles (per item) | Both \| Normal \| Reverse; default **Both** |

#### Parameter defaults

| Command | Parameter | Default |
| ------- | --------- | ------- |
| Start director | список directors | **первый director в списке** |
| Stop director | список directors | director создания cue |
| Stop director and wait continue | список directors | director создания |
| Pause director | список directors | director создания; Length editable, default **0** |
| Tag | см. ограничения ниже | **`End scene`** (где разрешено) |

#### Ограничения Tag по director

| Director | Доступные Tag | Запрещено |
| -------- | ------------- | --------- |
| **Update** | только `Update data` (и ровно 1 на template) | **`End scene` нельзя** |
| Любой другой | `End scene` (и не `Update data`) | `Update data` только на Update |

Второй `Update data` на template → ошибка валидации/UI.

---

### 2.3 Nested actions

- **+Action** → новый item в том же cue, своя рамка  
- items > 1 → **-Action** в рамке (удаляет item)  
- Исполнение items: порядок в `items[]`  
- Количество не ограничено  

---

### 2.4 Runtime

**Общее:**

- Item исполняется при cross playhead’а host-director cue через `frame`, если `Direction` item’а разрешает направление.  
- **Scrub / seek без Play — не исполняет.**  
- `command: null` → silent skip.  
- Layer `clock` **не останавливается** pause/stop.  
- При `pause` / `stop` / `stopAndWaitContinue` — playhead target заморожен.

#### Состояния director

| State | Смысл |
| ----- | ----- |
| `play` | Идёт; хранить last direction |
| `stop` | Остановлен. Также initial state при `autostart=false` |
| `stopAndWaitContinue` | Ждёт **только** Continue |
| `pause` | Пауза `lengthFrames` кадров; затем resume. Length **0** → пауза нулевой длины (мгновенный resume / no-op pause) |

#### Команды

| Command | Поведение |
| ------- | --------- |
| **Start director** | Start Parameter-director только если он в `stop`; иначе ignore |
| **Stop director** | Target → `stop` |
| **Stop director and wait continue** | Target → `stopAndWaitContinue`. Resume **только** Continue (все такие directors этого instance). Take/`update` не резюмят |
| **Pause director** | Target → `pause` на Length; clock не трогать |
| **Tag: End scene** | Снять этот template с экрана → Pending; Take снова active. **Нельзя** на director Update |
| **Tag: Update data** | replace-all variables из pending `update` (задача 4); только на Update |

---

### 2.5 Acceptance (задача 2)

- [ ] `+A` / `-A`; `-A` = весь cue; `+A` на frame → item в cue  
- [ ] Name на cue; Length default 0  
- [ ] Tag defaults/restrictions: End scene вне Update; Update data только на Update ×1; End scene на Update запрещён  
- [ ] Update director: no delete/rename  
- [ ] Scrub не стреляет; Direction/states/pause/clock как в таблице  
- [ ] Schema validate + save/reload  

---

## Задача 3 — Control: Take / Continue / Clear

### Цель

В **Rundown** и **Templates** — у каждой строки всегда три иконки:

| Кнопка | Иконка | Смысл |
| ------ | ------ | ----- |
| **Take** | → | Выдать / при том же templateId → ветка Update или Clear+restart |
| **Continue** | ⇉ | WS `continue` — resume всех `stopAndWaitContinue` этого OnAir instance |
| **Clear** | ■ | Снять этот template с эфира |

### Политика OnAir (важно)

| Правило | Смысл |
| ------- | ----- |
| **Разные** `templateId` | Можно держать в эфире **сколько угодно одновременно** на одном channel (стек). Take `template#2`, пока OnAir `template#1` — **да**, оба могут быть в эфире. |
| **Один и тот же** `templateId` | В эфире на channel **только один** render-instance. Повторный Take того же id → не второй слой, а **`update` / Clear / Clear+restart`** (задача 4). |
| **Playlist / rundown** | В плейлисте можно добавить **сколько угодно** слотов с одним и тем же template. |
| **UI-статус строки (slot-aware)** | OnAir показывается **только у той строки (slot), с которой сделали Take**. Другие слоты с тем же `templateId` остаются **Pending** (кнопки как у Pending). |

> Ранее ошибочно формулировалось «1 template на channel» — **отменено**.  
> Ранее ошибочный дефолт «все строки с одним templateId = OnAir» — **отменён**: статус только у выданного slot.

**Идентичность для UI / команд rundown:** `slotId` (кто «владеет» OnAir-индикатором).  
**Идентичность для запрета второго слоя:** `templateId` на channel (один render-instance).

WS take/continue/clear/update в rundown несут и `slotId`, и `templateId` (Templates tab без slot — достаточно `templateId`).

### Enable matrix (на строку / slot)

| Состояние **этой строки** | Take | Continue | Clear |
| ------------------------- | ---- | -------- | ----- |
| Pending (в т.ч. другой slot с тем же templateId уже OnAir) | **active** | disabled | disabled |
| OnAir (именно этот slot выдан) | **active** | disabled, пока нет wait-continue | **active** |
| OnAir + `stopAndWaitContinue` | active | **active** | active |
| После End scene → Pending | **active** | disabled | disabled |

Пример: 3 слота с одним `templateId`, Take на слоте B → B = OnAir, A и C = Pending.

### Поведение кнопок

**Take**

1. Этого `templateId` нет в OnAir на channel → обычный `take` с `slotId` этой строки; строка становится OnAir.  
2. Этот `templateId` уже OnAir (в т.ч. с **другого** slot) → задача 4 (`update` или Clear+restart).  
   - При **`update`**: OnAir-индикатор **переходит** на слот, с которого сделали Take/update; прежний владелец → Pending.  
   - При **Clear+restart**: новый Take вешает OnAir на слот-инициатор (прежний уже cleared → Pending).  
3. Не резюмит wait-continue.

**Continue**

- Только на строке в статусе OnAir.  
- WS `{ "type": "continue", "templateId", "channelId", "slotId" }`.  
- Resume всех `stopAndWaitContinue` этого instance.

**Clear** — только со строки OnAir; `clear` по instance (`templateId` + `slotId`) → эта строка Pending.

### Acceptance (задача 3)

- [ ] Три иконки в Rundown и Templates  
- [ ] Много разных templates OnAir OK; один templateId — один render-instance  
- [ ] Playlist: дубликаты template OK; OnAir-индикатор только у выданного slot  
- [ ] Соседние слоты с тем же templateId остаются Pending  
- [ ] `continue` в протоколе (+ slotId в rundown)  
- [ ] После End scene — Pending, Take active  

---

## Задача 4 — Update director + команда `update`

### Цель

Повторное действие на уже OnAir `templateId` → director **Update**, если он «armed» анимацией; иначе Clear + Take с начала.

### Director Update (обязательный)

| Свойство | Значение |
| -------- | -------- |
| name | `Update` — **нельзя удалить, нельзя переименовать** |
| tracks | по умолчанию пусто |
| durationFrames | `100` |
| autostart | `false` → state `stop` |
| Actions | 1 cue @ frame `50`: Tag = **Update data** (не End scene) |

- Новые templates — с Update.  
- Старые — миграция: добавить Update + cue, если нет.  
- `Update data`: только на Update, 1× на template.  
- `End scene`: **запрещён** на Update.  
- Поиск имени: case-insensitive `update`.

### Критерий «есть анимация» (armed Update)

```
armed =
  Update имеет ≥1 track
  AND на треках Update суммарно ≥2 keyframes
```

- Нет треков / меньше 2 keyframes → **всегда Clear + restart** при повторном Take.  
- Armed → выполнить Update-flow через команду **`update`**.

### Re-Take / DataElement с тем же templateId

```
if channel already has OnAir with same templateId:
  if Update armed (≥1 track && ≥2 keyframes):
    send WS type: "update"   // имя команды прежнее, логика новая
      → запустить Update с начала
      → на tag Update data: variables = replace all из payload
      → доиграть Update до конца → playhead на начало Update
      → остальные directors продолжают, если не stop/pause
  else:
    clear этого templateId
    take с начала (новый полный старт)
```

Повторять Update можно бесконечно.

### Variables / scope

- Apply на tag: **replace all**.  
- Update-flow только **Control air** (не editor preview).

### Acceptance (задача 4)

- [ ] Seed/миграция Update; защита delete/rename  
- [ ] Update data ×1; End scene на Update нельзя  
- [ ] Armed = track + ≥2 kf → `update`; иначе Clear+restart  
- [ ] Vars на tag; playhead после Update на старте  
- [ ] Другие OnAir templates на channel не затрагиваются  

---

## Протокол Control ↔ Backend (WebSocket)

Команды `/ws/control`:

```json
{ "type": "take",     "templateId": "...", "channelId": "...", "slotId": "...", "template": {}, "variables": {} }
{ "type": "update",   "templateId": "...", "channelId": "...", "slotId": "...", "template": {}, "variables": {} }
{ "type": "continue", "templateId": "...", "channelId": "...", "slotId": "..." }
{ "type": "clear",    "templateId": "...", "channelId": "...", "slotId": "..." }
```

`slotId` обязателен в rundown; в Templates tab может отсутствовать.

| type | Логика |
| ---- | ------ |
| `take` | Вывести template в эфир (если этого templateId ещё нет OnAir). Запомнить `slotId` владельца UI-статуса. Несколько разных templateId — OK. |
| `update` | **Новая семантика:** запустить Update director + pending variables (replace на tag Update data). Не мгновенный patch variables как раньше. UI OnAir переходит на `slotId` отправителя. |
| `continue` | **Новая команда:** resume всех `stopAndWaitContinue` у этого OnAir instance (строка-владелец OnAir). |
| `clear` | Снять instance с эфира; UI-статус OnAir снимается с владеющего slot. |

Fan-out на `/ws/renderer` — расширить под `continue` и новую семантику `update`.

---

## Сводка PR

```
1. chore/login-logo-3x
2. feature/timeline-actions-model-ui      (schema, +A/-A, Properties, Update seed, tag rules)
3. feature/timeline-actions-runtime      (states, commands, Direction, End scene)
4. feature/control-take-continue-clear   (иконки, continue WS, multi-template stack + unique templateId)
5. feature/template-update-director      (armed Update, новая логика update, миграция)
```

---

## Миграция schema (§8)

- [x] Breaking bump schema + Update на новых templates  
- [x] Старые: добавить Update (+ Update data @ 50), если нет  
- Legacy flat actions → drop / ignore on load  

---

## Зафиксированные решения

- [x] End scene → Pending, Take **active**  
- [x] Start director default Parameter: первый director  
- [x] `-A` = весь cue  
- [x] Scrub не исполняет  
- [x] OnAir: много **разных** templateId; один и тот же — **один** render-instance  
- [x] Playlist: сколько угодно одинаковых template в слотах  
- [x] UI OnAir только у **выданного slot**; остальные слоты с тем же templateId = Pending  
- [x] После `update` с другого слота — OnAir **переходит** на слот-инициатор update  

- [x] Armed Update: ≥1 track **и** ≥2 keyframes; иначе Clear+restart  
- [x] WS: добавить `continue`; `update` — новое поведение (имя сохранить)  
- [x] Resume wait-continue только Continue; резюмит все directors instance  
- [x] `autostart=false` → `stop`  
- [x] `+A` на занятый frame → item в cue  
- [x] Name на marker/cue  
- [x] Update: no delete/rename  
- [x] Старым добавить Update  
- [x] Update data только на Update ×1; **End scene на Update нельзя**  
- [x] Tag default (где можно End scene) = **End scene**  
- [x] Иконки одинаковые в Templates и Rundown  
- [x] Clock не стопается; playhead на pause/stop заморожен  
- [x] Length default = **0**  
- [x] Variables replace all; Update-flow только Control air  

---

## Остались ли вопросы / конфликты?

### Конфликты сняты

- Стек разных templates OK; один `templateId` — один render-instance.  
- UI OnAir — **slot-aware**: только выданный слот.  
- Take/`update` с другого слота (тот же `templateId`) → OnAir **переходит** на слот-инициатор; прежний → Pending.

### Неблокеры

| Тема | Дефолт в ТЗ |
| ---- | ----------- |
| Pause Length = 0 | мгновенный resume / no-op pause |
| End scene во время Update | разрешён → Pending у владеющего slot |
| `command: null` | silent skip |

**Блокеров нет** — можно идти в реализацию по нарезке PR.

---

## Ссылки на код (as-is)

- Login: `frontend/src/pages/LoginPage.tsx`  
- Timeline +K/-K: `frontend/src/editor/panels/TimelinePanel.tsx`  
- Legacy actions: `runtime/src/schema.ts`, `shared/template.schema.json`  
- `runActions` stub: `runtime/src/domRenderer.ts`  
- Control: `frontend/src/control/RundownTab.tsx`, `TemplatesTab.tsx`  
- DataElements: `backend/src/routes/dataElements.js`  
- WS: `backend/src/routes/ws.js`  
- On-air: `backend/src/onair.js`  
