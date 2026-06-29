# Master Development Prompt:   
Titulus — Cloud Broadcast Graphics System

> **Назначение документа:** полная спецификация для AI-агентов, создающих систему **с нуля**.  
> **Product repository (canonical):** https://github.com/Requestin/Titulus  
> **Dev server checkout:** `/root/Titulus` (см. §0.3)  
> Документ описывает продукт, архитектуру, протоколы, критерии приёмки и порядок реализации.  
> **Эталон render engine:** [CasparCG Server 2.5+](https://github.com/CasparCG/server) — локальная копия: `/root/Titulus/CasparCG/server`  
> **Наша цель по рендеру:** собственный бинарь (`bg_engine`), **идентичный CasparCG по производительности, pipeline и broadcast-функциональности**, построенный на тех же принципах (C++ + CEF + mixer + producers/consumers + DeckLink).  
> **Запрещено:** встраивать/запускать `casparcg-server` как subprocess или зависимость продукта. **Разрешено:** изучать, портировать и адаптировать код CasparCG (до ~99% render-логики) в наш proprietary engine.  
> **Песочница (reference only):** `/root/Titulus/broadcast-graphics` — проба пера; cherry-pick идеи, **не** копировать слепо (§0.4).  
> **Git-first разработка (обязательно):** каждая задача = ветка → коммиты → push → PR → merge в `main` с подробными комментариями (§0.5).  
> Другие аналоги продукта целиком: **Viz Flowics**, **Singular.live**, **SPX Cloud**, **WTVision**.

---

## 0. Инструкция для агента

Ты разрабатываешь **Titulus** — коммерческую облачную титровальную систему для эфирного телевидения (2D-графика, уровень новостных выпусков). Код пишется в репозиторий **Requestin/Titulus**. Это **не** игровой движок, **не** NLE, **не** VFX-пакет.

**Иерархия источников (при конфликте — сверху вниз):**

1. Этот документ (`DEVELOPMENT_PROMPT.md`) + §0.2 product principles + **§0.5 Git workflow**  
2. **CasparCG Server** (`/root/Titulus/CasparCG/server`) — render engine truth  
3. **Cherry-pick** из `broadcast-graphics` sandbox (§0.4) — только validated pieces  
4. Собственные решения агента — только если 1–3 не покрывают задачу и **не** ломают CPU-only / CasparCG parity

**Главные принципы (non-negotiable):**

См. также **§0.2** — шесть продуктовых принципов заказчика. Кратко:

1. **CPU-only render на базе CasparCG** — CEF OSR + software rasterization; GPU **запрещён по умолчанию** (см. §0.2.1 GPU Gate).
2. **HTML5** — единственный template runtime (DOM/CSS через CEF), как CasparCG HTML Producer.
3. **Покадровая синхронизация от внешнего sync/genlock** — hardware reference clock DeckLink, scheduled playback, frame-accurate output (§REQ-7).
4. **Выбор выхода на канал** — browser / DeckLink SDI / OBS·vMix browser source; конфигурируется per-channel (§REQ-11).
5. **Свой control plane** — editor, templates (JSON schema), rundowns; не AMCP, не CasparCG Client.
6. **Производительность** — **минимум 3 канала 1080i50 × 4–5 титров**; особый фокus: **маски и альфа без деградации FPS** (§6.5, §11).
7. **Git-first delivery** — **каждая задача/фича** версионируется через Git: отдельная ветка, атомарные коммиты, PR, merge в `main` (§0.5). Без исключений.

**Технические принципы реализации (CasparCG-aligned):**

1. **CasparCG-first render design** — перед любой render-задачей изучи CasparCG (`modules/html`, `decklink`, `ffmpeg`, `core/mixer`). Портируй в `bg_engine`.
2. **Producer → Mixer → Consumer** — та же модель кадра, что в CasparCG.
3. **Один процесс рендера на канал** — CPU affinity, изоляция, масштабирование.
4. **Один shared runtime** — editor, engine, thumbnails, OBS используют одну DOM-реализацию.
5. **BGRA end-to-end** до SDI — без GPU readback, без лишних color conversion.
6. **Linux-first headless** — как CasparCG 2.5+.
7. **Не изобретай Electron + Node addon** для SDI.

**Не делай:**

- Включать GPU без прохождения **GPU Gate** (§0.2.1) — нужны benchmark + written justification
- Запускать `casparcg-server` / `casparcg-cef` как runtime-зависимость продукта
- Дубли рендер-кода в frontend/backend/public
- PIXI.js / GSAP как core dependencies
- GPU readback pipeline (WebGL → CPU → SDI)
- Один Chromium на все каналы (process singleton)
- Игнорировать interlaced / scheduled-playback / alpha path CasparCG при 1080i50
- **Mask/alpha через тяжёлые CSS filter chains или canvas readback** — perf killer (§6.5)
- **Слепое копирование из `broadcast-graphics`** без сверки с CasparCG и §0.4
- **Treat sandbox as architecture authority** — там проба пера, не spec
- **Работать без Git** — не коммитить, не пушить, не создавать PR, merge в `main` напрямую с uncommitted changes
- **Один giant commit/PR на целую фазу** — дроби на логические задачи (§0.5)
- **Оставлять незакоммиченную работу** при завершении сессии — всегда commit + push (§0.5.6)

**Deliverables по завершении MVP:**

- Рабочий control plane: **свой editor + templates + rundowns**
- Native `bg_engine` (CasparCG-class, CPU-only) с выбором consumer per channel
- **Минимум 3 канала** 1080i50 × 4–5 титров (видео + анимированные плашки + masks/alpha) стабильно на bare-metal
- Frame-accurate SDI с external sync (genlock) на DeckLink
- Документация деплоя и runbook
- **Полная Git-история** в `main`: каждая фаза/фича = merged PR с описанием (§0.5); возможность `git revert` / checkout на любую точку до или после фичи

---

## 0.2 Шесть основных продуктовых принципов (заказчик)

Эти принципы **важнее** любых технических shortcuts. При конфликте — следуй им.

### 0.2.1 CPU-only render (на базе CasparCG)

- Render plane = **только CPU**: CEF windowless OSR, software rasterization (Skia), `<enable-gpu>false</enable-gpu>` / `--disable-gpu`.
- Архитектура и код портятся с **CasparCG Server** (`modules/html`, `core/mixer`, `modules/decklink`, `modules/ffmpeg`).
- **GPU запрещён** в MVP и по умолчанию всегда.

**GPU Gate (единственный путь к GPU):** GPU допускается **только** если выполнены **все** условия:

1. Задача **невыполнима** на CPU при приемлемом качестве, **или** CPU-path даёт **документированную** потерю >15% fps / >0.5% drops на acceptance bench (§11) vs CasparCG CPU baseline.
2. Проведён **research doc** `docs/GPU_GATE_<feature>.md`: гипотеза → CPU benchmark → CasparCG CPU baseline → попытки CPU optimization → measured failure → GPU POC → comparison.
3. GPU решение **не ломает** BGRA end-to-end path до SDI (no GPU→CPU readback в hot path без explicit approval).
4. Sign-off в документе: «CPU path exhausted» с числами (fps, drops, CPU%, latency p99).

Без GPU Gate doc — **не включать GPU**, даже «для ускорения».

### 0.2.2 HTML5

- Все шаблоны рендерятся через **HTML5/DOM/CSS** в CEF (как CasparCG HTML Producer).
- Запрещены PIXI, Three.js, WebGL-as-primary, Canvas2D readback loops.
- JSON schema → `domRenderer` → DOM; editor preview = engine output (WYSIWYG).

### 0.2.3 Покадровая синхронизация от внешнего sync (genlock)

- **Обязательно:** вывод кадров привязан к **hardware reference clock** DeckLink (внешний sync/genlock от Blackmagic или house sync).
- `GetHardwareReferenceClock()` + `ScheduleVideoFrame()` — port from CasparCG DeckLink consumer.
- Каждый выведенный кадр — на границе поля/кадра формата (1080i50 = 50 fields/sec).
- Telemetry: completed / late / dropped / genlock locked status.
- Render tick (50p) + weave → interlaced SDI; consumer clock — **master**, не wall clock.
- MVP acceptance: на сервере с genlock **0 sustained dropped frames** за 8h soak; без genlock — best-effort с документированным jitter budget.

### 0.2.4 Выбор выхода канала рендера

Каждый channel config задаёт **output mode** (можно комбинировать preview + primary):

| Output mode | Consumer / path | Use case |
| ----------- | --------------- | -------- |
| `browser` | `/renderer` или `channel.html?preview=1` — прозрачный HTML для preview | Control panel, QA |
| `obs_vmix` | Browser Source URL: `channel.html?channel=<id>` (transparent BGRA in engine) | Streaming без SDI |
| `decklink` | `decklink_consumer` — SDI Fill+Key | Broadcast on-prem |
| `stream` | `ffmpeg_consumer` — SRT/RTMP | Cloud / remote |

Настраивается в **Settings → Channels**: `output_mode`, `device_index`, `display_mode`, `keyer_mode`, `stream_url`.  
`run-engines.sh` / `run-channel.sh` выбирают consumer из конфига канала.  
**Один `bg_engine` process = один channel = один primary output** (+ optional JPEG preview parallel).

### 0.2.5 Свой editor, templates, rundowns

- **Не** использовать CasparCG Client / AMCP как UI продукта.
- Свой React editor (JSON schema, layers, timeline, variables, masks).
- Свой rundown system (slots, reorder, channel binding).
- Свой backend (SQLite, WS take/clear/update).
- CasparCG — **только** reference для render engine C++ / CEF / DeckLink.

### 0.2.6 Производительность и оптимизация

**Minimum acceptance (MVP):**

| Parameter | Target |
| --------- | ------ |
| Channels | **≥ 3** stable (1080i50) |
| Templates per channel | **4–5** simultaneous |
| Template content mix | animated plates (x/y/rotate/scale/opacity) + text + **masks** + **alpha** + video/sequences (VP9/WebM+alpha) |
| Render path | CPU-only CEF OSR |
| Interval p50 | 20.0 ms (50 fps) |
| Drops | < 0.1% bare-metal, 30 min soak per channel |
| Alpha/mask overhead | ≤ 5% fps drop vs same scene without masks (bench §11.4) |

**Stretch goal (post-MVP):** 6 channels — same criteria.

**Content stress profile (bench must include):**
- 2× lower-third с gradient + drop-shadow + animated slide (x, opacity)
- 1× full-screen bug/logo с alpha PNG
- 1× **mask layer** (clip-path), clipping animated content below
- 1× VP9/WebM video с alpha (lower third или fullscreen overlay)

---

## 0.3 Workspace на dev-сервере (Requestin/Titulus)

Разработка ведётся в GitHub-репозитории **https://github.com/Requestin/Titulus**.  
На dev-сервере рабочий каталог: **`/root/Titulus`**.

```
/root/Titulus/                          ← git clone Requestin/Titulus (PRODUCT)
├── docs/DEVELOPMENT_PROMPT.md         ← этот документ (source of truth для агента)
├── LICENSE.md / README.md
├── backend/ frontend/ runtime/ engine/ …   ← целевая структура продукта (создавать/переносить сюда)
│
├── Blackmagic DeckLink SDK 16.0/      ← LOCAL ONLY (не в git, .gitignore)
│   └── Linux/include/DeckLinkAPI.h
├── CasparCG/                          ← LOCAL reference (не product code)
│   ├── server/                        ← git clone github.com/CasparCG/server
│   ├── casparcg-server-2.5_*.deb
│   └── casparcg-cef-142_*.deb
└── broadcast-graphics/                ← SANDBOX clone (reference only, §0.4)
    └── …                              ← Vasily113/broadcast-graphics — проба пера
```

### Пути для сборки (dev server)

| Resource | Path |
| -------- | ---- |
| Product repo | `/root/Titulus` |
| DeckLink SDK include | `/root/Titulus/Blackmagic DeckLink SDK 16.0/Linux/include` |
| CasparCG source (porting) | `/root/Titulus/CasparCG/server` |
| CasparCG .deb (install for baseline bench) | `/root/Titulus/CasparCG/*.deb` |
| Sandbox reference | `/root/Titulus/broadcast-graphics` |
| CEF dist (download) | `/root/Titulus/engine/third_party/cef/` (after engine/ created) |

### Git rules

- **Commit & push только в Requestin/Titulus** — proprietary product.
- **Default branch:** `main` — единственная интеграционная ветка; см. полный workflow в **§0.5**.
- **Не commit:** SDK, CEF tarball, `CasparCG/*.deb`, sandbox `broadcast-graphics/` (unless explicitly requested).
- `broadcast-graphics` остаётся read-only reference; изменения sandbox **не** merge в Titulus автоматически.

---

## 0.4 Sandbox `broadcast-graphics` — что брать, что не брать

`/root/Titulus/broadcast-graphics` — **проба пера** (Vasily113/broadcast-graphics).  
Там есть полезные идеи, но также **плохая оптимизация, нестабильный render, legacy-решения**.  
**Агент сам решает**, что подходит — по критериям ниже. При сомнении: **CasparCG wins**.

### ✅ Можно заимствовать (control plane & domain model)

| Area | Path / idea | Why OK |
| ---- | ----------- | ------ |
| JSON template schema | `shared/template.schema.json`, `runtime/src/schema.ts` | AI-ready, editor domain model |
| Timeline engine concept | `runtime/src/timeline.ts` | Directors, keyframes, easing — хорошая база |
| DOM renderer approach | `runtime/src/domRenderer.ts` | HTML5 path (но **re-validate perf**, особенно masks §6.5) |
| WS protocol | take / clear / update, replay on connect | Простой operator protocol |
| SQLite on-air persistence | `backend/src/db.js` pattern | Production requirement |
| Media transcode idea | VP9/WebM+alpha via ffmpeg | CEF-compatible video |
| Editor UI structure | `frontend/src/features/editor/*` | Panels, layers, properties — UX baseline |
| Rundown + control panel | `ControlPage`, rundowns API | Product workflow |
| Channel page pattern | `backend/public/channel.html` + `ChannelClient` | Engine loads WS-driven DOM |
| Bench harness idea | `bench/run-bench.sh`, `bench.html` | Adapt for 3ch MVP + CasparCG compare |
| Docs | `docs/ARCHITECTURE.md`, `RUNBOOK.md` concepts | Deployment thinking |
| Mask layer in schema | `MaskLayer` type | Product requirement — **reimplement perf-safe** |

### ❌ Не копировать слепо (render / perf / legacy)

| Area | Why reject as-is |
| ---- | ---------------- |
| `engine/` C++ без полного CasparCG port | Недостаточная оптимизация; не parity с CasparCG — **перепортировать** из `CasparCG/server` |
| Performance numbers / bench conclusions | Sandbox не прошёл CasparCG parity bar — **re-benchmark** on Titulus |
| Любой Electron / `decklink-out/` (если найдётся в старых ветках) | Антипаттерн, deprecated |
| PIXI / GSAP paths (если встретятся) | Violates HTML5/CPU-only |
| DOM mask/filter tricks from sandbox | Могут убивать FPS — **re-bench §11.4**, prefer CasparCG mixer semantics |
| Duplicate render code | Sandbox исторически имел дубли — Titulus: **one runtime only** |
| `ops/casparcg-test` experimental stack as product architecture | Только как reference для VP9 pipe-bridge, не как core design |
| README legacy sections | Устарели; follow this prompt |

### Decision flow для агента

```
Нужна feature X
  → Есть в CasparCG/server? → Port/adapt from CasparCG (primary)
  → Else есть в broadcast-graphics sandbox?
       → Попадает в ✅ table? → Cherry-pick + refactor + bench
       → Попадает в ❌ table? → Reject; design from CasparCG principles
  → Else → Design new, но CPU-only + HTML5 + CasparCG pipeline compatible
```

**Compatibility verdict (sandbox vs Titulus spec):** sandbox **совместим** как reference для control plane и schema; **не совместим** как render authority. Titulus render plane **must converge to CasparCG**, using sandbox only for UX/protocol shortcuts.

---

## 0.5 Git-driven development (обязательно для каждой задачи)

**Правило:** ИИ-агент **не просто пишет код** — он ведёт разработку **совместно с Git**. Каждая логическая задача (фича, фикс, фаза-deliverable, документ) проходит полный цикл версионирования.

### Зачем

1. **Полное версионирование** — заказчик может откатиться на любую версию **до или после** конкретной фичи/задачи (`git log`, `git revert`, checkout merge commit).
2. **Защита от обрыва сессии** — лимиты токенов/context window могут прервать агента; каждый merged PR и push = **checkpoint**, с которого новая сессия продолжает работу.
3. **Аудит и review** — каждое изменение привязано к PR с описанием «что / зачем / как проверено».

### Цикл задачи (mandatory)

Каждый шаг сопровождается **подробным комментарием** в чате с пользователем **и** в Git/PR (commit message, PR body, при необходимости — комментарий к PR).

```
1. PLAN     → описать задачу, scope, exit criteria, имя ветки
2. BRANCH   → git checkout main && git pull && git checkout -b <branch>
3. IMPLEMENT→ код + атомарные коммиты (1 логическое изменение = 1 commit)
4. PUSH     → git push -u origin HEAD
5. PR       → gh pr create (title + body: Summary, Test plan, Phase/task ref)
6. REVIEW   → проверить diff, CI (если есть); при несостыковках — fix commits, push, комментарий в PR
7. MERGE    → gh pr merge (prefer --merge для сохранения merge commit как milestone)
8. REPORT   → в чате: ссылка на PR, hash merge commit, что сделано, как проверить
```

**Задача не считается выполненной**, пока PR **не merged в `main`**.

### Именование веток

| Pattern | Example | When |
| ------- | ------- | ---- |
| `feature/phase-<N>-<short-kebab>` | `feature/phase-0-engine-skeleton` | Новая фича / deliverable фазы |
| `fix/<short-kebab>` | `fix/decklink-weave-field-order` | Багфикс |
| `docs/<short-kebab>` | `docs/runbook-ubuntu-setup` | Только документация |
| `chore/<short-kebab>` | `chore/gitignore-casparcg` | Инфра, конфиг, без product logic |

### Commit messages

Формат (Conventional Commits, адаптированный):

```
<type>(<scope>): <краткое описание на англ. или рус.>

<подробное тело: что изменено, зачем, как проверено>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `bench`, `engine`.

**Пример:**

```
feat(engine): add CEF OSR skeleton with null consumer

- Port CEF init flags from CasparCG modules/html
- External BeginFrame loop, frame stats
- Verified: ./engine/build/bg_engine --consumer=null runs 50fps bench scene

Refs: Phase 0, CASPARRCG_PORTING.md §CEF init
```

### PR body (обязательные секции)

```markdown
## Summary
- 1–3 bullet points: что и зачем

## Task / Phase
- Phase N / issue / конкретная задача из DEVELOPMENT_PROMPT

## Changes
- Список затронутых модулей и ключевых решений

## Test plan
- [ ] Команды / сценарии проверки
- [ ] Bench / manual steps

## Rollback
- Как откатить: `git revert <merge-commit>` или checkout parent of merge
```

### Размер задач и checkpoint-ы

- **Один PR = одна логическая задача** (не вся Phase целиком, если Phase > 3–5 дней работы).
- Дробить Phase на sub-tasks: `feature/phase-0-cef-skeleton`, `feature/phase-0-bench-harness`, …
- **Длинная задача в одной сессии:** commit + push **до** исчерпания context; в чате указать «продолжить в ветке X».
- **Не накапливать** uncommitted changes > 1 логического шага.

### Merge policy

- Target: **`main`** (default branch).
- Prefer **`gh pr merge --merge`** (merge commit) — каждая фича = явная точка в истории для rollback.
- Squash — только если пользователь явно попросил; по умолчанию **не squash**.
- **Force push to `main` запрещён** (§0, user rules).
- Агент **создаёт, ревьюит, фиксит и мерджит PR сам**, если нет блокеров; при блокере — отчёт в чат с тем, что осталось.

### Возобновление после прерывания сессии

Новая сессия агента **начинает с Git**:

```bash
cd /root/Titulus
git fetch origin
git status
git branch -a
gh pr list --state open
```

- Есть незавершённая ветка → продолжить, commit, push, довести PR до merge.
- PR open → проверить CI/conflicts, fix, merge.
- `main` чист → `git pull`, новая задача → новая ветка.

### Phase exit = merged PR(s)

Каждая Phase (§13) завершается **не checklist в коде**, а **одним или несколькими merged PR в `main`** с тегом в PR title/body: `[Phase N]`.

Пример истории `main`:

```
* Merge PR #12: [Phase 1] runtime package + channel WS client
* Merge PR #11: [Phase 0] bench harness + PHASE0_BENCH report
* Merge PR #10: [Phase 0] CEF OSR engine skeleton
```

### Инструменты

- `git` — ветки, коммиты, статус
- `gh` — PR create, view, merge, comments
- Рабочий каталог: **`/root/Titulus`** (не sandbox, не broadcast-graphics workspace)

---

## 1. Продукт и контекст

### 1.1 Что это

Система вывода **графических титров в прямой эфир**:

- Lower thirds, заставки, логотипы, часы, бегущие строки
- Управление через веб-интерface (редактор + пульт оператора)
- Вывод per-channel (настраивается): **browser preview**, **OBS/vMix browser source**, **DeckLink SDI Fill+Key**, **SRT/RTMP stream**
- Rundown-сценарии для пошагового эфира

### 1.2 Целевая аудитория

- Региональные телеканалы
- Интернет-трансляции с professional workflow
- Production houses с on-prem + optional cloud

### 1.3 Модель поставки

- **Cloud SaaS** (подписка month/year) — control plane + stream output
- **On-prem** (lifetime/perpetual или annual) — полный stack на сервере заказчика с SDI
- Один codebase, разные deployment profiles

### 1.4 Конкурентное позиционирование


| Конкурент      | Что берём как ориентир                                      |
| -------------- | ----------------------------------------------------------- |
| **CasparCG**   | **Render engine: CEF, mixer, DeckLink, ffmpeg, interlace**  |
| Viz Flowics    | Cloud-first, HTML templates, multi-channel                  |
| Singular.live  | DOM/CSS rendering, control UX                               |
| SPX            | Rundown workflow, operator UX                               |
| WTVision       | Enterprise multi-channel                                    |


**Наш дифференциатор:** proprietary **собственный** `bg_engine` (не форк и не встраивание CasparCG), современный cloud control plane (React + WS + SQLite), JSON schema + AI-ready templates, subscription licensing. **Render plane должен быть неотличим от CasparCG по качеству эфира.**

---

## 0.1 CasparCG — эталон render engine (обязательно к изучению)

### Почему CasparCG

CasparCG Server — **открытый** (GPLv3+) broadcast graphics server, 24/7 production на телеканалах. Это **главный reference implementation** для нашего render plane:

- Проверенный **HTML Producer на CEF** (CEF 142 в 2.5)
- **Mixer** с transforms, blend modes, interlaced pipeline
- **DeckLink consumer** с scheduled playback и keyer
- **FFmpeg producer/consumer** для клипов и stream output
- Headless Linux без X11 (2.5+)
- Channel-synced `requestAnimationFrame` (анимации в такт канала)

**Репозиторий для изучения и портирования:** https://github.com/CasparCG/server  
**Релиз для сверки:** v2.5.0-stable  
**Документация:** https://github.com/CasparCG/help/wiki

### Что копируем / портируем (render plane)

Агент **обязан** использовать CasparCG как primary source при реализации:

| Область CasparCG | Что взять | Куда в нашем проекте |
| ---------------- | --------- | -------------------- |
| `modules/html/` | CEF lifecycle, OSR, cache-path, channel-paced rAF, reload | `engine/src/engine_app.*`, `engine_client.*`, `channel.html` |
| `core/mixer/` | Layer compositing, transforms, interlaced frame handling | `runtime/domRenderer` (JS mixer) + future native mixer if needed |
| `modules/decklink/` | Device open, profile, keyer, scheduled playback, modes | `engine/src/consumers/decklink_consumer.*` |
| `modules/ffmpeg/` | Producer/consumer, pixel formats, alpha WebM | `engine/consumers/ffmpeg_consumer.*`, `backend/media.js` |
| Channel model | 1 channel = 1 video pipeline @ fixed format | 1 `bg_engine` process = 1 channel |
| Consumers architecture | Pluggable output sinks | `engine/src/consumers/` |
| Config patterns | `<channel>`, `<consumers>`, `<html><enable-gpu>` | `engine` CLI + future YAML config |

**Допустимо:** переносить код почти 1:1, рефакторить naming под наш проект, адаптировать под наш WS control вместо AMCP.

**Недопустимо:** shipping продукта как «CasparCG + наш UI» или `apt install casparcg-server` в install path.

### Лицензия CasparCG (важно)

CasparCG Server — **GPLv3+**. При прямом копировании исходников:

- веди `engine/THIRD_PARTY_NOTICES.md` с указанием заимствованных файлов/функций;
- прямой paste GPL-кода в закрытый продукт может накладывать copyleft — **перед commercial release нужна legal review**;
- допустимая стратегia для proprietary продукта: **reimplement by reference** (изучил алгоритм в CasparCG → написал свой код) или **port с compliance** по решению юриста.

### Маппинг CasparCG ↔ Titulus

| CasparCG | Titulus | Примечание |
| -------- | ------- | ---------- |
| AMCP `CG 1-10 ADD ...` | WS `take` | Наш протокол; AMCP adapter — future |
| AMCP `CG 1-10 UPDATE ...` | WS `update` | Live variables |
| AMCP `CG 1-10 STOP ...` / `CLEAR` | WS `clear` | Out animation + remove |
| HTML template file | JSON template → `domRenderer` → DOM | Наш AI-friendly формат; pixel output must match |
| HTML Producer (CEF) | `bg_engine` + `channel.html` + `bg-runtime.js` | Тот же CEF OSR pipeline |
| Channel mixer | Multi-template stack in `#stage` | Same z-order/transform semantics |
| DeckLink Consumer | `decklink_consumer` | Port scheduling/weave/keyer from CasparCG |
| FFmpeg Consumer | `ffmpeg_consumer` / pipe-bridge | VP9 alpha path validated in `ops/casparcg-test` |
| `<channel><video-mode>1080i5000</video-mode>` | `--display-mode=HD1080i50 --fps=50` | Interlaced output |
| `<html><enable-gpu>false</enable-gpu>` | `--disable-gpu` CEF flags | CPU default |
| Multi-channel server | `run-engines.sh` (N × bg_engine) | Deployment choice; functionally equivalent |

### Acceptance vs CasparCG

На одинаковом железе (bare-metal, DeckLink, 1080i50) наш `bg_engine` должен:

- держать **не меньше** одновременных HTML-слоёв, чем CasparCG HTML Producer на том же CPU;
- иметь **сопоставимый** или лучший jitter/fps stability;
- давать **идентичное** Fill+Key SDI качество (alpha, interlace motion);
- проходить side-by-side test: один и тот же HTML/шаблон на CasparCG и на `bg_engine` → визуально indistinguishable на waveform/vectorscope.

---

## 2. Функциональные требования (обязательные)

### REQ-1. Cloud-first + on-prem

- Primary: облачное развёртывание control plane
- On-prem: установка у заказчика (Linux server + DeckLink)
- Один engine binary, конфигурируемые consumers

### REQ-2. HTML5 template runtime (mandatory)

- **Единственный** runtime: HTML5 DOM/CSS в CEF (CasparCG HTML Producer class)
- Шаблоны = JSON schema → `domRenderer` → DOM (editor WYSIWYG = air output)
- Поддержка: text, rect, image, video, clock, **mask**, groups, blend modes
- Анимации: x, y, scale, rotation, opacity, perspective (timeline keyframes, channel-paced clock)
- Variables с live update в эфире
- Видео/секвенции: VP9/WebM+alpha (transcode pipeline)

### REQ-3. CPU-only rendering (CasparCG-based, GPU Gate required for exceptions)

- **Default: CPU-only.** CEF windowless OSR, software rasterization — как CasparCG `<enable-gpu>false</enable-gpu>`
- Channel-paced frame tick: `SendExternalBeginFrame` + CasparCG-style synced `requestAnimationFrame`
- Flags: `--disable-gpu`, `--disable-gpu-compositing`, `--ozone-platform=headless`
- Port CEF integration from `CasparCG/server` `modules/html/`
- **GPU:** см. §0.2.1 GPU Gate — только с документированным proof; иначе **запрещён**

### REQ-4. Performance (minimum 3 channels, CasparCG parity)

- **Minimum success (MVP):** **3 канала 1080i50**, каждый с **4–5 одновременных титров** (mix: animated plates + masks/alpha + video)
- **Stretch goal:** 6 каналов — те же критерии
- **Reference baseline:** CasparCG 2.5 HTML Producer, same bench HTML, CPU-only
- Frame interval p50 = 20 ms; drops < 0.1% bare-metal (30 min soak)
- **Mask/alpha bench (§11.4):** overhead ≤ 5% fps vs scene without masks
- Benchmark: `bench/run-bench.sh` + CasparCG comparison in `docs/PHASE0_BENCH.md`

### REQ-5. SDI output (DeckLink, Linux — port from CasparCG)

- Fill + Key (external keyer) — логика из `CasparCG/server` `modules/decklink/`
- Sub-device mapping: device 0 → SDI1 Fill + SDI2 Key; device 1 → SDI5 Fill + SDI6 Key
- Profile **2dfd** (2 Sub-Devices Full Duplex) для external keying
- Scheduled playback по `GetHardwareReferenceClock()` — как CasparCG DeckLink consumer
- Interlaced output: использовать CasparCG interlaced mixer/weave semantics (UFF), не naive drop-frames

### REQ-6. Linux primary OS

- Ubuntu 22.04 / 24.04
- systemd units для production
- Не блокировать Windows port, но не оптимизировать под него

### REQ-7. Frame-accurate external sync / genlock (mandatory for SDI)

- **Master clock:** external sync generator → DeckLink hardware reference clock (genlock locked)
- `GetHardwareReferenceClock()` drives **scheduled frame output** — port from CasparCG DeckLink consumer
- **Frame-accurate:** каждый SDI кадр/поле выводится по schedule; late/dropped telemetry обязательна
- Weave 50p → 50i (UFF) — validate vs CasparCG interlaced output
- Render produces 50p BGRA; **consumer clock is master** for air timing (not browser wall clock)
- Config: reference input (Blackmagic Desktop Video), format lock (1080i50)
- MVP SDI acceptance: **8h soak, genlock locked, zero sustained drops** on test pattern + live templates
- Future: drive `SendExternalBeginFrame` directly from hardware clock tick (true single-clock pipeline)

### REQ-8. Own stack (CasparCG-class engine, own control plane)

- **Свой** template editor, JSON schema, rundown system, control panel — **не** CasparCG Client
- **Свой** render engine `bg_engine` — CPU-only, CasparCG-equivalent performance
- **Не** subprocess `casparcg-server`; **да** port CasparCG C++ render modules

### REQ-11. Per-channel output selection (mandatory)

Каждый channel в SQLite/API:

```typescript
{
  output_mode: 'browser' | 'obs_vmix' | 'decklink' | 'stream';
  device_index: number;      // -1 = no DeckLink
  display_mode: string;      // HD1080i50, ...
  keyer_mode: 'external' | 'internal' | 'fill_only';
  stream_url?: string;       // for stream mode
  browser_url?: string;      // generated: channel.html?channel=<id>
}
```

- `browser` / `obs_vmix`: engine renders to CEF OSR; OBS/vMix uses transparent browser source URL
- `decklink`: `decklink_consumer` with Fill+Key
- `stream`: `ffmpeg_consumer`
- Operator switches channel output in Settings without code changes
- `run-engines.sh` reads config and sets `--consumer=` accordingly

### REQ-9. AI module (future-ready)

- JSON Schema для шаблонов (`shared/template.schema.json`)
- Validation API (`/api/templates/validate`)
- Runtime детерминирован: AI output → validate → play без ручных правок

### REQ-10. Media in templates

- Images: PNG, JPEG, WebP, SVG (upload)
- Video: MP4/MOV/WebM upload → **transcode to VP9/WebM+alpha** (CEF не декодирует H.264 out of box)
- Poster frame + processing status polling

---

## 3. Нефункциональные требования

### NFR-1. Reliability

- Backend restart не теряет on-air state (SQLite persistence)
- Engine restart → replay on-air via WebSocket
- Engine crash на одном канале не роняет другие

### NFR-2. Observability

- Per-engine stats: fps, interval percentiles, drops
- DeckLink telemetry в логах
- JPEG program preview для оператора (10 fps throttle)

### NFR-3. Security (MVP baseline)

- Proprietary license, private repo
- No secrets in git (.env, keys, db)
- Upload size limits, MIME validation
- CORS configurable for production

### NFR-4. Operability

- `start.sh` / `stop.sh` для dev
- `run-engines.sh` supervisor для multi-channel
- `systemd` template unit per channel
- Runbook документ для нового сервера
- **Git versioning (§0.5):** каждая фича в `main` через PR; история пригодна для rollback и resume после прерывания агента

---

## 4. Архитектура системы

### 4.1 High-level diagram (CasparCG producer/mixer/consumer model)

```
┌─ CONTROL PLANE (наш продукт) ───────────────────┐     ┌─ RENDER PLANE ≈ CasparCG Channel ─────────────┐
│  frontend (React + Vite)                       │     │  bg_engine (C++20 + CEF) — OUR binary         │
│    /templates  /editor/:id  /control  /settings│     │                                               │
│                                                │     │  ┌─ HTML Producer (CEF OSR) ──────────────┐  │
│  backend (Express + WS + SQLite)               │◀───▶│  │ channel.html + bg-runtime.js           │  │
│    REST /api/*                                 │  WS  │  │ DOM mixer (multi-template stack)       │  │
│    WS  /ws/control  /ws/renderer               │     │  │ OnPaint → BGRA                         │  │
└────────────────────────────────────────────────┘     │  └────────────────────────────────────────┘  │
                                                       │           ↓                                   │
                                                       │  ┌─ Consumers (CasparCG-style) ───────────┐  │
                                                       │  │ decklink → SDI Fill+Key (scheduled)    │  │
                                                       │  │ ffmpeg   → SRT/RTMP/VP9 pipe           │  │
                                                       │  │ preview  → JPEG (operator monitor)     │  │
                                                       │  │ null     → benchmark                   │  │
                                                       │  └────────────────────────────────────────┘  │
                                                       └───────────────────────────────────────────────┘

         ┌─ SHARED RUNTIME (HTML template logic — наш JSON→DOM слой) ─────┐
         │  schema · timeline · domRenderer · channelClient · easing       │
         │  CasparCG использует raw .html; мы — JSON schema + DOM renderer │
         │  → bundled as backend/public/bg-runtime.js (IIFE)               │
         └─────────────────────────────────────────────────────────────────┘
```

### 4.2 Frame pipeline (CasparCG-aligned critical path)

```
Control WS: take / update / clear
  → ChannelClient (template stack = CasparCG CG layers)
  → TemplateRenderer × N (DOM/CSS mixer — z-order, transforms, blend, masks)
  → CEF HTML Producer compositor (CPU Skia raster, channel-paced rAF)
  → CefRenderHandler::OnPaint(BGRA)
  → Frame handoff (zero copy where possible)
  → Consumer(s): DeckLink (scheduled) | ffmpeg | JPEG preview
```

**Why this matches CasparCG performance:**

- Same fundamental path: **CEF OSR → raw pixels → DeckLink scheduled playback**
- No Electron GPU readback / IPC (anti-pattern CasparCG never used)
- BGRA native for DeckLink (CasparCG pixel format discipline)
- 1080i50: progressive render @ 50fps → **interlaced weave** (CasparCG interlaced channel semantics, UFF)
- Channel-synced animation clock (CasparCG custom `requestAnimationFrame` tied to channel rate)

### 4.4 Architecture compatibility matrix (CasparCG ↔ Titulus)

| CasparCG concept | Titulus implementation | Compatible? | Action if gap |
| ---------------- | ------------------------ | ----------- | ------------- |
| HTML Producer (CEF) | `bg_engine` + CEF OSR | ✅ Yes | Port CEF init/message pump from CasparCG `modules/html/` |
| FFmpeg Producer | `backend/media.js` + `<video>` in DOM | ✅ Yes | VP9/WebM+alpha; port scaling-mode ideas from CasparCG 2.5 |
| Image Producer | `<img>` in domRenderer | ✅ Yes | — |
| Mixer (native C++) | DOM stack in `domRenderer.ts` | ⚠️ Partial | Match transform/blend/mask/alpha; port interlace from CasparCG mixer |
| Alpha / Fill+Key | BGRA OSR → DeckLink keyer | ✅ Yes | No unnecessary alpha premultiply; validate vs CasparCG |
| Mask layers | CSS clip-path stack (§6.5) | ⚠️ Must optimize | Bench overhead ≤5%; avoid filter chains |
| Channel @ fixed video-mode | `--display-mode`, `--fps` | ✅ Yes | — |
| DeckLink Consumer | `decklink_consumer.cpp` | ✅ Yes | Port scheduling, keyer, genlock from CasparCG |
| FFmpeg Consumer | `ffmpeg_consumer.cpp` | ✅ Yes | VP9 alpha path in `ops/casparcg-test.md` |
| Genlock / frame-accurate sync | DeckLink hardware reference clock | ✅ Yes | REQ-7 mandatory for SDI |
| Output mode per channel | `output_mode` in channel config | ✅ Yes | browser / obs_vmix / decklink / stream |
| AMCP control | WebSocket `/ws/control` | ⚠️ Different protocol | Same take/update/clear semantics |
| Multi-channel | N × `bg_engine` processes | ✅ Equivalent | CPU affinity per channel |
| CPU-only HTML | `--disable-gpu`, enable-gpu false | ✅ Yes | GPU Gate §0.2.1 for any exception |
| NDI Consumer | — | ❌ Future | Phase 6+ |
| HDR / GPU HTML | — | ❌ Blocked | GPU Gate only |
| Sandbox `engine/` (broadcast-graphics) | Titulus `engine/` via CasparCG port | ❌ Not as-is | §0.4 — re-port, re-bench |
| Sandbox control plane (schema, WS, editor) | Titulus `backend/` `frontend/` `runtime/` | ⚠️ Partial | Cherry-pick validated pieces only |
| Git-driven delivery (branch/PR/merge) | §0.5 mandatory workflow | ✅ Yes | Orthogonal to architecture; enables rollback & session resume |

**Verdict:** описанная архитектура **совместима** с CasparCG render model. Control plane (React, SQLite, JSON schema, WS) — **наше отличие**. Render plane должен **сходиться с CasparCG**, а не изобретать альтернативы.

**Sandbox (`broadcast-graphics`):** control-plane идеи **частично совместимы** (§0.4 ✅); render plane sandbox **не совместим** как эталон — только skeleton/cherry-pick, финал = CasparCG port в Titulus `engine/`.

### 4.3 Process model


| Process                          | Count          | Role                           |
| -------------------------------- | -------------- | ------------------------------ |
| `backend`                        | 1              | API, WS hub, DB, media jobs    |
| `frontend` (dev) / static (prod) | 1              | UI                             |
| `bg_engine`                      | 1 per channel  | CEF render + output            |
| `ffmpeg` (child)                 | 0–1 per engine | Only if stream consumer active |


**CPU affinity:** each `bg_engine` pinned to **non-overlapping** core set via `taskset` / `CPUAffinity`.  
**Rule:** 2 dedicated physical cores per channel (minimum), no SCHED_RR/RT priority.

---

## 5. Repository structure

**Product root:** `Titulus/` (GitHub: Requestin/Titulus).  
**Dev server:** `/root/Titulus/`. Соседние каталоги SDK, CasparCG и sandbox — см. §0.3 (не часть git product tree).

```
Titulus/                     ← Requestin/Titulus (commit here)
├── docs/DEVELOPMENT_PROMPT.md    ← this document
├── backend/                 # Express API + WS + SQLite
│   ├── src/
│   │   ├── index.js         # WS routing, on-air state
│   │   ├── db.js            # SQLite schema + DAOs
│   │   ├── media.js         # ffmpeg transcode jobs
│   │   ├── templateValidation.js
│   │   └── routes/
│   └── public/
│       ├── channel.html     # Engine/browser renderer page
│       └── bg-runtime.js    # Built from runtime/ (not hand-edited)
├── frontend/                # React SPA
│   └── src/
│       ├── pages/           # Templates, Editor, Control, Settings, Renderer
│       ├── features/        # editor panels, ProgramMonitor, thumbnails
│       └── core/            # re-exports from @runtime
├── runtime/                 # Shared TypeScript package (SOURCE OF TRUTH for render logic)
│   └── src/
│       ├── schema.ts
│       ├── timeline.ts
│       ├── domRenderer.ts
│       ├── channelClient.ts
│       ├── stackOrder.ts
│       ├── transform.ts
│       ├── easing.ts
│       ├── clock.ts
│       └── fonts.ts
├── engine/                  # Native C++ render host (≈ one CasparCG channel per process)
│   ├── CASPARRCG_PORTING.md # Port tracking: CasparCG file → our file → status
│   ├── src/
│   │   ├── main.cpp
│   │   ├── engine_app.cpp   # CEF flags, message pump
│   │   ├── engine_client.cpp# OSR OnPaint
│   │   ├── config.cpp
│   │   ├── stats.cpp
│   │   └── consumers/       # decklink, ffmpeg, pipe, preview, null
│   ├── run-engines.sh       # Multi-channel supervisor
│   ├── run-channel.sh       # Single channel (systemd)
│   └── systemd/bg-engine@.service
├── shared/
│   └── template.schema.json # JSON Schema for AI + validation
├── bench/                   # Performance acceptance tests
├── docs/                    # Architecture, bench report, runbook
├── data/                    # app.db, uploads/ (gitignored)
├── fonts/                   # Bundled fonts for engine
├── start.sh / stop.sh
└── LICENSE.md               # Proprietary

# OUTSIDE git (dev server only, §0.3):
#   ../Blackmagic DeckLink SDK 16.0/
#   ../CasparCG/server/ + *.deb
#   ../broadcast-graphics/   ← sandbox reference (§0.4)
```

**Migration note:** при старте разработки можно **selectively** перенести модули из `/root/Titulus/broadcast-graphics/` в дерево Titulus (§0.4). Не делать wholesale copy — особенно `engine/`.

**Git:** весь product code в этом дереве версионируется через §0.5 (ветки → PR → `main`). Sandbox и CasparCG SDK **вне** git.

---

## 6. Shared runtime (`runtime/`)

### 6.1 Design rules

- **CasparCG HTML Producer equivalence:** `channel.html` + `bg-runtime.js` = content layer; `bg_engine` = CEF host. Together they must behave like CasparCG `CG ADD` + HTML template.
- **Single implementation** of template rendering — used by engine, editor preview, thumbnails, OBS browser source
- No GSAP — own easing + timeline engine (CasparCG templates also avoid external animation libs)
- No PIXI — pure DOM/CSS (CasparCG HTML Producer path)
- Build: esbuild → IIFE `bg-runtime.js` exposed as `window.BG`
- **Channel-paced clock:** in engine mode, animations MUST use fixed-step tick synced to channel fps (CasparCG rAF pattern), not wall-clock rAF

### 6.2 Template schema (domain model)

#### Canvas

```typescript
{ width: number; height: number; background: 'transparent' | '#rrggbb' }
```

#### Layer types


| Type    | DOM implementation       | Notes                                        |
| ------- | ------------------------ | -------------------------------------------- |
| `text`  | `<div>` + CSS typography | Google fonts via `document.fonts.load`       |
| `rect`  | `<div>`                  | fill, border, cornerRadius                   |
| `image` | `<img>`                  | fit: stretch/contain/cover                   |
| `video` | `<video>`                | VP9/WebM preferred; loop, muted, autoplay    |
| `clock` | text + timer             | modes: clock, countup, countdown             |
| `mask`  | CSS clip-path (preferred) | normal/inverted; clips layers below — **§6.5 perf rules** |


#### Groups

- Hierarchical transforms (parent/child)
- `rootStack` + `groupStacks` define z-order within groups
- Flatten to render order via `stackOrder.ts`

#### Variables

```typescript
{ id, name, label, type: 'text'|'image'|'number'|'color'|'video', defaultValue }
```

Binding: `{ type: 'variable', variableId: string }` on any string field.

#### Timeline

- Frame-based (not ms-based in storage)
- `directors[]`: named sequences with duration, offset, autostart, loop, swing
- `keyframes[]`: per-layer/per-group property values at frame N
- `trackDirectors`: map layer/group id → director id
- `actions[]`: future cue points
- Easing: linear, power2.in/out, bounce.out, elastic.out, custom bezier
- Playback modes: `bounded` | `infinite`
- Engine mode: **fixed-step** tick locked to engine fps (50 Hz)
- Browser preview mode: `requestAnimationFrame`

### 6.3 TemplateRenderer API

```typescript
class TemplateRenderer {
  constructor(stage: HTMLElement, width: number, height: number);
  syncTemplate(template: Template, variables: Record<string, string>): void;
  playTimeline(template: Template, variables: Record<string, string>, opts: {
    mode: 'fixed' | 'raf';
    fixedTickRate?: number;
  }): void;
  stopTimeline(): void;
  destroy(): void;
  resize(width: number, height: number): void;
}
```

**Behavior:**

- `syncTemplate` — diff DOM nodes vs template; create/update/remove
- `playTimeline` — start director/keyframe interpolation
- Static content after take: keep compositor alive — perpetual `requestAnimationFrame` heartbeat in `channel.html` (CasparCG HTML Producer always ticks with channel; required for CEF `OnPaint` under `external_begin_frame_enabled`)

### 6.4 ChannelClient API

```typescript
class ChannelClient {
  constructor(opts: {
    stage: HTMLElement;
    channelId?: string;
    backend?: string;
    playbackMode?: 'fixed' | 'raf';
    fixedTickRate?: number;
    onStatus?: (s: WsStatus) => void;
    onActiveCount?: (n: number) => void;
  });
  connect(): void;
  disconnect(): void;
}
```

**Stack semantics:** one `TemplateRenderer` per `templateId`; multiple templates coexist in `#stage` with absolute positioning.

### 6.5 Masks, alpha, and transparency (critical performance area)

**Requirement:** masks and alpha compositing must **not** cause disproportionate FPS loss. Target: **≤5% fps drop** vs equivalent scene without masks (§11.4).

#### Alpha pipeline (CasparCG-aligned)

- CEF OSR outputs **premultiplied or straight BGRA** consistently — document choice; DeckLink Fill+Key expects correct alpha in key channel
- Template canvas default: `background: transparent`
- Images/video: PNG/WebP alpha, VP9/WebM yuva420p — **no** CPU fallback that re-encodes per frame
- Port CasparCG mixer alpha compositing rules from `core/mixer` where DOM differs

#### Mask implementation rules (CPU-friendly)

**Preferred (fast on CPU Skia path):**
- `clip-path: inset()` / `polygon()` on dedicated mask layer wrapper
- Stacked mask containers with `overflow: hidden` for axis-aligned rects
- Single compositing layer per mask group — avoid deep nesting

**Avoid (perf killers on CPU CEF):**
- `filter: blur()` + mask on full 1080p every frame
- `backdrop-filter`
- Large `box-shadow` on full-frame layers (use sparingly; bench them)
- Canvas `getImageData` / second render pass for masks
- SVG filters, `mask-image` with large animated gradients every frame
- `mix-blend-mode` on full-frame unless bench proves ≤5% cost

#### Bench requirements for masks/alpha

Dedicated bench scene `bench/bench-alpha.html` (or section in `bench.html`):
- 5 templates with **mask clipping animated video/plates beneath**
- VP9/WebM alpha overlay
- Compare fps: same scene **with masks off** vs **on**
- Document in `docs/PHASE0_BENCH.md`; fail if overhead >5% without approved optimization plan

#### Video / image sequences

- Video layers: VP9/WebM+alpha (transcoded on upload) — same as CasparCG 2.5 WebM alpha support
- Image sequences: future via ffmpeg producer pattern; MVP = video WebM or animated timeline on static/vector plates
- All media decoded by CEF/ffmpeg — **no** per-frame JS pixel manipulation

---

## 7. Backend (`backend/`)

### 7.1 Stack

- Node.js 20+
- Express 4 + express-ws
- better-sqlite3 (WAL mode)
- multer (uploads)
- ajv (JSON Schema validation)
- uuid

### 7.2 SQLite schema

**templates**

- id, name, data (JSON), created_at, updated_at

**channels**

- id, name, **output_mode** (`browser`|`obs_vmix`|`decklink`|`stream`), device_index (-1 = no SDI), display_mode, keyer_mode, stream_url, created_at

**rundowns**

- id, name, slots (JSON array), channelId, sort_order, created_at, updated_at

**settings**

- key-value global fallback

**on_air**

- channel_id, template_id, command_json (full take command for replay)

### 7.3 REST API


| Method         | Path                      | Description                      |
| -------------- | ------------------------- | -------------------------------- |
| GET/POST       | `/api/templates`          | List / create                    |
| GET/PUT/DELETE | `/api/templates/:id`      | CRUD                             |
| GET            | `/api/templates/schema`   | JSON Schema                      |
| POST           | `/api/templates/validate` | Validate template JSON           |
| GET/POST       | `/api/channels`           | List / create (max 8)            |
| GET/PUT/DELETE | `/api/channels/:id`       | CRUD                             |
| GET/POST       | `/api/rundowns`           | List / create                    |
| PUT/DELETE     | `/api/rundowns/:id`       | Update / delete                  |
| POST           | `/api/rundowns/reorder`   | `{ ids: string[] }`              |
| GET/PUT        | `/api/settings`           | Global settings                  |
| POST           | `/api/uploads`            | multipart file upload            |
| GET            | `/api/uploads/jobs/:id`   | Video transcode status           |
| GET            | `/api/onair`              | `{ channelId: [templateId...] }` |
| GET            | `/api/preview/:channelId` | Latest JPEG from engine          |


Static: `/uploads/`*, `/fonts/`*, `/channel.html`, `/bg-runtime.js`

### 7.4 WebSocket protocol

#### `/ws/control` (Control Panel → Backend)

```jsonc
// TAKE — put template on air
{
  "type": "take",
  "templateId": "uuid",           // or rundown slotId
  "template": { /* full Template */ },
  "variables": { "varId": "value" },
  "channelId": "uuid"
}

// CLEAR — play out and remove
{ "type": "clear", "templateId": "uuid", "channelId": "uuid" }

// UPDATE — live variable change (debounced 400ms in UI)
{ "type": "update", "templateId": "uuid", "variables": { "varId": "new" }, "channelId": "uuid" }
```

Backend:

1. Updates in-memory `onAirState[channelId]`
2. Persists to SQLite `on_air`
3. Fan-out to all `/ws/renderer` clients registered for that `channelId`

#### `/ws/renderer?channel=<uuid>` (Engine → Backend)

- Engine connects as renderer client
- On connect: backend **replays** all current `take` commands for that channel (state recovery)
- Receives same JSON commands as control sent
- Auto-reconnect every 3s on disconnect

**Default channelId:** `"default"` if omitted.

### 7.5 Media pipeline

On video upload:

1. Save original to `data/uploads/`
2. Spawn ffmpeg: transcode → **VP9 WebM with alpha** (`libvpx-vp9`, `-auto-alt-ref 0`, yuva420p)
3. Generate poster JPEG
4. Job status: `pending` → `processing` → `ready` | `error`
5. Return `{ url, posterUrl, jobId }` — frontend polls until ready

Supported upload types: image/*, video/mp4, video/webm, video/quicktime. Max 200 MB.

---

## 8. Frontend (`frontend/`)

### 8.1 Stack

- React 18 + TypeScript 5
- Vite 5 (dev server port 3000)
- React Router 6
- Zustand + zundo (editor undo/redo)
- Tailwind CSS 3
- @dnd-kit (rundown/layer reorder)
- **No PIXI, no GSAP**

### 8.2 Routes


| Path          | Page          | Purpose                                              |
| ------------- | ------------- | ---------------------------------------------------- |
| `/templates`  | TemplatesPage | Gallery + create/delete                              |
| `/editor/:id` | EditorPage    | Template editor                                      |
| `/control`    | ControlPage   | Operator panel (TAKE/CLEAR/UPDATE)                   |
| `/settings`   | SettingsPage  | Channel/DeckLink config                              |
| `/renderer`   | RendererPage  | Browser/OBS output (thin wrapper over ChannelClient) |


### 8.3 Editor features (MVP)

- Canvas area: DOM preview via `@runtime/domRenderer` (same as air)
- Layers panel: z-order, visibility, lock, groups tree
- Properties panel: transform, style, variable bindings
- Variables panel: CRUD template variables
- Timeline panel: directors, keyframes, easing
- Toolbar: save, undo/redo, zoom, grid snap
- Upload images/video through backend API

### 8.4 Control Panel & Settings

- Tabs: **Templates** | **Rundowns**
- Channel selector per template/slot
- **Settings → Channels:** `output_mode` (browser / OBS·vMix / DeckLink / stream), DeckLink device, format, keyer
- Live variable editing with debounced UPDATE
- TAKE / CLEAR / CLEAR ALL
- **ProgramMonitor**: live JPEG from engine
- **Browser Source URL** copy button for OBS/vMix per channel
- WebSocket status indicator
- Restore on-air state on page load via `/api/onair`

### 8.5 Vite dev proxy

```typescript
proxy: {
  '/api': BACKEND,
  '/uploads': BACKEND,
  '/fonts': BACKEND,
  '/channel.html': BACKEND,
  '/bg-runtime.js': BACKEND,
  '/ws': { target: WS_BACKEND, ws: true },
}
```

---

## 9. Native render engine (`engine/` / `bg_engine`)

> **CasparCG reference:** treat `bg_engine` as a reimplementation of **one CasparCG channel** (HTML producer + mixer + consumers), not a new render paradigm. Before writing any module, read the corresponding CasparCG source under `src/modules/` and `src/core/`.

### 9.0 CasparCG modules to port (priority order)

1. **`modules/html/producer`** — CEF browser host, OSR paint callback, cache, reload, channel fps sync
2. **`modules/decklink/consumer`** — device enumeration, modes, keyer, scheduled output, interlace
3. **`modules/ffmpeg/consumer`** — pipe output, pixel format negotiation
4. **`core/mixer`** — interlaced frame semantics (for weave validation against CasparCG reference)
5. **`core/frame/`** — frame buffer conventions, color space

Create `engine/CASPARRCG_PORTING.md` during development: table of `{CasparCG file → our file → status}`.

### 9.1 Stack

- C++20, CMake ≥ 3.21
- CEF 148+ (Chromium 148; CasparCG 2.5 uses CEF 142 — same integration patterns, newer build OK)
- Blackmagic DeckLink SDK 16.0 Linux — **not in git**
- stb_image_write (JPEG preview)
- ffmpeg binary (consumer + media pipeline — CasparCG also uses ffmpeg 7.x in 2.5)
- **Reference repo clone (local, not submodule):** `CasparCG/server` tag `v2.5.0-stable`

### 9.2 CEF configuration (match CasparCG HTML producer defaults)

**CasparCG config equivalent (`casparcg.config`):**
```xml
<html>
  <enable-gpu>false</enable-gpu>
  <cache-path>/var/lib/bg/engine-cache/CHANNEL_ID</cache-path>
  <remote-debugging-port>0</remote-debugging-port>
</html>
```

**CefSettings:**

- `windowless_rendering_enabled = true`
- `external_begin_frame_enabled = true`
- No explicit `resources_dir_path` — auto-discover relative to `libcef.so`
- Unique `cache_path` per channel (avoid Chromium process singleton)
- `BUILD_RPATH = $ORIGIN` — find libcef.so regardless of cwd

**Command-line switches (via CefApp):**

```
--disable-gpu
--disable-gpu-compositing
--disable-dev-shm-usage
--no-sandbox
--no-zygote
--ozone-platform=headless
--single-process          # default; reduces overhead per channel
--force-device-scale-factor=1
```

**Do NOT use:** `--headless` (Chromium shell mode — breaks CEF Alloy OSR)

### 9.3 Main loop

```
while running:
  1. CefDoMessageLoopWork() via external message pump (OnScheduleMessagePumpWork)
  2. SendExternalBeginFrame(browser, true) at configured fps (50)
  3. OnPaint → BGRA buffer → stats + consumers
  4. Sleep until next frame deadline
```

### 9.4 EngineClient (CefRenderHandler)

- `GetViewRect` → configured width×height
- `GetScreenInfo` → device_scale_factor = 1.0
- `OnPaint` → copy BGRA to consumers (type=PET_VIEW only)
- `OnLoadingStateChange` → log ready state

### 9.5 CLI / config

```
--url=URL               # default: http://localhost:3001/channel.html?engine=1&channel=<id>
--name=STR              # log label / cache dir name
--width=1920 --height=1080
--fps=50
--duration=SEC          # 0 = infinite (bench uses 60)
--consumer=null|pipe|decklink|stream
--cache-dir=DIR         # REQUIRED unique per channel
--preview-out=PATH      # JPEG output path
--preview-fps=10
--device-index=N        # DeckLink sub-device
--display-mode=HD1080i50
--keyer=external|internal|fill_only
--stream-url=srt://...  # ffmpeg output URL
--pipe-fd=N / --out=FILE
--stats-interval=SEC
--multi-process           # disable single-process mode
```

Environment fallbacks: `BG_ENGINE_URL`, `BG_ENGINE_NAME`, `BG_ENGINE_CACHE_DIR`, etc.

### 9.6 Consumers

#### null

Discard frames — benchmark only.

#### pipe

Write raw BGRA to fd/file — debug with ffplay:

```bash
ffplay -f rawvideo -pixel_format bgra -video_size 1920x1080 /tmp/out.bgra
```

#### preview (PreviewWriter)

- Throttled JPEG (stb_image_write)
- Atomic rename (write `.tmp` → rename)
- Backend serves via `/api/preview/:channelId`

#### decklink (DeckLinkConsumer) — port from CasparCG

**Primary reference:** `CasparCG/server/src/modules/decklink/`

- Open sub-device by index (skip input-only devices via `DoesSupportVideoMode`)
- Profile check: prefer **2dfd** for external keyer; exit code **42** if profile switched → supervisor restarts after 6s (CasparCG uses similar restart semantics)
- Enable video output + keyer (`EnableExternalKeying` / `SetLevel(255)`)
- Preroll: 3 black frames before `StartScheduledPlayback`
- `ScheduledFrameCompleted` callback → schedule next frame at hardware clock
- **Weave interlace:** buffer last two progressive frames (a, b); for 1080i output, even lines from a, odd from b (UFF) — validate against CasparCG interlaced output on same test pattern
- OnFrame: push BGRA into staging buffers (no BGRA→ARGB conversion — CasparCG also avoids unnecessary conversion on Linux consumer path)
- Telemetry counters: completed, late, dropped, flushed

Supported display modes:
`HD1080i50`, `HD1080i5994`, `HD1080i6000`, `HD1080p25/30/50/5994/60`, `HD720p50/5994/60`

#### stream (FfmpegConsumer) — CasparCG ffmpeg consumer pattern

**Reference:** `CasparCG/server/src/modules/ffmpeg/consumer/` + validated VP9 alpha pipe-bridge in `ops/casparcg-test.md`

- Spawn ffmpeg child process
- Pipe raw BGRA stdin → encode → SRT/RTMP/UDP
- For alpha web delivery: VP9 WebM (yuva420p) — CasparCG 2.5 enables alpha for WebM
- Example: `--consumer=stream --stream-url=srt://host:9999?mode=caller`

### 9.7 Stats (acceptance metrics)

Per engine instance, log periodically:

- Effective fps
- Inter-frame interval: p50, p99, p999
- Late frame count (>1.5× expected interval)
- Drop percentage

Output `SUMMARY` line at end (for bench script parsing).

### 9.8 Multi-channel supervisor (`run-engines.sh`)

1. `GET /api/channels` from backend
2. For each channel: read **`output_mode`** → select consumer:
   - `decklink` → `--consumer=decklink` (requires `device_index >= 0`)
   - `stream` → `--consumer=stream --stream-url=...`
   - `browser` / `obs_vmix` → `--consumer=null` (CEF renders; URL served for browser/OBS; optional JPEG preview)
3. Compute CPU affinity slice (`taskset -c N-M`)
4. Launch `bg_engine` with unique `--cache-dir`
5. Restart loop: exit 42 → profile switch delay 6s; crash → 3s backoff

---

## 10. Channel page (`backend/public/channel.html`)

Query params:

- `channel=<uuid>` — channel id
- `engine=1` — fixed-step playback (for bg_engine)
- `engine_fps=50`
- `w=1920&h=1080` — output size
- `backend=host:port` — override backend
- `hud=1` — debug overlay
- `preview=1` — browser preview mode (not engine)

Loads `/bg-runtime.js`, creates `BG.ChannelClient`:

```javascript
new BG.ChannelClient({
  stage: document.getElementById('stage'),
  channelId: '...',
  playbackMode: engineMode ? 'fixed' : 'raf',
  fixedTickRate: 50,
});
```

**Critical:** perpetual `requestAnimationFrame` loop even when content is static — CEF external begin frame only paints on compositor damage; without heartbeat, OnPaint stops after static take.

---

## 11. Performance requirements & benchmark

### 11.1 Bench setup

File: `bench/bench.html` — 5 simultaneous lower-thirds (gradients, shadows, ticker, clock, spinner).

**Mandatory CasparCG baseline:** run the same HTML scene through CasparCG 2.5 HTML Producer on identical hardware; record fps/drops/CPU. Titulus `bg_engine` must be **≥ CasparCG** on these metrics.

```bash
./bench/run-bench.sh <channels> <duration_sec> <graphics_per_channel>
# MVP acceptance (minimum):
./bench/run-bench.sh 3 1800 5
# Stretch goal:
./bench/run-bench.sh 6 60 5
```

### 11.2 Acceptance criteria (Phase 0 / MVP)


| Metric | MVP (minimum) | Stretch |
| ------ | ------------- | ------- |
| Channels | **3** stable | 6 |
| Resolution | 1920×1080 @ 50 fps (1080i50 output path) | same |
| Graphics/channel | 5 (plates + masks + alpha video) | same |
| Duration | **30 min soak** per channel config | 8h SDI soak |
| Interval p50 | 20.0 ms | same |
| Drops | < 0.1% bare-metal | same |
| CPU | CPU-only; CasparCG baseline ≥ parity | same |
| CPU affinity | Non-overlapping cores per channel | same |

### 11.4 Mask & alpha performance bench (mandatory)

Scene must include (see §0.2.6, §6.5):
- animated lower-thirds with **mask** clipping content below
- VP9/WebM alpha video overlay
- compare **A:** all masks disabled vs **B:** masks enabled

| Metric | Target |
| ------ | ------ |
| FPS overhead (B vs A) | **≤ 5%** |
| Drops delta | ≤ +0.05% |
| CPU delta | document; optimize if >10% per channel |

Fail → optimize DOM/mask strategy before MVP sign-off (no GPU shortcut without GPU Gate).

### 11.3 Known constraints

- Each Chromium instance spawns thread pool ≈ visible CPU count → **must pin cores**
- Do NOT use SCHED_RR / realtime priority — makes it worse (RT throttling)
- VM jitter ≠ engine bug — final SDI + genlock acceptance on bare-metal with DeckLink
- **3 channels** ≈ 6+ dedicated cores + OS headroom (2 cores/channel rule)
- 6 channels (stretch) ≈ 12 cores + headroom → 16 physical cores recommended

---

## 12. Deployment

### 12.1 Dev

```bash
(cd backend && npm install)
(cd frontend && npm install)
(cd runtime && npm install && npm run build)
./start.sh                    # backend:3001 + frontend:3000
./engine/run-engines.sh       # after engine built
```

### 12.2 Production

- **backend:** systemd service, SQLite at `data/app.db`
- **frontend:** `vite build` → serve static from backend or nginx
- **engine:** `engine/systemd/bg-engine@.service` — one unit per channel UUID
  - `RestartForceExitStatus=42` for DeckLink profile switch
  - `CPUAffinity=0-1` per instance (example)
- **Preview dir:** `/run/bg/preview/` or `/tmp/bg-preview/`
- **Cache dir:** `/var/lib/bg/engine-cache/<channelId>/`

### 12.3 Hardware guidance (customer-facing)

- CPU-only render; **GPU not required** for MVP
- 2 physical cores per channel (1080p50, 5 templates with masks/alpha)
- **MVP: 3 channels** → 8+ physical cores (not vCPU)
- Stretch: 6 channels → 16+ physical cores
- DeckLink 8K Pro profile 2dfd → 2 Fill+Key channels per card
- External sync generator recommended for frame-accurate SDI (REQ-7)

---

## 13. Development phases (mandatory order)

> **Git rule (§0.5):** каждый deliverable фазы — отдельная ветка и merged PR в `main`.  
> Phase exit = PR merged + exit criteria met. Не переходить к Phase N+1 без merge checkpoint-ов Phase N.

### Phase 0 — Engine skeleton + CasparCG study + benchmark

**Goal:** Prove **3×1080p50** (MVP) CPU render at CasparCG parity; stretch 6 channels.

Deliver:

- [ ] Study `CasparCG/server` at `/root/Titulus/CasparCG/server` (v2.5.0-stable); document porting map in `engine/CASPARRCG_PORTING.md`
- [ ] CEF OSR host (port patterns from `modules/html/`)
- [ ] null + pipe consumers
- [ ] Frame stats
- [ ] bench/run-bench.sh + bench.html
- [ ] bench/bench.html + **mask/alpha stress scene** (§11.4)
- [ ] CasparCG baseline run on same hardware (document in `docs/PHASE0_BENCH.md`)
- [ ] Side-by-side SDI or pipe output comparison (CasparCG vs bg_engine)
- [ ] Genlock locked test on DeckLink hardware (when available)

**Exit criteria:** **3 channels** @ 50fps, 30min soak, masks/alpha overhead ≤5%; metrics ≥ CasparCG CPU baseline.

**Git milestones (example PRs):**
- [ ] `[Phase 0] engine skeleton + CASPARRCG_PORTING.md` → merged
- [ ] `[Phase 0] bench harness + mask/alpha stress scene` → merged
- [ ] `[Phase 0] PHASE0_BENCH report + CasparCG baseline compare` → merged

### Phase 1 — Shared runtime + channel page

**Goal:** Play real templates from DB through engine.

Deliver:

- [ ] runtime/ package (schema, timeline, domRenderer, channelClient) — may cherry-pick from sandbox §0.4, refactor for CasparCG clock
- [ ] esbuild → bg-runtime.js
- [ ] channel.html + WS client
- [ ] take/clear/update + replay

**Exit criteria:** Existing template JSON renders correctly; text/video/clock/**mask/alpha** work; animated transforms (x/y/rotate/scale).

**Git milestones:** `[Phase 1] runtime package`, `[Phase 1] channel.html + WS take/clear/update` → merged PRs

### Phase 2 — Editor + unified preview + output modes

**Goal:** Operator workflow; per-channel output selection (browser/OBS/DeckLink/stream).

Deliver:

- [ ] Editor canvas on DOM renderer (incl. mask editing)
- [ ] Thumbnails on DOM renderer
- [ ] JPEG preview consumer + ProgramMonitor
- [ ] Channel settings: `output_mode` (browser / obs_vmix / decklink / stream)
- [ ] Generated Browser Source URLs for OBS/vMix
- [ ] Remove all PIXI/GSAP/duplicate render code

**Exit criteria:** Full operator loop + switch channel output without redeploy.

**Git milestones:** `[Phase 2] editor DOM preview`, `[Phase 2] output modes + ProgramMonitor` → merged PRs

### Phase 3 — DeckLink SDI (CasparCG consumer port)

**Goal:** Production SDI Fill+Key on Linux — **functional parity with CasparCG DeckLink consumer**.

Deliver:

- [ ] decklink_consumer ported/validated against CasparCG reference (scheduled playback, weave, keyer)
- [ ] run-engines.sh supervisor with affinity
- [ ] systemd unit template
- [ ] Profile 2dfd auto-switch + exit 42 restart
- [ ] A/B test: same template on CasparCG channel vs bg_engine → indistinguishable on SDI monitor

**Exit criteria:** 8+ hours 1080i50 SDI, **genlock locked**, Fill+Key verified; CasparCG parity sign-off.

**Git milestones:** `[Phase 3] decklink consumer port`, `[Phase 3] supervisor + systemd deploy` → merged PRs

### Phase 4 — Backend hardening

**Goal:** Production-ready control plane.

Deliver:

- [ ] SQLite migration from any legacy JSON DB
- [ ] Persistent on-air state
- [ ] Media transcode pipeline (VP9/WebM+alpha)
- [ ] JSON Schema + validation API
- [ ] Remove dead routes / legacy decklink-out / Electron

**Exit criteria:** Backend restart preserves on-air; video upload transcodes and plays in template.

**Git milestones:** `[Phase 4] SQLite + on-air persistence`, `[Phase 4] media transcode pipeline` → merged PRs

### Phase 5 — Cloud outputs + AI foundation

**Goal:** Cloud deployment path + future AI.

Deliver:

- [ ] ffmpeg stream consumer (SRT/RTMP)
- [ ] shared/template.schema.json complete
- [ ] docs/ARCHITECTURE.md, docs/RUNBOOK.md

**Exit criteria:** SRT stream viewable; template validates against schema; runbook enables fresh server setup.

**Git milestones:** `[Phase 5] stream consumer`, `[Phase 5] ARCHITECTURE + RUNBOOK docs` → merged PRs

### Phase 6+ (future, not MVP)

- [ ] NDI output
- [ ] AI template generation module
- [ ] **GPU path** — only via GPU Gate doc (§0.2.1), never by default
- [ ] BeginFrame driven directly from hardware reference clock (single master clock)
- [ ] Multi-tenant SaaS auth + billing
- [ ] License key activation for on-prem
- [ ] Stretch: 6+ channels stable under same acceptance as 3-channel MVP

---

## 14. Rejected approaches (do not revisit without new evidence)


| Approach                                        | Why rejected                                               |
| ----------------------------------------------- | ---------------------------------------------------------- |
| **Embedding `casparcg-server` binary**          | Product must be **our** engine; CasparCG is reference only, not runtime dependency |
| Electron + offscreen BrowserWindow + Node addon | GPU readback, IPC copies, 20fps on Linux SDI; CasparCG never did this |
| Enabling GPU without GPU Gate doc | Violates CPU-only principle §0.2.1 |
| GPU readback (WebGL → CPU → SDI) | Forbidden in hot path |
| PIXI.js / WebGL primary renderer | Violates HTML5/CPU-only; CasparCG uses CEF HTML |
| NVIDIA GPUDirect                                | Needs professional GPU; bottleneck not PCIe for 1080p BGRA |
| DX11/DX12                                       | Windows-only                                               |
| WPE WebKit                                      | Not Chromium — breaks HTML template compatibility with CasparCG ecosystem |
| Single Chromium multi-tab multi-channel         | Process singleton + scheduler contention                   |
| lowdb / JSON file database                      | No transactions; no reliable on-air persistence            |
| Single giant PR without atomic commits | No rollback points; token limit = lost work (§0.5) |
| Direct commits to `main` bypassing PR   | Breaks review trail and feature-level revert        |
| Per-frame BGRA→ARGB conversion                  | DeckLink accepts BGRA; unnecessary vs CasparCG path        |
| Inventing custom render pipeline ignoring CasparCG | Reinvents 15+ years of broadcast-proven solutions       |


---

## 15. Testing checklist (final acceptance)

### Control plane

- [ ] Create/edit/delete template, channel, rundown
- [ ] Editor preview matches engine output (pixel-diff spot check)
- [ ] Undo/redo in editor
- [ ] Upload image → appears in template
- [ ] Upload MP4 → transcode → video layer plays with alpha

### On-air workflow

- [ ] TAKE template → appears on program monitor + SDI
- [ ] UPDATE variable → live change without re-take
- [ ] CLEAR → out animation (if timeline) → removed
- [ ] Multiple templates stacked on one channel
- [ ] Rundown PREV/NEXT/TAKE workflow
- [ ] Backend restart → on-air restored
- [ ] Engine restart → replay restores picture

### Performance

- [ ] bench **3ch** 30min soak ≥ 48 avg fps, drops < 0.1% bare-metal
- [ ] bench 4ch 60s drops < 0.2% (headroom test)
- [ ] **Mask/alpha overhead ≤ 5%** (§11.4)
- [ ] CasparCG CPU baseline comparison documented

### Masks & alpha

- [ ] Mask layer clips animated content correctly (normal + inverted)
- [ ] VP9/WebM alpha video composites without black fringe
- [ ] Fill+Key SDI alpha matches preview (no premultiply bugs)
- [ ] No FPS collapse with 5 templates including 2+ masks

### SDI + genlock (DeckLink hardware)

- [ ] 1080i50 external keyer Fill+Key
- [ ] **Genlock locked** — hardware reference clock drives output
- [ ] Weave motion smooth (50 fields) — compare to CasparCG
- [ ] 8h soak zero sustained drops (genlock connected)

---

## 16. Coding conventions

- TypeScript strict mode in frontend/runtime
- Single quotes, 2-space indent (match existing)
- No new render engine in frontend — always `@runtime`
- Engine C++: C++20, minimal deps, no exceptions in hot path
- Comments: only non-obvious business logic
- Don't add tests unless asked — but bench scripts required
- Proprietary LICENSE — no MIT on product code
- `.gitignore`: node_modules, CEF dist, `Blackmagic DeckLink SDK 16.0/`, `CasparCG/`, `broadcast-graphics/`, build/, data/app.db, uploads/, bg-runtime.js (generated)
- **Git (§0.5):** work only on feature branches; atomic commits; never leave dirty tree at session end; PR before merge to `main`

---

## 17. External dependencies (not in git)

**Dev server paths** (§0.3): все внешние артефакты лежат рядом с `/root/Titulus`, не в product git.


| Component               | Source                    | Dev server path / notes                      |
| ----------------------- | ------------------------- | -------------------------------------------- |
| CEF 148+ Linux64 minimal | cef-builds.spotifycdn.com | `/root/Titulus/engine/third_party/cef/` (download) |
| CasparCG Server source   | github.com/CasparCG/server | `/root/Titulus/CasparCG/server` — reference only (GPLv3+); not a runtime dependency |
| CasparCG .deb packages   | CasparCG releases         | `/root/Titulus/CasparCG/*.deb` — baseline bench install only |
| DeckLink SDK 16.0       | Blackmagic (out-of-band)  | `/root/Titulus/Blackmagic DeckLink SDK 16.0/Linux/include` |
| Sandbox reference       | Vasily113/broadcast-graphics | `/root/Titulus/broadcast-graphics` — read-only (§0.4) |
| Desktop Video driver    | Blackmagic installer      | libDeckLinkAPI.so runtime (system)           |
| ffmpeg                  | apt / static binary       | media transcode + stream consumer            |
| Node.js 20 LTS          | nvm or nodesource         | better-sqlite3 native build                  |


---

## 18. Glossary


| Term              | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| **CasparCG**      | Open-source broadcast graphics server (GPLv3+); **primary render reference** for `bg_engine`     |
| **HTML Producer** | CasparCG module: CEF-based HTML template renderer — our equivalent is `bg_engine` + `channel.html` |
| **Producer**      | CasparCG input source (HTML, ffmpeg, image) — we use DOM layers + media elements                 |
| **Mixer**         | CasparCG compositor — our equivalent is `domRenderer` stack + CEF compositor                     |
| **Consumer**      | CasparCG output sink (DeckLink, ffmpeg, NDI) — our `engine/src/consumers/`                     |
| **AMCP**          | CasparCG control protocol (TCP 5250) — we use WebSocket; semantics map to take/update/clear     |
| **Fill+Key**      | SDI external keying: Fill = color, Key = alpha matte                                             |
| **Genlock**       | External sync → DeckLink hardware reference clock; frame-accurate SDI |
| **GPU Gate**      | Mandatory research doc before any GPU enable (§0.2.1)              |
| **Output mode**   | Per-channel: browser / obs_vmix / decklink / stream                |
| **OSR**           | Off-screen rendering (CEF windowless mode)                                                       |
| **BeginFrame**    | CEF API to externally tick the compositor                                                        |
| **Weave / UFF**   | Interlace: combine two progressive frames into one interlaced frame, upper field first           |
| **2dfd**          | DeckLink profile: 2 Sub-Devices Full Duplex (supports external keyer)                            |
| **Rundown**       | Ordered list of template slots for show workflow                                                 |
| **Take**          | Command to put template on air (≈ CasparCG `CG ADD`)                                             |
| **Control plane** | Backend + frontend (management UI) — **our product layer**                                       |
| **Render plane**  | bg_engine processes (one per channel ≈ one CasparCG channel)                                     |
| **Feature branch**| Git branch per task; merged to `main` via PR (§0.5)                                                |
| **Checkpoint**    | Merged PR or pushed commit — resume point after agent session interrupt                            |


---

## 19. Agent execution notes

When implementing from scratch:

1. **Git-first (§0.5)** — перед кодом: `git pull`, ветка, после работы: commit → push → PR → merge → отчёт в чат. Задача done = merged PR.
2. **Work in Requestin/Titulus** (`/root/Titulus`) — not in sandbox repo as product home.
3. **CasparCG already on server** at `/root/Titulus/CasparCG/server` — use for porting; do not add as git submodule.
4. **Consult sandbox** at `/root/Titulus/broadcast-graphics` per §0.4 — cherry-pick only, never treat as spec.
5. **Start Phase 0 before any UI** — fail fast if CPU budget insufficient; **benchmark against CasparCG first**.
6. **For every engine module:** find CasparCG equivalent → port/adapt → document in `CASPARRCG_PORTING.md`.
7. **Build runtime/ before frontend editor** — editor depends on shared renderer.
8. **Never fork render logic** — if tempted to "quickly" add PIXI preview, stop.
9. **Test with real templates** from day 1 of Phase 1 — synthetic bench alone is insufficient.
10. **Engine cache dir per channel** — CasparCG `<cache-path>` equivalent; mandatory multi-channel.
11. **CEF rAF heartbeat + channel-paced clock** — CasparCG HTML producer behavior.
12. **CPU affinity in supervisor from day 1** — not an optimization, a requirement.
13. **Never ship `casparcg-server` dependency** — only our `bg_engine` binary.
14. **Document as you go** — ARCHITECTURE.md, RUNBOOK.md, PHASE0_BENCH.md, CASPARRCG_PORTING.md (each doc update = own commit/PR or part of feature PR).
15. **Keep `docs/DEVELOPMENT_PROMPT.md` in sync** — canonical spec lives under `docs/` only.
16. **On session start:** always `git fetch`, check open PRs and dirty tree before new work (§0.5.6).

**Definition of done for entire project:** Operator installs on fresh Ubuntu via RUNBOOK, configures 2 SDI channels, runs 4-hour broadcast with TAKE/UPDATE/CLEAR; picture matches editor preview; **SDI output indistinguishable from CasparCG on same templates/hardware**; **full Git history in `main` with revertible feature milestones**.

---

*Document version: 1.4 — Git-driven development mandatory (§0.5): branch → commit → push → PR → merge to main with detailed comments; phase checkpoints; session resume; architecture compatibility unchanged.*