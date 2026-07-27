# Ветка `sergey-v1` — контекст и changelog

> Сводка работы Sergey + агент Cursor на ветке `sergey-v1`.  
> Обновлено: **24 июля 2026**.

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
| `1532b58` | 10 июл | `big change Control page, add dataelements, change db` |
| `dfe1dd9` | 10 июл | `docs(sergey-v1): fix commit hash in session context` |
| `468376c` | 10 июл | `big change Control page, add dataelements, change db` (sidebar resize + DE delete UX) |
| `ddb0186` | 10 июл | `docs(sergey-v1): fix commit hash in session context` |
| `d60b80a` | 14 июл | `add text parameters` (text transform + drop shadow + login logo) |
| `4075a3c` | 14 июл | `add crawl` (Crawl layer + collapsible props + Multitext/TextFile) |
| `fdfe6e9` | 17 июл | `feat(timeline): Action cues + Update-flow on sergey-v1` |
| `9fbbd07` | 17 июл | `fix(control): make timeline Actions work on air` |
| `1dafb0b` | 17 июл | `fix(editor): honor stop/wait Actions + Continue button` |
| `730bc45` | 17 июл | `fix(editor): ignore endScene; Stop freezes playhead in place` |
| `58c381e` | 17 июл | `add actions, continue,update` (perf + classic playback gate + session context) |
| `05b4fe0` | 21 июл | `fix perfomance issue` (SDI smooth + web/editor fractional playback) |
| `ee6d30c` | 24 июл | `video on timeline, UE path` |

---

## 24 июля 2026 — Video on timeline + Unreal VS path + nav collapse

Крупный пакет: клипы видео на таймлайне (editor + runtime), ремонт постеров MAM, сворачиваемая навигация, foundation Unreal / Virtual Studio (`bg_vs_engine` + UE Templates).

### A) Editor / timeline UX

| # | Изменение |
|---|---|
| 1 | Сворачивание директора скрывает и **Actions**, и треки (раньше Actions всегда были видны) |
| 2 | Директор **Update** при открытии шаблона свёрнут по умолчанию |
| 3 | Левая панель (Templates / UE Templates / Control / Settings): кнопка collapse → только иконки; состояние в `localStorage` `titulus.nav.collapsed.<userId>` |

### B) Video clip on timeline

При выборе видео из мини-MAM:

- Клип кладётся на директор **default** как трек `videoProgress` (0→1), длина = длительность файла в frames шаблона (`durationSec * timeline.fps`).
- Клип-бар двигается целиком (без trim); трек можно перенести на другой директор (существующий DnD).
- **Loop** по умолчанию `false`; при `loop=true` — иконка ∞ на треке (бар всё равно = натуральная длина).
- Параметр **At the end**: `lastFrame` \| `empty` (при Loop UI disabled).
- Schema: `VideoLayer.endBehavior`, `VideoLayer.durationFrames`; animatable `videoProgress`.

**Файлы:** `frontend/src/editor/videoTimeline.ts`, `TimelinePanel.tsx` (`VideoClipLane`), `PropertiesPanel.tsx`, `factories.ts`, `shared/template.schema.json`, `runtime/src/schema.ts`.

### C) Video playback runtime (scrub vs Play) + perf

Требования: без Play клип не играет; scrub показывает кадр playhead; Play + playhead дошёл до start → воспроизведение.

1. Первый подход (seek каждый paint) дал **1–2 fps** в editor и на SDI — HTML/CEF seek = worst-case decode.
2. **Итог:** hybrid в `domRenderer.syncVideoClipPlayback`:
   - **Scrub / stop** → `pause` + seek к кадру playhead
   - **Transport playing** → native `play()` free-run; resync только при jump playhead (>2.5f) или drift >150ms
3. `beginEditorPlayback` теперь **всегда** ставит `playing=true` (и classic path); cleanup classic вызывает `endEditorPlayback()` (pause videos).
4. `getLayerPropTrackRange()` в `timeline.ts` — окно клипа из compiled track.

**Deploy:** `cd runtime && npm run build` + restart channel/engine.

### D) MAM posters (пропавшие табнейлы)

- Постеры: `$TITULUS_DATA/uploads/Video/<name>_poster.jpg`, поле `media_assets.poster_path`.
- **Причина пропажи:** `refresh` пропускал уже существующие DB rows → missing/corrupt poster не чинился.
- **Fix:** `MediaLibrary.refresh` → `_repairMissingPosters`; `POST /api/media/:id/regenerate-poster`; Refresh в UI показывает `repaired N poster(s)`.
- Skip `*_poster.jpg` при scan Video folder (не удалять как unsupported).

### E) Unreal / Virtual Studio path (`bg_vs_engine`)

ZeroDensity-aligned split: HTML channels без изменений; VS = отдельный render backend.

| ZD | Titulus |
|---|---|
| Engine / Channel I/O | Settings channel `render_backend=unreal` |
| Form / Blueprint template | **UE Templates** `/ue-templates` |
| Rundown playout | Control slots `kind: 'ue'` + `UePlayoutPanel` |
| RealityKeyer + SDI | `bg_vs_engine` chroma + DeckLink OUT |

**GPU Gate:** `docs/GPU_GATE_unreal_vs.md` — APPROVED **только** для Unreal VS profile; HTML/`bg_engine` остаётся CPU-only.

**Engine:** новый target `bg_vs_engine` (`engine/src/vs/*`): producers (file / NDI / DeckLink IN), chroma keyer, compositor, consumers (null/pipe/decklink). Supervisor: `run-vs-channel.sh`, `run-engines.sh` ветвит по `render_backend`.

**Backend:** `ue_templates` + channel fields (`render_backend`, `unreal_endpoint`, `unreal_ndi_source`, camera DeckLink in); routes `/api/ue-templates`, `/api/unreal/*` (Remote Control proxy).

**Frontend:** nav UE Templates, `UeTemplatesPage`, Settings Unreal fields, Control UE playout.

**Docs:** `docs/unreal-vs-mode.md`, RUNBOOK notes, `bench/run-vs-bench.sh`.

### Ключевые файлы (24 июля)

| Area | Path |
|---|---|
| Video clip helpers | `frontend/src/editor/videoTimeline.ts` |
| Timeline UI | `frontend/src/editor/panels/TimelinePanel.tsx` |
| Video props / MAM select | `frontend/src/editor/panels/PropertiesPanel.tsx`, `media/MediaSourcePicker.tsx` |
| Video runtime | `runtime/src/domRenderer.ts` (`syncVideoClipPlayback`) |
| Track range | `runtime/src/timeline.ts` (`getLayerPropTrackRange`) |
| Schema | `runtime/src/schema.ts`, `shared/template.schema.json` |
| Poster repair | `backend/src/mediaLibrary.js`, `backend/src/routes/media.js` |
| Nav collapse | `frontend/src/components/AppShell.tsx` |
| VS engine | `engine/src/vs/*`, `engine/run-vs-channel.sh`, `engine/CMakeLists.txt` |
| UE API / UI | `backend/src/routes/ueTemplates.js`, `unreal.js`, `frontend/src/pages/UeTemplatesPage.tsx`, `control/UePlayoutPanel.tsx` |
| Gate / ops | `docs/GPU_GATE_unreal_vs.md`, `docs/unreal-vs-mode.md` |

### Чеклист (24 июля)

- [ ] Add video → Choose file → клип на default, save template OK (AJV)
- [ ] Без Play клип стоит; scrub = кадр playhead; Play с start клипа = плавное воспроизведение (editor + SDI)
- [ ] Loop ∞ на треке; At the end lastFrame/empty; clip move без trim
- [ ] Update director collapsed; Actions скрываются со director
- [ ] Nav collapse переживает reload (per user)
- [ ] MAM Refresh чинит missing posters
- [ ] Settings Unreal channel + `run-engines.sh` → `bg_vs_engine`; UE Templates TAKE smoke

---

## 21 июля 2026 — Performance / плавность playback (SDI + web)

После Actions на SDI и в editor/web были рывки. **SDI исправлен первым**, затем доведена плавность editor + `channel.html` (web engine preview).

### Симптомы

- DeckLink: подтормаживания на простых сценах (до fix).
- Editor + web renderer: playhead и preview «дёргаются», SDI после fix — идеально плавный.
- Ожидание: dormant Update / пустые Actions **не должны** менять hot path.

### Корневые причины

1. **`playTimeline` всегда включал Action runtime** из‑за seed `updateData` на Update director → каждый TAKE шёл через тяжёлый per-director state machine вместо `frame++` + `sampleAt`.
2. **Editor:** Zustand playheads на каждом кадре + throttle 15 Hz → playhead рывками; canvas рисовался только **целыми** 50-fps кадрами через 60 Hz rAF.
3. **Web rAF:** integer-only advance — между тиками картинка не двигалась; `sampleAtDirectorLocals` делал `Math.round()` и **убивал** дробную интерполяцию.
4. **`endScene` tag** ошибочно форсил director runtime на SDI (исправлено: tags не включают SM с TAKE).
5. **`collectFiredItems`** — полный перебор cues каждый кадр → заменён бинарным поиском по отсортированным cues.

### Fix (итоговый)

| Область | Решение |
|---|---|
| SDI / air TAKE | `timelineNeedsDirectorRuntime()` — SM только для start/stop/wait/pause; **tags (endScene/updateData) не включают** runtime с TAKE |
| Classic playback | `playTimeline` → `frame++` + `sampleAt`; Update-flow эскалирует SM только при Control UPDATE |
| Action cues | `collectFiredItems` — binary search; classic path — cue check по director local frame |
| Editor canvas | Дробный playhead: `renderDirectorPlaybackFraction()`; Actions на integer frames, paint на rAF |
| Web rAF | После integer tick — paint `frame + frameCarry` (fractional); director path — `renderDirectorPlaybackFraction` |
| Sampling | `sampleAtDirectorLocals` — **без** `Math.round`, clamp 0..duration |
| Editor UI | Playhead CSS transition при Play (~70 ms); store playheads throttle ~15 Hz (не 50 React/sec) |
| Dormant Update | Directors без tracks пропускаются в sample; Update без autostart не крутит transport в classic Play |

### Ключевые файлы (21 июля)

| Area | Path |
|---|---|
| Runtime gate | `runtime/src/schema.ts` (`timelineNeedsDirectorRuntime`) |
| Cue scan | `runtime/src/directorRuntime.ts` (`collectFiredItems`) |
| Playback / rAF | `runtime/src/domRenderer.ts` (`renderDirectorPlaybackFraction`, `startRaf`) |
| Fractional sample | `runtime/src/timeline.ts` (`sampleAtDirectorLocals`) |
| Editor play | `frontend/src/editor/CanvasArea.tsx` |
| Playhead UI | `frontend/src/editor/panels/TimelinePanel.tsx` |

### Deploy / verify

```bash
cd runtime && npm run build   # → backend/public/bg-runtime.js (gitignored)
# restart bg_engine / refresh channel.html + hard refresh editor (Ctrl+Shift+R)
```

- [ ] SDI: простые сцены без Actions — плавно, как до timeline Actions
- [ ] Editor Play: preview без рывков; playhead движется равномерно
- [ ] Web `channel.html?preview=1` — такая же плавность, как editor
- [ ] Сцены **с** stop/wait/endScene — Actions работают; SDI не деградирует
- [ ] После `npm run build` в runtime — свежий `bg-runtime.js` на engine

---

## 17 июля 2026 — Actions + Continue + Update-flow

Крупный пакет: timeline **Action cues**, Continue/wait, Update director + Update-flow на Control, правки editor/air playback и производительности. ТЗ: `docs/tz-timeline-actions-draft.md`.

### Модель Actions (schema / runtime)

- Cue + items (вместо legacy flat `startDirector|stopDirector|setTag`).
- Commands: `startDirector`, `stopDirector`, `stopDirectorAndWaitContinue`, `pauseDirector`, `tag`.
- Tags: `endScene` | `updateData`.
- Защищённый director **Update** (`ensureUpdateDirector`, seed cue `updateData`); armed = tracks + ≥2 keyframes.
- Runtime: `runtime/src/directorRuntime.ts` — per-director play/stop/pause/wait; `TemplateRenderer` исполняет cues при playthrough.
- Schema: `runtime/src/schema.ts`, `shared/template.schema.json`.

### Control / air

- WS: `continue`, renderer → `endScene` / `waitingContinue`.
- On-air: `waitingContinue` в snapshot; Continue только когда waiting.
- Update-flow: Control UPDATE → `startUpdateFlow` → переменные apply на tag `updateData`.
- UI: Take / Continue / Clear в rundown/templates; poll `/api/onair` заменён на **WS push** `{ type: 'onAir', onAir }` (без 500ms poll).
- Корень бага «Actions не на эфире»: устаревший `backend/public/bg-runtime.js` — после runtime всегда `cd runtime && npm run build`.

### Editor

- Action lane на timeline (+A/−A), Properties для cue/items.
- Continue в transport при `waitingContinue`.
- **endScene в editor игнорируется** (air-only); Stop замораживает последний кадр (без чёрного экрана от seek).
- Play: host rAF; при наличии реальных Actions — Action runtime; иначе — classic fractional seek.

### Производительность / плавность (важно)

**Проблема:** пустой Update + seed `updateData` заставлял **каждый** take идти через Action runtime → дёрганье в editor и на DeckLink.

**Fix (17 июл, уточнено 21 июл — см. §21 июля):**
- `timelineNeedsDirectorRuntime()` — Action SM только для start/stop/wait/pause; **tags (endScene/updateData) не включают** runtime с TAKE. Dormant Update **не** форсит тяжёлый path.
- Classic `playTimeline`: `frame++` + `sampleAt` (как до Actions).
- `sampleAtDirectorLocals` пропускает directors без tracks.
- Editor: throttle UI playheads ~15 Hz; atomic `setPlayheads` (+ `directorRel`); rAF accumulator вместо `Math.round`.
- После правок runtime: **обязательно** `npm run build` + restart engine/channel.

### Ключевые файлы (17 июля)

| Area | Path |
|---|---|
| ТЗ | `docs/tz-timeline-actions-draft.md` |
| Schema / gate | `runtime/src/schema.ts` (`timelineNeedsDirectorRuntime`) |
| Director SM | `runtime/src/directorRuntime.ts` |
| Renderer | `runtime/src/domRenderer.ts` |
| Air client | `runtime/src/channelClient.ts` |
| Timeline sample | `runtime/src/timeline.ts` |
| Editor play | `frontend/src/editor/CanvasArea.tsx`, `store.ts` |
| Timeline UI | `frontend/src/editor/panels/TimelinePanel.tsx`, `PropertiesPanel.tsx` |
| Control | `frontend/src/control/RundownTab.tsx`, `pages/ControlPage.tsx`, `core/controlWs.ts` |
| Backend | `backend/src/onair.js`, `backend/src/routes/ws.js` |

### Проверка (Actions)

- [ ] Шаблон **без** Action-команд: Play в editor и TAKE на DeckLink — плавно (classic path)
- [ ] `stopDirectorAndWaitContinue` → Continue в editor и Control
- [ ] Tag `endScene` на air → clear; в editor — play не гасит canvas
- [ ] Stop mid-play — кадр застывает, не чёрный экран
- [ ] Armed Update + Control UPDATE → Update-flow на `updateData`
- [ ] После `cd runtime && npm run build` — Actions на channel.html/engine

---

## 14 июля 2026 (вечер) — Crawl layer + collapsible props + Multitext/TextFile

Новый слой **Crawl** (бегущая строка), сворачиваемые группы Properties, переменные Multitext/TextFile, Use File / Parse, runtime-анимация ticker/carousel.

### Collapsible Properties

- Компонент `Section` в `form.tsx` — группы свойств сворачиваются (Layer / Size / Position / type-specific).
- Применяется ко всем типам слоёв в инспекторе.

### Слой Crawl

- Иконка в дереве: «T» с полосками движения (left→right).
- Default size как у Text; Content по умолчанию `New text1\nNew text2`.
- При add создаётся dedicated director **Crawl** + трек `crawlProgress` (label **Crawl**).
- Длительность директора = f(speed, объём строк, pause, type/directions/align).

**Defaults (актуальные):**
| Prop | Default |
|---|---|
| Type | `ticker` |
| In / Out | `right` / `left` |
| Speed | `5` (= 60 px/s × 5) |
| Pause(frame) | `0` (кадры, не секунды) |
| Separator | `none` (X) |
| Anim | `batch` |

### Content + Use File

- Multiline Content (resize по вертикали); bind к Multitext / TextFile / Text.
- **Use File** + filepath + **Parse** (upload URL `/uploads/...` или allow-listed path через `POST /api/files/read`).
- Maximum text length (per-line).
- Пробелы в Content и Sep text **сохраняются** (`white-space: pre`).
- После Parse Content сразу обновляет анимацию (даже при включённом Use File).
- Перед **TAKE** (Templates → PLAY и rundown/DataElement): если Use File включён — Parse выполняется автоматически; ошибка файла → TAKE не уходит.

### Pause / motion

| Режим | Поведение |
|---|---|
| `pause = 0` | Лента всех строк; Continuous — бесшовный marquee (контент дублируется) |
| `pause > 0` | Построчно: въезд → hold N кадров → выезд → следующая строка (Carousel и Ticker) |
| Continuous + pause>0 | У последней строки hold = 0 → первая сразу без паузы на стыке |

Play таймлайна крутит Crawl director → текст едет по In/Out.

### Align + Shadow (Crawl Text style)

- **Shadow** (Color/X/Y/Blur) применяется **сразу** в preview (стиль обновляется каждый paint, не только при смене текста).
- **Align** учитывается только:
  - всегда в **Carousel**;
  - в **Ticker** только при **Pause>0** (rest-позиция hold);
  - Ticker + Pause=0 — Align игнорируется.

### Variables

- **Multitext** — multiline value (editor + Control).
- **TextFile** — Upload TextFile (`.txt`), по аналогии с image.

### Backend

- `backend/src/routes/files.js` — `POST /api/files/read` (roots: `TITULUS_DATA` + `TITULUS_FILE_ROOTS`).
- Upload `*.txt` разрешён в media/uploads pipeline.

### Offline smoke test

```bash
cd runtime && npm test   # esbuild bundle, без npx/tsx/сети
```

### Ключевые файлы (Crawl)

| Area | Path |
|---|---|
| Schema TS | `runtime/src/schema.ts` (`CrawlLayer`, Multitext/TextFile, normalize) |
| Schema JSON | `shared/template.schema.json` |
| Motion | `runtime/src/crawl.ts` (schedule, pause, align, spaces) |
| Renderer | `runtime/src/domRenderer.ts` (`paintCrawl`) |
| Editor UI | `frontend/src/editor/CrawlProperties.tsx` |
| Timeline helpers | `frontend/src/editor/crawlTimeline.ts` |
| Parse/TAKE | `frontend/src/core/crawlFile.ts` |
| Store / factory | `frontend/src/editor/store.ts`, `factories.ts` |
| Collapsible Section | `frontend/src/components/ui/form.tsx` |
| Files API | `backend/src/routes/files.js` |
| Smoke | `runtime/test/crawl-smoke.mjs`, `crawl-smoke-entry.ts` |

После runtime-правок: `cd runtime && npm run build` + hard refresh редактора.

### Проверка (Crawl)

- [ ] Add Crawl → director Crawl + трек Crawl; default Ticker in=right out=left
- [ ] Play → текст едет; Pause(frame)>0 → построчный enter/hold/exit
- [ ] Continuous → стык last→first без паузы; pause=0 → бесшовная лента
- [ ] Parse при Use File → Content + анимация сразу; TAKE с Use File парсит файл
- [ ] Shadow Color/X/Y/Blur сразу; Align только Carousel или Ticker+Pause>0
- [ ] Пробелы в Content / Sep text видны; `cd runtime && npm test` → ALL OK

---

## 14 июля 2026 — Text style: transform + drop shadow; Login logo

Редактор: свойства текстового слоя; login: брендинг.

### Text transformation (слой Text)

В инспекторе **Text style** — блок **Text transformation**, 4 взаимоисключающие кнопки (default **X**):

| Кнопка | Mode | Поведение |
|---|---|---|
| X | `none` | текст как есть |
| AA | `uppercase` | верхний регистр |
| Aa | `titlecase` | каждое слово: первая буква upper, остальные lower |
| aa | `lowercase` | нижний регистр |

Применяется к уже resolved content (литерал **или** binding из переменной) в `@titulus/runtime` (`applyTextTransform` → `domRenderer` при paint).

### Drop Shadow (Text / Clock style)

- При выключенном checkbox параметры тени **disabled** (Color / X / Y / Blur).
- При включении доступны:
  - **Color** — color picker как у fill, default `#000000`
  - **X** / **Y** — offset px, default `1` / `1`
  - **Blur** — default `0`
- Schema: `dropShadowOffsetX` / `dropShadowOffsetY` (вместо единого `dropShadowDistance`; legacy distance soft-migrate → Y, X=0).
- `normalizeTextStyle` / `normalizeTemplateTextStyles` при load в editor store.

### Файлы

| Area | Path |
|---|---|
| Schema TS | `runtime/src/schema.ts` (`TextTransformMode`, offsets, normalize/apply) |
| Schema JSON | `shared/template.schema.json` |
| Renderer | `runtime/src/domRenderer.ts` |
| Properties UI | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Defaults | `frontend/src/editor/factories.ts` |
| Load migrate | `frontend/src/editor/store.ts` |
| Number/Color disabled | `frontend/src/components/ui/form.tsx` |

После runtime-правок: `cd runtime && npm run build` (обновляет gitignored `backend/public/bg-runtime.js`).

### Login page

- Логотип `frontend/public/titulus-logo.png` над формой.
- Размер логотипа **560px** (2× от 280).
- Форма по вертикальному/горизонтальному центру экрана; логотип `absolute` над формой (`bottom-full`), фон страницы — стандартный `bg-bg` (~`#0d0e13`).
- UI: `frontend/src/pages/LoginPage.tsx`.

### Проверка

- [ ] Text layer: X / AA / Aa / aa меняют preview и эфир (в т.ч. content из variable)
- [ ] Drop shadow off → Color/X/Y/Blur недоступны; on → CSS `text-shadow` в preview
- [ ] Старый шаблон с `dropShadowDistance` открывается без ошибок (migrate)
- [ ] `/login` — логотип сверху, форма по центру экрана

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
| DataElements | Все DE; sort Name/Updated; trash на строке; multi-select; DnD → slots |

Active rundown сохраняется при смене mode (нужен как DnD target).

### Sidebar resize

- Левая колонка (Rundowns / Templates / DataElements) **ресайзится** за правый край (`role="separator"`, `cursor-ew-resize`).
- Диапазон ширины: **180–520px** (default 250).
- Persist: `localStorage` `titulus.control.sidebarWidth`.
- Layout: `flex` (sidebar + center `flex-1` + right `380px`), вместо фиксированного `grid-cols-[250px_1fr_380px]`.

### DataElements — удаление и multi-select

- Иконка **корзины** на каждой строке → `DELETE /api/data-elements/:id` (после confirm).
- **Shift+click** — range-select по текущему порядку списка (якорь = последний обычный click).
- **Delete / Backspace** (не в INPUT) при выделенных DE → тот же confirm dialog.
- Confirm modal: Delete / Cancel; **Enter** подтверждает, **Esc** отменяет.
- После удаления: список обновляется; Variables сбрасывается, если открытый DE удалён.
- Trash не стартует DnD (`stopPropagation` на `pointerDown`/`click`); drag — с имени строки.

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
| Rundown UI | `frontend/src/control/RundownTab.tsx` (resize, DE multi-select/delete, DnD) |
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
- [ ] Сайдбар тянется за правый край; ширина переживает reload
- [ ] Корзина / Delete / Shift+click → confirm; Enter подтверждает удаление DE

---

## 10 июля 2026 — Templates EDITOR | PLAY; Control = rundowns

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
| Properties / Scale / Text style | `frontend/src/editor/panels/PropertiesPanel.tsx` |
| Crawl | `frontend/src/editor/CrawlProperties.tsx`, `crawlTimeline.ts`, `runtime/src/crawl.ts` |
| Crawl Parse/TAKE | `frontend/src/core/crawlFile.ts`, `backend/src/routes/files.js` |
| Login | `frontend/src/pages/LoginPage.tsx`, `frontend/public/titulus-logo.png` |
| UI forms | `frontend/src/components/ui/form.tsx` (`PropertyField`) |
| Group bbox (runtime) | `runtime/src/groupBounds.ts`, `domRenderer.ts`, `transform.ts` |
| Media library | `frontend/src/editor/media/*`, `backend/src/mediaLibrary.js` |
| Canvas | `frontend/src/editor/CanvasArea.tsx` |
| Store | `frontend/src/editor/store.ts` |
| Factories | `frontend/src/editor/factories.ts` |
| Timeline | `frontend/src/editor/panels/TimelinePanel.tsx`, `timelineTracks.ts` |
| Timeline runtime | `runtime/src/timeline.ts`, `directorRuntime.ts`, `shared/template.schema.json` |
| Actions / Update | `docs/tz-timeline-actions-draft.md`, `runtime/src/schema.ts` (`timelineNeedsDirectorRuntime`) |
| UI forms | `frontend/src/components/ui/form.tsx` |
| Control / Rundowns | `frontend/src/control/RundownTab.tsx`, `frontend/src/pages/ControlPage.tsx` |
| Control WS | `frontend/src/core/controlWs.ts` (onAir push) |
| On-air / WS hub | `backend/src/onair.js`, `backend/src/routes/ws.js` |
| Control Variables | `frontend/src/control/ControlVariablesPanel.tsx` |
| DataElements | `backend/src/dataElementsDb.js`, `backend/src/routes/dataElements.js` |
| Templates EDITOR + PLAY | `frontend/src/pages/TemplatesPage.tsx`, `frontend/src/control/TemplatesTab.tsx` |
| Control shared UI | `frontend/src/control/controlShared.tsx` |
| App shell | `frontend/src/components/AppShell.tsx` (nav collapse per-user) |
| Variables | `frontend/src/editor/panels/VariablesPanel.tsx` |
| Video clip timeline | `frontend/src/editor/videoTimeline.ts`, `TimelinePanel.tsx` (`VideoClipLane`) |
| Video runtime | `runtime/src/domRenderer.ts` (`syncVideoClipPlayback`) |
| Template Data pipeline | `runtime/src/dataPipeline.ts`, `frontend/src/core/prepareTemplateData.ts`, `frontend/src/editor/panels/DataPanel.tsx` |
| MAM posters | `backend/src/mediaLibrary.js` (`_repairMissingPosters`) |
| Unreal VS | `engine/src/vs/*`, `docs/unreal-vs-mode.md`, `docs/GPU_GATE_unreal_vs.md` |
| UE Templates | `frontend/src/pages/UeTemplatesPage.tsx`, `backend/src/routes/ueTemplates.js` |

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
- VS engine: `cmake --build engine/build --target bg_vs_engine`; см. `docs/unreal-vs-mode.md`.

---

## Чеклист проверки

**Templates / Control:**
- [ ] `/templates` — EDITOR по умолчанию; PLAY = бывший Control Templates (TAKE/UPDATE/CLEAR)
- [ ] `/control` — channel-scoped rundowns; sidebar Rundowns/Templates/DataElements; Variables; no auto-create rundown
- [ ] DataElements в `$TITULUS_DATA/app.db-dataelements`; cascade при delete template
- [ ] Control sidebar resize (правый край); DE trash / Shift+click / Delete + confirm (Enter)
- [ ] `/ue-templates` + Unreal channel Settings; Control UE playout / rundown `kind:ue`

**Editor:**
- [ ] Ctrl/Cmd+drag копирует слой/группу в дереве
- [ ] Группа в группу; drop выше первой / ниже последней развёрнутой группы
- [ ] Scale lock (Link2); поля Properties шире на 20px
- [ ] Scale на engine/SDI совпадает с редактором (`ec8e872`)
- [ ] Delete на строке дерева удаляет элемент
- [ ] Axis center группы — crosshair двигается, дети на месте
- [ ] Rotation группы — вокруг выбранного axis center
- [ ] Drag в/из группы — координаты в Properties не пересчитываются
- [ ] Text: Text transformation (X/AA/Aa/aa) + Drop shadow Color/X/Y/Blur
- [ ] Crawl: Ticker/Carousel, Pause(frame), Parse/Use File, Align rules, shadow live
- [ ] Login: логотип 560px над формой; форма по центру
- [ ] Actions: без команд — classic smooth path; wait/Continue; endScene air-only; Stop freeze
- [ ] SDI + editor + web preview — плавность без рывков (см. §21 июля)
- [ ] Video clip on timeline: place/move/∞/At the end; scrub frame-accurate; Play free-run (не seek/frame)
- [ ] Update collapsed by default; Actions collapse with director
- [ ] Nav icon-only collapse persists per user
- [ ] MAM Refresh repairs missing video posters
- [ ] После runtime-правок: `cd runtime && npm run build` + restart channel/engine

**Data:**
- [ ] `ls -la /var/lib/titulus/` — `app.db`, `uploads/`
- [ ] Шаблон + канал переживают reboot

---

## Следующие шаги

1. PR `sergey-v1` → `main` (merge commit): media library + timeline v2 + video clips + Unreal VS + **Data pipeline**.
2. Ручная проверка timeline (чеклисты v2 + bugfixes + video clip §24 июля).
3. Ручная проверка Data pipeline (parse file, media token, video clip from data).
4. Проверить axis center + groups на шаблонах с вложенностью и rotation.
5. DeckLink `EnableVideoOutput` — валидация на железе.
6. Drag группы на canvas (сейчас только layers).
7. Unreal VS: HW validation chroma + NDI + Remote Control TAKE; GPU key path if CPU chroma insufficient.

---

## Предпочтения

- Общение на русском.
- Ветка `sergey-v1`, коммиты по запросу.
- Короткие commit messages.

---

## 24 июля 2026 — Template Data pipeline (parse file)

Designer-owned pipeline: файл → parse → select row → map → variables. Control **не** выбирает строку.

### Контракт

- `Template.data?: TemplateData` (`version: 1`, `sources[]`, `pipelines[]`, `runOn`, `onError`)
- Variable: `drivenBy`, `exposed` (driven скрыты в Control, пока `exposed !== true`)
- Media в файле: **`asset:<uuid>`** (или URL/`/uploads/…`), **не** displayName
- Schema: `shared/template.schema.json` + `runtime/src/schema.ts`
- Runtime: `runtime/src/dataPipeline.ts` — `runTemplateData`, parse lines/delimited/kv/json, select, map, mediaResolve
- Smoke: `cd runtime && npm test` (crawl + data-pipeline)

### Frontend wiring

| Area | Path |
|---|---|
| Pre-TAKE helper | `frontend/src/core/prepareTemplateData.ts` (`prepareTemplateForAir`, readFile, resolveMedia) |
| TAKE/UPDATE | `TemplatesPage.tsx`, `RundownTab.tsx` |
| Control hide driven | `ControlVariablesPanel.tsx`, `VariableValues.tsx` + `isVariableExposed` |
| Editor Data tab | `frontend/src/editor/panels/DataPanel.tsx` |
| Variables driven/exposed | `VariablesPanel.tsx` |
| Store | `ensureTemplateData` / `setTemplateData` / `patchTemplateData` |
| Preview + video clips | `CanvasArea.tsx` |
| Image/Video bind `{ }` | `PropertiesPanel.tsx` (`BindableMediaSrc`) |
| MAM Copy token | `MediaPickerModal.tsx`, `MediaFileInfo.tsx` → toast **token copied** |
| Inspector resize | `EditorPage.tsx` — правая панель 260–640px |
| Columns input | DataPanel `ColumnsInput` — любое число столбцов, trailing comma OK |
| `/api/files/read` | `.txt` + `.json` (`backend/src/routes/files.js`) |

### Video через Data → timeline

- После resolve video src создаётся/обновляется `videoProgress` clip (`ensureVideoClipsForVariables` / `planVideoClipsForVariables` в `videoTimeline.ts`).
- Длительность из MAM; **start frame сохраняется**, если файл/индекс строки сменился.
- То же на TAKE через `prepareTemplateForAir`.

### UX Data (Editor)

1. Variables → типы text/image/video (+ `drivenBy` / Show in Control).
2. Data → Enable → source (textfile/inline) + format + columns.
3. Pipeline → select (`first`/`index`/`byKey`/…) + map колонка → variable (`as: image|video|text`).
4. Layer Image/Video → `{ }` bind к переменной.
5. В `.txt`: `name|title|photo` с `asset:<uuid>` (Copy из MAM).

### Чеклист

- [ ] Data tab: source + pipeline + Preview pipeline
- [ ] Columns: `a,b,c,d,…` без потери запятой
- [ ] Control не показывает driven vars
- [ ] Copy в MAM → toast «token copied» + clipboard
- [ ] Image/Video `{ }` bind
- [ ] Video из data → track на timeline; сдвиг start; смена row → start тот же
- [ ] Inspector шириной тянется
- [ ] TAKE с data file + media resolve

---

## 27 июля 2026 — Template folders, translateZ (2.5D), UI polish, validation

### Template folders (one-level)

- Backend: `template_folders` + `templates.folder_id` (`backend/src/db.js`, migration `ensureTemplateFolders`)
- REST: `backend/src/routes/templateFolders.js` → `/api/template-folders`
- Templates REST: `folderId` на create/update/list (`?folderId=`, `__none__` = unfiled)
- Frontend API: `api.templateFolders.*`, `folderId` на summaries
- **Templates page:** левая колонка папок, `<All>`, `+` Create new folder, DnD шаблонов в папку (и на `<All>` — снять с папки)
- Новый шаблон без папки при `<All>`; в выбранной папке — создаётся в ней
- Сортировка: **Modified / Name** + кнопка направления (localStorage `titulus.templates.sortBy/sortDir`)
- View toggle: icons / list; pencil rename слева от copy
- **Control → Templates:** dropdown папок (default `<All>`)
- **Control → DataElements:** dropdown папки + dropdown шаблонов → фильтр DE

### translateZ (ось Z, 2.5D depth)

- `Transform.z` (px) — CSS `translateZ`; schema + `ANIMATABLE_PROPS` + timeline track `translateZ`
- `runtime/src/transform.ts`: `translateZ(z)` в цепочке; `transformHas3D` true при `z ≠ 0`
- `normalizeTransform` / `normalizeTemplateTransforms` — legacy templates `z: 0`
- UI: Properties → Position → **Z** (рядом с X/Y)
- `maskGeometry.ts`: учёт Z в projected clip-path
- **Пересборка runtime обязательна:** `cd runtime && npm run build` + restart backend

### Rundown / Continue

- Slot labels: DE → крупно имя DE, мелко template; direct template → `<template>` / имя
- Continue после Update (2-й dataelement): `startUpdateFlow` re-emit waiting; `applyUpdate` clears `waitingContinue`; optimistic patch сохраняет поля on-air

### Template validation (Save)

- `/api/templates/validate` → **200** `{ valid, errors }` (не 422)
- Подробные сообщения: `path: message` в toast + `console.warn`
- `templateValidationErrorPayload` — summary в message для PUT
- **Restart backend** после schema changes (иначе `z` rejected как unknown property)

### Timeline UX

- Zoom +/- центрируется на **global playhead** (`TimelinePanel.tsx`, `pendingScrollLeft` + `useLayoutEffect`)

### Backend fix (dev-start)

- Роут `templateFolders` был подключён без `templateFoldersDao` в `db.js` → backend crash; восстановлен DAO + migration

### Файлы (ключевые)

| Area | Path |
|---|---|
| Folders DAO | `backend/src/db.js` |
| Folders routes | `backend/src/routes/templateFolders.js` |
| Validation | `backend/src/templateValidation.js`, `frontend/src/pages/EditorPage.tsx` |
| translateZ | `runtime/src/schema.ts`, `transform.ts`, `maskGeometry.ts`, `PropertiesPanel.tsx` |
| Templates UI | `frontend/src/pages/TemplatesPage.tsx` |
| Control filters | `frontend/src/control/RundownTab.tsx` |
| Timeline zoom | `frontend/src/editor/panels/TimelinePanel.tsx` |

### Чеклист

- [ ] `./dev-start.sh` поднимается (backend healthy)
- [ ] Templates: folders, DnD, sort, list/icons, rename
- [ ] Control: folder filters Templates + DataElements
- [ ] Editor: Z разносит tilted layers; Save старых шаблонов OK после backend restart
- [ ] Continue после Update на 2-м dataelement
- [ ] Timeline zoom in/out держит playhead в центре viewport
