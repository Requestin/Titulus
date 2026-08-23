# Phase 21 — New Designer Merge

**Статус:** DONE — capabilities нового designer на current `main`; Unreal/VS исключены; 15/60 min soak вне scope
**Дата открытия:** 2026-08-21
**Дата закрытия:** 2026-08-23
**База закрытия:** `origin/main` @ `4dfa8a5`
**База открытия:** `origin/main` @ `91a5563`
**Источник возможностей designer:** `origin/sergey-v1` @ `7ca8823`
**Запрещённый артефакт:** `feature/sergey-v1-merge`
**Предшественник:** Phase 20 visual closure
**Главный приоритет:** сохранить engine cadence, throughput и SDI-плавность

## 1. Цель фазы

Собрать в `main` единый Titulus строго на current новом engine:

1. текущий CPU-only CEF/DeckLink engine из `main` как единственный foundation;
2. новый template designer и связанные operator workflows из `sergey-v1`;
3. единый `@titulus/runtime`, который одинаково интерпретирует template в
   editor preview, browser/OBS, null/preview engine и DeckLink;
4. обратную совместимость существующих main templates;
5. доказательство, что новый designer не ухудшил Phase 19/20 performance и
   visual pacing.

Phase 21 не является обычным Git merge. Это контролируемый перенос
возможностей на актуальную архитектуру `main`.

### 1.1 Source-документы Сергея

Вместе с кодом Phase 21 использует подготовленные Сергеем материалы:

- [иллюстрированное описание нового интерфейса](../sergey-v1/new-interface.md);
- [Template Editor → Data](../sergey-v1/template-editor-data.md);
- [Crawl — параметры и влияние на анимацию](../sergey-v1/crawl-parameters.md);
- [индекс source-документов](../sergey-v1/README.md).

Иллюстрированное Markdown-описание содержит относительные ссылки на 36 PNG.
Source-документы зафиксированы и больше не редактируются. Они определяют
желаемый UX и semantics, но не отменяют engine-first rule: при расхождении
приоритет имеют current `main`, этот phase plan и измерительные gates.

## 2. Решение после первичного аудита

### 2.1 Прямой merge запрещён

`sergey-v1` ответвилась от `d396ede` 2026-06-30. После общей точки:

- `main`: 219 собственных commits;
- `sergey-v1`: 48 собственных commits;
- diff designer-ветки: 116 files, примерно `+24 243 / -2 291`;
- merge simulation видит 23 файла, изменённых с обеих сторон, включая
  `runtime/src/domRenderer.ts`, `channelClient.ts`, `transform.ts`,
  `frontend/src/editor/CanvasArea.tsx`, `store.ts`, backend DB/media,
  `dev-start.sh`, `run-engines.sh` и CMake.

Ветка Сергея содержит не только UI. Она меняет template schema, timeline
semantics, air protocol, database, media ingest, supervisor и добавляет
отдельный `bg_vs_engine`.

Прямой merge или массовый выбор `theirs` вернёт старые engine assumptions и
удалит важные гарантии `main`:

- `one_tick` deployment default;
- hybrid-safe P-core packing;
- `setsid` supervisor lifecycle и duplicate-start guards;
- FrameLog/BGPACING provenance;
- Class-A composited transform path;
- editor transform preview и исправления teleport/detached outline;
- operator-aware render graph и layered allowlist;
- current browser pacing;
- current WebP video ingest/playback path.

### 2.2 Стратегия

`origin/main` остаётся базой. `origin/sergey-v1` используется как read-only
каталог UX, требований и наблюдаемой semantics, но не как donor
engine/runtime/supervisor. Возможности переносятся небольшими PR; код этих
слоёв всегда заново реализуется поверх current contracts.

Никакой integration branch, созданной с вершины `sergey-v1`, не будет.

Все implementation branches создаются только от свежего `main`. Собирается,
запускается и тестируется только current новый `bg_engine`/runtime/supervisor.
Engine, CMake, channel bootstrap и supervisor из `sergey-v1` не являются
кандидатами на перенос. Нужные designer runtime semantics реализуются поверх
current runtime с сохранением его hot path и instrumentation.

Вся разработка, сборка, software tests и hardware tests Phase 21 выполняются
только на новом i7-14700KF server `requestin@100.73.71.86` в
`/home/requestin/Titulus`. Другие hosts не используются для Phase 21 evidence.

Каждый отдельный живой null/browser/DeckLink/ABBA/closure run длится не более
5 минут. DeckLink 3ch gate длится не более 5 минут. Phase 20 soaks длительностью 15/60
минут находятся вне scope Phase 21 и не запускаются.

Если требуется ручная/визуальная проверка либо UX/semantics допускает
неоднозначное решение, работа останавливается: агент задаёт пользователю один
простой вопрос и ждёт ответа, не выбирая поведение самостоятельно.

### 2.3 Subagent orchestration

Phase 21 должна активнее использовать subagents для research, параллельного
сравнения кода, поиска решений, изолированной реализации и независимого
review. Одну рискованную задачу можно поручать нескольким агентам, чтобы
получить независимые варианты.

Главный агент оркестрирует decomposition, сравнивает выводы, выбирает
архитектуру, проверяет каждый diff и запускает software/hardware gates.
Результат subagent не принимается на веру и не заменяет review, tests,
performance evidence или решение пользователя.

### 2.4 Точные conflict surfaces

Merge simulation пометила `changed in both`:

```text
backend/src/db.js
backend/src/index.js
backend/src/media.js
backend/src/routes/uploads.js
backend/src/routes/ws.js
dev-start.sh
docs/RUNBOOK.md
engine/CMakeLists.txt
engine/README.md
engine/run-engines.sh
frontend/src/core/api.ts
frontend/src/editor/CanvasArea.tsx
frontend/src/editor/factories.ts
frontend/src/editor/panels/LayersPanel.tsx
frontend/src/editor/panels/PropertiesPanel.tsx
frontend/src/editor/store.ts
frontend/src/pages/EditorPage.tsx
runtime/package.json
runtime/src/channelClient.ts
runtime/src/domRenderer.ts
runtime/src/index.ts
runtime/src/maskGeometry.ts
runtime/src/transform.ts
```

Не менее опасны файлы, которые Git способен применить без textual conflict,
но которые меняют protocol: `backend/src/onair.js`, auth/templates/channels/
rundowns routes, `runtime/src/schema.ts`, `shared/template.schema.json`,
`ControlPage.tsx`, `controlWs.ts` и legacy `start.sh`. Каждый из них требует
ручного contract review.

## 3. Неприкосновенные engine-инварианты

Любой пункт ниже имеет приоритет над новой возможностью designer.

1. CPU-only HTML path: CEF OSR + DOM, без GPU/WebGL как primary renderer.
2. DeckLink — master clock; scheduled playback и reference lock сохраняются.
3. DeckLink visual deployment использует `one_tick`, не `accumulator`.
4. Browser/stream timing не смешивается с DeckLink timing.
5. Один process `bg_engine` на channel, unique CEF cache.
6. Hybrid CPU planner оставляет E-cores вне render affinity по default.
7. `dev-start.sh` сохраняет strict ports, process-group lifecycle и
   `dev-stop.sh` graceful teardown.
8. Existing template без новых feature должен пройти неизменённый classic hot
   path.
9. X/Y Class-A transform не возвращается к per-frame `left/top` layout.
10. Global layered compositor остаётся OFF; opt-in — только explicit
    template-id allowlist.
11. Unsupported/new layer автоматически не считается безопасным для layered
    path.
12. Current video ingest с CEF-friendly animated WebP не заменяется старым
    VP8/VP9 WebM pipeline без отдельного доказательства.
13. Editor preview и air используют один runtime и одну transform semantics.
14. Старые templates должны открываться, сохраняться и проигрываться без
    визуального сдвига.
15. Все изменения строятся поверх current нового engine из `main`; старый
    engine/runtime/supervisor Sergey не используется даже временно.

Если интеграция нарушает хотя бы один пункт, работа останавливается до
технического решения. UI-функция не оправдывает деградацию engine.

## 4. Что найдено в `sergey-v1`

### 4.1 Designer и scene editing

Иллюстрации и полный UX walkthrough:
[Новый интерфейс `sergey-v1`](../sergey-v1/new-interface.md).

- Layers переименован в Tree.
- Неограниченная вложенность групп и развитый DnD.
- Multi-select и Copy/delete/reparent элементов в tree.
- Ctrl-drag копирует layer/group subtree вместе с timeline tracks/keyframes.
- Lock защищает объект от canvas edits.
- Pivot/axis-center workflow для layers и groups.
- Position Z (`translateZ`) и 2.5D depth.
- Scale X/Y lock.
- Size presets.
- Numeric inputs поддерживают arrows, horizontal drag, reset и ±45° rotation.
- Resizable/collapsible editor panels.
- Type-specific properties и общий collapse/expand.
- Text transform: none/uppercase/titlecase/lowercase.
- Text/clock/crawl drop shadow.
- Rectangle four-corner gradient с animatable weights.
- LayerID 1–99 для межшаблонного playout stacking.

### 4.2 Timeline v2

Source UX: timeline screenshots/actions в
[иллюстрированном interface guide](../sergey-v1/new-interface.md).

- Directors tree и multi-playhead model.
- Object groups с дочерними property tracks.
- Object summary range и move/stretch всех keyframes.
- Marquee multi-select и совместный drag.
- DnD tracks/objects между directors.
- Action cues с несколькими items.
- `startDirector`, `stopDirector`, `stopDirectorAndWaitContinue`,
  `pauseDirector`, tags `endScene`/`updateData`.
- Action position from end.
- Protected Update director и update-flow.
- Continue/wait state.
- Видео как timeline clip через `videoProgress`.

### 4.3 Новые template/runtime capabilities

Подробные product contracts:
[Template Editor → Data](../sergey-v1/template-editor-data.md) и
[Crawl parameters](../sergey-v1/crawl-parameters.md).

- Crawl/ticker/carousel layer.
- Multitext, textfile и time variables.
- Template Data pipeline:
  source → parse → select → map → variable.
- Sources: text file, JSON file и inline.
- File formats: lines, delimited, key/value, JSON.
- Select: first/last/index/byKey/match/all; выбор record принадлежит designer,
  не operator Control.
- Map types: text/multitext/number/time/image/video.
- Triggers: take/load/update/refresh; error policies: block/keep/clear.
- Media tokens `asset:<uuid>`.
- Time expressions (`today@18:00`, `now+5m`, ISO/epoch).
- Data-driven image/video variables.
- Runtime per-director state machine.

### 4.4 Control/backend workflows

Иллюстрированная структура Templates/Control/Settings:
[Новый интерфейс](../sergey-v1/new-interface.md).

- Template folders, visibility in Control, sort/view modes.
- Template folders одноуровневые; membership хранится как assignment, а не
  filesystem nesting.
- Data Elements and channel-scoped rundowns.
- Rundown может содержать template и Data Element; Data Element хранит
  отдельный набор operator values для template.
- Template locks.
- RBAC users/groups/permissions.
- Media library with tags and poster repair.
- Persistent template thumbnails.
- WS push for on-air state.
- Slot-aware TAKE/UPDATE/CONTINUE/CLEAR.
- Multiple template instances with LayerID collision semantics.

### 4.5 Unreal/VS — сознательно исключённый эксперимент

Ветка также добавляет:

- `bg_vs_engine`;
- file/NDI/DeckLink-input producers;
- chroma keyer/compositor;
- UE Templates и Unreal Remote Control proxy;
- `render_backend=unreal` в channel configuration.

Сергей делал этот путь как эксперимент, а не рабочее решение. Phase 21
сознательно не переносит его в `main`: не добавляются `bg_vs_engine`,
`run-vs-channel.sh`, UE routes/UI, NDI/chroma code и
`render_backend=unreal`. Это не deferred milestone и не будущий подпункт
Phase 21.

## 5. Качество evidence в исходной ветке

`docs/session-sergey-v1-context.md` содержит полезный changelog и ручные
checklists, но не является acceptance proof:

- 141 пункта отмечены как непроверенные;
- только 10 пунктов отмечены выполненными;
- есть два runtime smoke suite для Crawl/Data;
- отсутствуют current frontend transform tests;
- отсутствуют current browser pacing tests;
- отсутствуют engine/DeckLink pacing/provenance tests;
- нет сопоставимого Phase 19/20 ABBA или 1ch/3ch evidence;
- `git diff --check` показывает trailing whitespace;
- root `package-lock.json` пустой и не описывает зависимости workspace.

Фразы «SDI идеально плавный» в branch notes не заменяют current main gates:
они получены до Phase 20 `one_tick`, на другой runtime и без current
provenance.

## 6. Главные конфликтные зоны

### 6.1 `runtime/src/domRenderer.ts` — максимальный риск

Designer-ветка добавляет:

- director runtime;
- action dispatch;
- fractional editor playback;
- Crawl paint;
- video clip control;
- clock/time bindings;
- LayerID z-index;
- gradient rendering.

Current `main` в том же файле содержит:

- editor transform preview;
- Class-A composite position;
- browser frame-fraction pacing;
- FrameLog/BGPACING hooks;
- render graph projection;
- layered compositor capture modes;
- content invalidation fixes;
- mask/performance optimizations.

Sergey `domRenderer.ts` и его fragments не являются donor code. Нужное
observable behavior заново реализуется в current renderer отдельным commit и
отдельным gate.

### 6.2 Transform и Canvas

В `main` после ответвления Сергея появились:

- `transformMath.ts`;
- affine parent-space conversion;
- animation-aware edits;
- world-preserving reparent;
- type-aware reset defaults;
- cache-safe `previewLayerTransform`;
- isolated `gesturePreviewStore`;
- tests на drag/resize/reparent/reset.

В `sergey-v1` этих файлов нет. Поэтому Sergey's `CanvasArea.tsx` и
`store.ts` нельзя использовать как replacement. Pivot/Z/nested tree должны
быть выражены через main transform model.

Sergey drag пишет `left/top/width/height` прямо в DOM, animated edit сначала
меняет base transform, а reparent не компенсирует parent matrix. Кроме того,
delete группы там удаляет всё subtree, тогда как main сохраняет детей и их
world geometry. Это не мелкие конфликты, а несовместимые semantics, которые
нужно решить явно и покрыть tests.

### 6.3 Timeline semantics

Current main timeline — быстрый compiled classic path. Sergey добавляет
per-director state machine. В самой ветке уже была регрессия: dormant Update
заставлял каждый TAKE идти по тяжёлому action path и вызывал рывки.

Целевой дизайн:

- templates без stateful action commands остаются на current classic path;
- tags сами по себе не включают state machine;
- action index компилируется один раз;
- поиск crossed cues — bounded/binary, не full scan per frame;
- editor React state не обновляется 50 раз/с;
- visual sample может быть fractional только там, где это не нарушает
  DeckLink `one_tick` logical identity;
- action fire остаётся на integer frame boundary.

### 6.4 Video timeline против current ingest

Это известный архитектурный блокер, а не обычный merge conflict.
Source UX показывает auto-created timeline clip, Loop и At the end:
[Video section](../sergey-v1/new-interface.md).

Sergey video timeline управляет `<video>`:

- native `play()` во время transport;
- pause/seek во время scrub;
- drift/jump resync;
- VP8/VP9 WebM derivatives.

Current main после Phase 20 использует animated WebP для CEF playback, а
runtime test требует image element. Animated WebP не предоставляет
эквивалентный random-access `currentTime`.

До выбора контракта нельзя обещать полноценный scrub/trim:

1. сохранить WebP и трактовать timeline clip как visibility/start window;
2. сделать отдельный seekable editor proxy, но доказать WYSIWYG;
3. добавить второй air derivative и A/B доказать отсутствие CEF decode
   regression;
4. реализовать frame-indexed decode — самый дорогой вариант.

Default решения Phase 21: current WebP остаётся air path. Video timeline
переносится только после отдельного design/measurement gate.

### 6.5 Media/DB

Обе ветки независимо создали несовместимые `media_assets`:

- `main`: durable source/playback/poster job state, bounded queue, WebP;
- Sergey: MAM folders/tags/relative paths, WebM, repair/refresh workflows.

Желаемый MAM UX (tags, Copy AssetID, Image/Video import/refresh) показан в
[interface guide](../sergey-v1/new-interface.md); token contract
`asset:<uuid>` описан в
[Data guide](../sergey-v1/template-editor-data.md).

Нужна additive DB migration и adapter MAM поверх current media jobs. Нельзя
заменять `db.js` или `media.js`.

MAM catalog должен получить отдельные таблицы (например
`media_library_assets`), а не переиспользовать current `media_assets`, где
хранится durable job/recovery state. Scan/refresh по default read-only:
удаление «неподдерживаемых» файлов из live uploads запрещено.

Thumbnail generation через `bg_engine` не должна конкурировать с live
DeckLink channels. Она должна быть bounded, low-priority, иметь unique cache и
откладываться/отменяться во время hardware gate.

### 6.6 File data source

Sergey `/api/files/read` делает lexical root check. Перед переносом нужны:

- `realpath` check для защиты от symlink escape;
- лимит размера;
- timeout/error taxonomy;
- только auth + отдельное permission;
- explicit `TITULUS_FILE_ROOTS`;
- запрет произвольного UNC/local path в template;
- fixture tests для traversal/symlink/binary/oversize.

Thumbnail path строится только из backend-owned UUID/filename после
нормализации; template-controlled `../` не может попасть в filesystem path.

### 6.7 Gradient/Crawl и layered compositor

Four-corner gradient строится как SVG data URI. Если генерировать его каждый
paint, он способен вернуть raster bottleneck. Требуются cache by effective
gradient state и isolated benchmark.

Crawl меняет визуальный content каждый frame. Он не должен быть ошибочно
promoted как reusable static bitmap. Пока classifier не доказан:

- Crawl → whole-template/live fallback;
- animated gradient → live fallback;
- data/time-driven content → invalidation only on actual value change;
- новые types не добавляются в allowlist автоматически.

### 6.8 Supervisor/engine

Sergey `run-engines.sh` основан на старом sequential logical-core allocator и
не содержит current topology planner/`one_tick`. Его merge запрещён.

Unreal/VS code не переносится: `bg_vs_engine`, его CMake target,
`run-vs-channel.sh`, UE/NDI/chroma routes и UI остаются только историческим
экспериментом в source branch. В Phase 21 и `main` их быть не должно.

### 6.9 On-air/WS protocol

Main и Sergey имеют разные wire semantics:

- current `/api/onair` возвращает channel → template IDs;
- Sergey возвращает objects с `templateId`, `slotId`, `waitingContinue`;
- main UPDATE merges live variables, Sergey заменяет их;
- Sergey убирает WS acknowledgement, на котором основан `p20-take` harness.

Нужен versioned/dual-read adapter. ACK, current TAKE helper и старый Control
не удаляются до миграции всех consumers. Merge-vs-replace variables и LayerID
collision фиксируются contract tests, а не выбираются случайно при conflict
resolution.

### 6.10 Data pipeline determinism

[Data source guide](../sergey-v1/template-editor-data.md) уточняет contract:

```text
source → parse records → designer-owned select → map → variable overrides
→ recalculate Crawl/video metadata → TAKE/UPDATE snapshot
```

Operator не выбирает строку в Control. `drivenBy` связывает variable с
pipeline, а `exposed=false` скрывает её от operator. Значения media в файле
резолвятся по `asset:<uuid>`/UUID/URL, не по display name.

Целевой air contract:

- pipeline выполняется до отправки TAKE/UPDATE, не в CEF frame loop;
- один command получает immutable resolved snapshot;
- `runOn` явно определяет trigger;
- `onError=block` действительно не отправляет TAKE;
- `keep/clear` имеют deterministic typed fallback;
- path/URL read имеет allowlist, size/time limits и одинаковый результат вне
  зависимости от браузера operator;
- Preview pipeline использует тот же parser/select/map, что air preparation.

Source options без полного UI (`commentPrefix`, header, `rootPath`, join,
map transforms, `onEmpty`) остаются частью schema и fixtures; UI не должен
терять их при load/save.

### 6.11 Crawl temporal contract

[Crawl source guide](../sergey-v1/crawl-parameters.md) задаёт observable
semantics:

- ticker движется по X, carousel по Y;
- `speed=1` соответствует примерно 60 px/s;
- `pause` измеряется в frames;
- `pause=0` — strip, `pause>0` — enter/hold/exit per line;
- batch выполняет один проход, continuous формирует бесшовный период;
- separator text/image входит в длину периода;
- max length режет каждую строку до schedule calculation;
- duration зависит от content, box, font size, directions, speed, pause,
  separator, fps и active align;
- изменение data/variable content до TAKE/UPDATE пересчитывает duration;
- `fromEnd` action остаётся привязанным к пересчитанному концу director.

Реализация может отличаться от Sergey code, но observable semantics должна
совпасть в editor/browser/DeckLink.

## 7. Целевая архитектура Phase 21

```text
Designer UI
  └─ edits canonical Template vNext
       ├─ schema validation + explicit migration
       ├─ @titulus/runtime editor preview
       ├─ @titulus/runtime browser/channel.html
       └─ current bg_engine CEF OSR
            └─ current one_tick → FrameRing → DeckLink
```

Принципы:

1. Template — data contract, не serialized editor state.
2. Editor-only selection/layout/collapse state не попадает в template JSON.
3. Runtime normalizers не должны молча перемещать geometry.
4. Новые optional поля имеют deterministic defaults.
5. Migration выполняется один раз на load/save boundary, а не каждый frame.
6. Air runtime не импортирует frontend.
7. Frontend не копирует render math из runtime.
8. Backend валидирует тот же schema, который использует editor.
9. Unsupported feature fail-closed: validation error или explicit fallback,
   но не частичный неправильный render.

## 8. Template contract vNext

Первый code PR должен зафиксировать capability matrix и fixtures до UI.

### 8.1 Additive candidates

- text transform/shadow;
- `Transform.z`;
- rect gradient;
- Crawl layer;
- expanded variable types;
- `Template.data`;
- action cue/items;
- video clip metadata;
- template LayerID.

### 8.2 Compatibility rules

- Existing `schemaVersion` без new fields остаётся валиден.
- Missing Z → `0`.
- Missing text transform → `none`.
- Missing shadow → current no-shadow behavior.
- Missing rect mode → solid.
- Existing main layer defaults/anchor сохраняются; Sergey defaults `0,0`
  не применяются молча к новым или загруженным main templates.
- Missing LayerID → documented default, но playout semantics не меняются до
  отдельного LayerID milestone.
- Legacy flat actions должны мигрироваться явно или отвергаться с понятной
  ошибкой; silent drop запрещён.
- New template не сохраняется, если air runtime не умеет все его capabilities.

### 8.3 Fixtures

Нужны versioned fixtures:

1. current `test.json`;
2. current complex `test1.json`;
3. Phase 20 visual fixture;
4. nested groups + pivot + rotation + scale + masks;
5. Z/2.5D + projected mask;
6. text transform/shadow;
7. static и animated four-corner gradient;
8. Crawl ticker/carousel;
9. Crawl pause=0/positive, batch/continuous, separator и dynamic content;
10. multi-director actions/wait/continue/fromEnd;
11. Data pipeline для каждого source/format/select/error mode;
12. Data map text/number/time/image/video и select-all join;
13. video timeline fixture после выбора media contract;
14. two-template LayerID stack.

Для каждого fixture хранится expected normalized JSON и expected capability
classification.

## 9. План интеграции по PR

P21.0–P21.10 закрыты 2026-08-23. Ниже — исторический план, не очередь работ.

Один PR — одна логическая задача. Каждый следующий PR строится от свежего
`main`, в котором уже merged предыдущий milestone.

Для каждого cross-cutting milestone главный агент по возможности:

1. запускает параллельных research/comparison subagents;
2. делегирует независимые code slices агентам без overlap файлов;
3. заказывает отдельный review/regression pass;
4. сам перечитывает diff, разрешает противоречия и выполняет gates.

### P21.0 — Baseline freeze и governance

Baseline evidence завершён на fresh `main` @ `91a5563`: DeckLink x4 — PASS.
P21.0 merged (PR #117).

Scope:

- этот phase document;
- alwaysApply engine-protection rule;
- зафиксировать SHAs main/Sergey/merge-base;
- снять fresh current-main software/hardware baseline;
- сохранить команды и artifact manifest.
- применять subagent orchestration из §2.3 на каждом milestone.

Exit:

- rule активна;
- current tests green;
- i7 1ch/3ch baseline повторяем;
- baseline manifests, telemetry и operator marks сохранены;
- capability inventory, UX checklist и fixture layout зафиксированы;
- immutable old/new JSON fixtures добавляются в P21.1 до первого UI PR.

### P21.1 — Contract inventory и migration harness

Scope:

- capability matrix;
- schema vNext;
- explicit normalizers/migrations;
- old/new fixtures;
- backend/editor/runtime schema agreement tests.

Запрещено:

- менять hot render behavior;
- добавлять UI до готового contract;
- silently dropping unknown fields.

Exit:

- old templates normalize byte-semantically;
- vNext rejects unsupported feature combinations;
- validation errors одинаковы в backend/editor.

### P21.2 — Low-risk designer shell

Source UX: [иллюстрированный interface guide](../sergey-v1/new-interface.md).

Scope:

- Tree label;
- resizable/collapsible panels;
- navigation collapse;
- Templates sort/view;
- in-app delete confirmations;
- visual-only timeline grouping, где schema не меняется.

Exit:

- no runtime/engine changes;
- frontend tests/typecheck/build;
- keyboard/focus/accessibility smoke;
- editor remains responsive on complex template.

### P21.3 — Scene graph, nested groups, pivot и Z

Source UX: Tree/Properties/Axis/2.5D в
[иллюстрированном interface guide](../sergey-v1/new-interface.md).

Scope:

- nested Tree UX;
- copy/delete/reorder;
- pivot controls;
- Scale lock;
- Z property;
- world-preserving reparent.

Implementation:

- main `transformMath.ts` остаётся authority;
- effective transform at playhead — source for edits;
- preview идёт через `previewLayerTransform`;
- no direct `left/top/width/height` DOM writes;
- group bounds are derived, not destructive geometry rewrites.
- projected-mask degenerate guard из main сохраняется при добавлении Z;
- delete-group semantics сохраняет children/world geometry, пока отдельное UX
  решение не будет принято и мигрировано.

Exit:

- existing transform tests preserved;
- new nested/pivot/Z tests;
- drag/resize values update live;
- reset/reparent do not move world geometry;
- mask and outline stay attached at zoom/rotation;
- Class-A does not add layout per tick.

### P21.4 — Timeline v2 editor model

Scope:

- object-track grouping;
- summary range move/stretch;
- multi-select/marquee;
- director DnD;
- per-property tracks.

Сначала UI/store на existing classic timeline semantics. Stateful actions не
включаются в этом PR.

Exit:

- collisions and duplicate-frame moves deterministic;
- undo/redo = one gesture, one history entry;
- no React render storm;
- existing animated transform edit tests pass;
- editor preview and saved keyframes agree.

### P21.5 — Actions, Update и Continue

Source UX: Timeline Actions и Control Continue в
[иллюстрированном interface guide](../sergey-v1/new-interface.md).

Scope:

- cue/items schema;
- director state machine;
- wait/continue;
- updateData/endScene;
- backend WS/on-air propagation;
- Control UI.

Fast-path requirement:

- template без stateful commands вызывает current classic sample path;
- empty/dormant Update costs approximately zero per frame;
- cue scan compiled/bounded;
- tags do not force state machine;
- no 50 Hz Zustand update.
- current WS acknowledgement и Phase 20 TAKE helper сохраняются;
- новый on-air snapshot вводится versioned/compatibly.

Exit:

- action unit/integration tests;
- editor/browser/air semantic parity;
- Stop freezes current image;
- Continue resumes exact director state;
- endScene air-only behavior explicit;
- canonical main templates have no measurable cadence regression.

### P21.6 — Crawl + Data pipeline + time

Source contracts:
[Template Editor → Data](../sergey-v1/template-editor-data.md) и
[Crawl parameters](../sergey-v1/crawl-parameters.md).

Scope:

- Crawl schema/render/editor;
- Data sources textfile/jsonfile/inline;
- formats lines/delimited/kv/json;
- select first/last/index/byKey/match/all;
- map text/multitext/number/time/image/video;
- runOn take/load/update/refresh;
- onError/onEmpty block/keep/clear;
- join, mediaResolve и map transforms;
- driven/exposed variables;
- time expressions;
- hardened file API.

Performance:

- Crawl DOM built once;
- movement uses composited transform;
- no text/layout writes unless content/style changed;
- no per-frame file/network access;
- data pipeline runs only on declared trigger;
- file parsing never occurs in engine hot path.
- runtime-wide `will-change` не включается.
- Crawl speed/pause/duration считаются в template fps, не wall-time;
- dynamic content пересчитывает director до immutable air snapshot.

Exit:

- existing Sergey smoke cases promoted to normal runtime test runner;
- security tests for file API;
- parser/select/map/error-policy table tests;
- Preview pipeline и TAKE дают одинаковые overrides;
- ticker/carousel + batch/continuous + pause/separator temporal fixtures;
- fromEnd action сохраняет расстояние до dynamic Crawl end;
- browser and DeckLink cadence gate on Crawl.

### P21.7 — MAM, folders, thumbnails и media adapters

Source UX/contracts:
[interface guide](../sergey-v1/new-interface.md) и
[Data media tokens](../sergey-v1/template-editor-data.md).

Scope:

- media tags/folders/search;
- template folders;
- thumbnails;
- poster repair;
- `asset:<uuid>` resolution;
- Data Elements if still required by accepted workflow.

Main media jobs remain authority. No WebM rollback.

Exit:

- additive DB migrations on copied old DB;
- upload/restart/recovery tests;
- current WebP alpha/opaque tests;
- MAM scan cannot rename/delete live assets unexpectedly;
- thumbnail worker cannot steal live channel CPU/cache;
- thumbnail IDs/paths не допускают traversal;
- rollback preserves DB and uploads.

### P21.8 — Video timeline design gate

До кода выбрать один из вариантов §6.4 и оформить отдельный decision record.

Exit:

- editor scrub semantics defined;
- air semantics defined;
- derivative format defined;
- alpha/opaque behavior proven;
- 1ch/3ch video template has no stutter;
- WYSIWYG difference отсутствует или explicitly accepted.

### P21.9 — LayerID playout, RBAC и operator closure

Source workflow: разделы Templates/Control/Settings в
[иллюстрированном interface guide](../sergey-v1/new-interface.md).

Scope:

- LayerID schema/UI;
- collision and stack semantics;
- slot-aware on-air state;
- Control mode: Rundowns/Templates/Data Elements;
- channel-owned rundowns с template/Data Element slots;
- Data Element save-as-new и operator variable values;
- on-air list всех active template instances;
- template locks;
- RBAC settings.

Exit:

- multiple templates stack deterministically;
- same LayerID replacement cannot clear unrelated template;
- UPDATE does not reorder layers;
- merge/replace semantics variables задокументированы и совместимы;
- old/new on-air snapshot consumers работают через adapter;
- direct template slot и Data Element slot имеют однозначный label/status;
- несколько Data Elements одного template не создают несколько air instances
  одного `templateId`, а UPDATE передаёт ownership инициирующему slot;
- expired session handling;
- lock heartbeat/recovery;
- permissions enforced backend-side, not only hidden in UI.

### P21.10 — Full integration and hardware closure

Scope:

- all accepted new-designer fixtures;
- old main fixtures;
- browser + null + DeckLink;
- fresh install and controlled restart.

Exit описан в §11.

## 10. Software verification matrix

### 10.1 На каждом PR

```bash
git diff --check

cd runtime
npm ci
npm test
npm run typecheck
npm run build

cd ../frontend
npm ci
npm test
npm run typecheck
npm run build

cd ../backend
npm ci
TITULUS_DATA=/tmp/titulus-p21-backend node --test tests/*.test.mjs

cd ..
node --test tests/*.mjs
```

Если PR касается C++/protocol:

```bash
cmake --build engine/build -j"$(nproc)"
cmake -S engine/tests -B engine/tests/build -DCMAKE_BUILD_TYPE=Debug
cmake --build engine/tests/build -j"$(nproc)"
ctest --test-dir engine/tests/build --output-on-failure
```

### 10.2 Contract tests

- schema JSON and TypeScript agree;
- normalize is idempotent;
- load→save does not alter old geometry;
- unknown capability rejected;
- migration has golden input/output;
- editor-produced JSON passes backend validation;
- runtime consumes exactly the validated JSON.

### 10.3 Editor tests

- drag/resize all handles;
- rotated and nested parent transforms;
- live overlay/inspector;
- resets at base and animated playhead;
- reparent/delete group;
- timeline move/stretch/multi-select;
- undo/redo boundaries;
- no state mutation during transient preview.

### 10.4 Visual parity

For each fixture:

1. editor at selected frame;
2. browser channel at same logical frame;
3. engine preview/null capture;
4. DeckLink where temporal behavior matters.

Static acceptance:

- exact dimensions/order/masks;
- no missing media/fonts;
- pixel-exact where possible;
- otherwise justified SSIM threshold and reviewed diff image.

Temporal acceptance:

- same director local frames;
- same action boundaries;
- same variable/data resolution;
- same video/crawl phase;
- no editor-only behavior.

## 11. Engine/performance acceptance

Все live gates выполняются только на новом i7-14700KF server
`requestin@100.73.71.86:/home/requestin/Titulus`. Каждый отдельный
null/browser/DeckLink run, каждая нога ABBA и каждый closure run длится не
более 5 минут. DeckLink 3ch gate длится не более 5 минут. Phase 20 soaks на 15 и 60
минут находятся вне scope Phase 21 и не запускаются.

### 11.1 Fresh baseline

Fresh baseline снят на новом i7-14700KF server для `main` @
`91a5563`. Зафиксированы:

- null 1ch/3ch `p20-test1-visual`;
- DeckLink 1ch 5 min;
- DeckLink 3ch 5 min;
- DeckLink x4 PASS;
- CPU masks, CEF archive, git SHA, channel/template IDs;
- FrameLog/BGPACING/DeckLink telemetry;
- operator visual marks.

### 11.2 Canonical invariants

На existing main fixtures treatment обязан сохранить:

- `one_tick`;
- logical `(1,1)=100%`, `(2,0)=0`;
- approximately 50 poses/s on every channel;
- zero DeckLink late/drop/flush;
- continuous reference lock;
- no duplicate stack;
- no new engine/CEF crash loop;
- no visual microfreeze noticed in matched run.

Редкие `single`/`input_overwrite` из Phase 20 не объявляются шумом. Принимается
только отсутствие directional regression относительно fresh paired baseline.

### 11.3 Paired comparison

Runtime/hot-path PR проверяется как минимум ABBA:

```text
A = current main
B = candidate
A = current main repeat
B = candidate repeat
```

Одинаковы:

- host/card/driver/CEF;
- CPU masks;
- template and assets;
- channel/device map;
- warmup/duration;
- pacing and feature flags.

Если baseline drift не позволяет вывод — run invalid, а не PASS.

### 11.4 Layered compositor

- Global OFF сохраняется.
- Existing allowlisted `test1` не теряет K2 behavior.
- New features fail closed to whole-template/live path.
- Добавление capability в RenderGraph требует отдельного protocol/golden/ABBA
  PR.
- Новый designer template не получает allowlist автоматически.

### 11.5 Stop thresholds

Немедленный STOP:

- accumulator появился в deployment command line;
- `(2,0)` logical cadence вернулась;
- late/drop/flush/reference unlock;
- repeatable visual freeze;
- old template changed geometry/order/mask;
- editor and air differ;
- candidate запускает другой number/affinity of engines;
- median/p95 regression вне fresh baseline envelope;
- unexplained increase single/overwrite;
- thumbnail/transcode competes with live channel;
- unsupported new layer silently disappears;
- merge requires удаление current tests/instrumentation.

После STOP не «чинить по месту» крупный mixed PR. Revert candidate, объяснить
причину, разбить scope и предложить варианты.

## 12. Rollback

Каждый milestone:

- отдельный merge commit;
- feature flag для нового runtime behavior, пока gate не пройден;
- additive DB migration;
- no destructive media conversion;
- previous template JSON retained in fixture/backup;
- documented `git revert <merge-commit>`.

При hardware regression:

1. остановить полный supervisor tree;
2. checkout/redeploy last accepted main SHA;
3. rebuild `bg-runtime.js`;
4. вернуть DB copy, если milestone менял schema;
5. очистить только candidate CEF cache;
6. запустить current one_tick path;
7. подтвердить baseline до продолжения.

## 13. Что явно не делать

- Не merge `sergey-v1` целиком.
- Не использовать `feature/sergey-v1-merge`.
- Не собирать, запускать или deploy старый `bg_engine`/runtime/supervisor из
  `sergey-v1`; единственный execution baseline — current `main`.
- Не копировать файлы или fragments Sergey в `engine/**`, current runtime hot
  path, `engine/CMakeLists.txt`, `dev-start.sh`, `run-engines.sh` и другие
  supervisor scripts.
- Не заменять current `domRenderer.ts`, `CanvasArea.tsx`, `store.ts`,
  `db.js` или `media.js` версией Сергея.
- Не переносить Unreal/VS ни в одном PR Phase 21.
- Не возвращать WebM alpha/opaque pipeline.
- Не включать Action state machine для всех templates.
- Не обновлять React/Zustand state на каждый engine tick.
- Не генерировать SVG gradient без cache каждый frame.
- Не выполнять file/data parsing в render loop.
- Не запускать thumbnail/transcode без resource bounds.
- Не ослаблять validation ради сохранения нового template.
- Не принимать «выглядит нормально» вместо paired evidence.

## 14. Definition of Done Phase 21

Phase 21 завершена только если:

1. Все принятые designer capabilities доступны из current `main`.
2. Designer создаёт только валидные air-compatible templates.
3. Old main templates визуально и временно совместимы.
4. Editor/browser/DeckLink дают одинаковое задуманное поведение.
5. Transform integrity fixes не потеряны.
6. Current media ingest и video smoothness не потеряны.
7. Canonical one_tick 1ch/3ch gates не хуже fresh baseline.
8. Zero DeckLink late/drop/flush/unlock.
9. Нет повторения visual microfreeze Phase 20.
10. Existing layered allowlist остаётся безопасным и opt-in.
11. Новые DB migrations проверены на copied old state.
12. Deployment/upgrade docs отражают новые data/cache paths.
13. Все PR merged в `main` merge commits.
14. `sergey-v1` остаётся историческим source branch до final sign-off, затем
    удаляется только отдельным решением владельца.
15. Release собирается и запускается только на current новом engine из
    `main`; legacy engine code Sergey отсутствует.
16. В `main` нет `bg_vs_engine`, `run-vs-channel`, UE/NDI/chroma routes/UI и
    `render_backend=unreal`.

Вердикт 2026-08-23: пункты 1–16 выполнены в пределах Phase 21. Draft vNext
fixtures остаются fail-closed для эфира (`supported=[]`). Operator visual
PASS на i7 DeckLink 1ch/3ch. Residual `single`/`overwrite` не объявлены
шумом. 15/60 min soak и strict on-wire zero-anomaly — вне scope.
`docs/sergey-v1/*` остаются историей и не удаляются этим закрытием.

## 15. Закрытие

Phase 21 закрыта. Возможности designer перенесены малыми PR на current
`main` без merge `sergey-v1` engine/runtime. Следующая работа — вне этого
документа. Engine-first rule и deferred on-wire gate остаются в силе.

Evidence:

- [p21-00-baseline.md](../performance%20investigation/reports/p21-00-baseline.md)
- [p21-08-video-timeline.md](p21-08-video-timeline.md)
- [p21-10-software-matrix.md](../performance%20investigation/reports/p21-10-software-matrix.md)
- [p21-10-hardware-closure.md](../performance%20investigation/reports/p21-10-hardware-closure.md)

Rollback по-прежнему `git revert <merge-commit>` одного milestone, затем
rebuild `bg-runtime.js`.

## 16. Индекс PR

| PR | Задача |
|---|---|
| #114–#116 | governance, source docs, engine-first rule |
| #117 | P21.0 baseline + inventory |
| #118–#120 | P21.1 fixtures / schema / agreement |
| #121–#122 | P21.2 editor + templates shell |
| #123–#127 | P21.3 Z / Tree / group preview / gradient |
| #128–#133 | P21.4–P21.5 Timeline v2 + Continue |
| #134–#138 | P21.6 Crawl + Data + files + prepare |
| #139 | P21.7/P21.9 catalog, folders, locks, LayerID, RBAC |
| #140 | P21.8 video ADR (WebP air; PR-81 closed) |
| #141 | P21.10 software / fixture / migration matrix |
| #142 | P21.10 hardware / visual closure |
