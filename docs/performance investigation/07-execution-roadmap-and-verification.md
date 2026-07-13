# 07 — Execution Roadmap and Verification

**Серия:** Performance Investigation (docs 00–07)
**Статус:** master plan / living document
**Дата снимка:** 2026-07-13
**Целевое железо (baseline):** AMD Ryzen 5 3600 (6C/12T), DDR4 dual-channel, DeckLink Quad 2 + genlock
**Связанные фазы:** Phase 15–18 (merged), Phase 19 (Style Guide + cost model — в процессе)
**Constraints:** CPU-only CEF OSR, HTML5/DOM runtime, DeckLink scheduled playback + genlock, CasparCG = reimplement-by-reference only, git-workflow merge commits
**Тестовые шаблоны (canonical):** `test` = `tests/templates/test.json` (простой canary), `test1` = `tests/templates/test1.json` (сложный) — **все acceptance-критерии A1–A12 и gates считаются достигнутыми только на `tests/templates/test1.json`**

> Этот документ — **единственный master execution roadmap**, связывающий сестринские docs `00`–`06` в упорядоченный план с numeric gates, bench extensions, soak tests и Definition of Done. Реализация без прохождения gate предыдущего этапа — запрещена (кроме явно параллельных workstream).

---

## Оглавление

1. [Цель программы и hard acceptance](#1-цель-программы-и-hard-acceptance)
2. [Контекст: где мы сейчас](#2-контекст-где-мы-сейчас)
3. [Карта сестринских документов 00–06](#3-карта-сестринских-документов-0006)
4. [Упорядоченный workstream](#4-упорядоченный-workstream)
5. [Gate table между этапами](#5-gate-table-между-этапами)
6. [Команды измерения (канон)](#6-команды-измерения-канон)
7. [Bench harness extensions](#7-bench-harness-extensions)
8. [Definition of Done по workstream](#8-definition-of-done-по-workstream)
9. [Risk register и kill-switches](#9-risk-register-и-kill-switches)
10. [Rollback strategies](#10-rollback-strategies)
11. [Hardware portability checklist](#11-hardware-portability-checklist)
12. [Reporting template для milestone PR](#12-reporting-template-для-milestone-pr)
13. [Long-term: reopen true-50p DeckLink gate](#13-long-term-reopen-true-50p-decklink-gate)
14. [Weekly execution cadence](#14-weekly-execution-cadence)
15. [Матрица зависимостей и параллелизм](#15-матрица-зависимостей-и-параллелизм)
16. [Proportional scaling model](#16-proportional-scaling-model)
17. [Acceptance protocol (финальный)](#17-acceptance-protocol-финальный)
18. [Appendices](#18-appendices)

---

## 1. Цель программы и hard acceptance

### 1.1 Program goal (restatement)

Достичь **стабильного true 50p-as-50i** на **трёх одновременных DeckLink-каналах** `HD1080i50` со **сложными templates** (класс `test1`: много слоёв, группы, маски, анимации) на baseline-стенде Ryzen 5 3600, с genlock locked, без late/drop, с визуально приемлемым motion на reference monitor (TV Logic / эквивалент).

Формула цели:

```
3 × channel × complex_template × DeckLink(1080i50) × genlock
  → in_fps ≥ 50
  → high d_pairs (field pairs from distinct bitmaps)
  → d_late = 0 ∧ d_dropped = 0
  → visual OK (no judder vs cheap-content reference)
  → scale proportionally with CPU topology
```

Это **не** та же цель, что Phase 18 Fallback (сохранение SDI health при ~25 unique fps). Phase 18 доказал: weave/queue/pump уже готовы к 50p на cheap content; блокер — **content/raster cost**. Данная программа снимает этот блокер через cost model, raster reduction, memory, scheduling, (опционально) CEF options и layered compositor.

### 1.2 Hard acceptance criteria (numeric)

| # | Критерий | Порог | Окно | Среда |
|---|---|---|---|---|
| A1 | `in_fps` per channel | **≥ 50.0** avg; min window ≥ 48.0 | rolling 5s windows, last 12+ после steady | DeckLink 3ch soak |
| A2 | `d_pairs` per 5s window | **≥ 100** avg (целевое ~120–125 как на cheap); min ≥ 80 | same | DeckLink |
| A3 | `d_singles` per 5s | **≤ 20** avg (стремление → 0) | same | DeckLink |
| A4 | `d_late` | **= 0** сумма за весь soak | full soak | DeckLink |
| A5 | `d_dropped` | **= 0** сумма за весь soak | full soak | DeckLink |
| A6 | `d_flushed` / starved | документировать; hard fail если >0.1% fields | full soak | DeckLink |
| A7 | Genlock | `bmdReferenceLocked` continuous; 0 unlock events | full soak | DeckLink |
| A8 | Visual | motion на `test1` неотличимо от cheap true-50p reference на глаз оператора | P3.3 protocol | TV Logic |
| A9 | Channels | **3 simultaneous** complex templates (`test1` или cost-equivalent) | soak | Quad 2 |
| A10 | Duration | soak **≥ 15 min** (gate), **≥ 60 min** (release), **8h** (prod soak Phase 6.4-style) | — | DeckLink |
| A11 | Headless precondition | null/`--consumer=null` `test1` single-ch **≥ 45 fps**, ideally ≥ 50 | 60–180s | CI / headless |
| A12 | Regression cheap | empty/cheap template retains `in_fps≈50`, `d_pairs≈125` | 60s | DeckLink 1ch |

### 1.3 Soft / advisory criteria

| # | Критерий | Порог | Зачем |
|---|---|---|---|
| S1 | RasterTask CPU-sum p95 | ≤ 10 ms/frame на `test1` single | field budget 20 ms |
| S2 | End-to-end paint latency p95 | ≤ 18 ms BeginFrame→OnPaint | pairing window |
| S3 | Host CPU% (3ch) | ≤ 85% physical core budget of pinned set | headroom |
| S4 | Memory BW estimate | copies/frame ≤ 2× frame size end-to-end | doc 03 |
| S5 | Microfreeze events | 0 visible ≥100 ms stalls / 15 min | doc 06 |
| S6 | Null bench CI | 3ch null scenes green in CI | harness |

### 1.4 Non-goals (явно)

- GPU enablement / Vulkan / GL OSR — только через отдельный gate-doc вне этой программы.
- PIXI / GSAP / WebGL-as-primary — запрещено architecture non-negotiables.
- AMCP / CasparCG Client compatibility.
- Повтор dual-BeginFrame in-flight без новой CEF версии + повтор P0.2 (`pctTicksDeltaGe2`).
- Изменение browser/stream/self-timer path ради DeckLink experiments (кроме env-gated probes).
- Формальный claim «true 50p» при `in_fps≈25` и `d_pairs≈0` — запрещён.

### 1.5 Definition of program success

Программа **успешна**, когда A1–A12 выполнены на Ryzen 5 3600 **и** тот же protocol проходит на ≥1 более мощном стенде с proportional channel count (см. §16), с merge в `main` через git-workflow и rollback plan в каждом PR.

Программа **частично успешна**, если A11 выполнен (headless ≥45–50), но A1–A10 ещё нет — тогда открывается §13 true-50p DeckLink gate; это не провал, а переход фазы.

Программа **провалена**, если после прохождения всех workstream 00→02 (включая layered compositor) A11 всё ещё <40 fps на `test1` при соблюдении constraints — требуется пересмотр constraints (отдельный executive decision, не silent GPU).

---

## 2. Контекст: где мы сейчас

### 2.1 Доказанные факты (Phase 15–18)

| Факт | Evidence | Импликация для roadmap |
|---|---|---|
| Cheap/empty → true 50p уже есть | `in_fps≈50`, `d_pairs≈125`/5s | Output path OK |
| `test1` DeckLink → ~25 unique fps | P17/P18 soak | Content-bound |
| Headless `test1` ~27 fps | P18 P0.1 | Даже без DeckLink не хватает |
| RasterTask ~13.5 ms CPU-sum/frame | P18 P0.1 | Не ≤10 ms → Approach B rejected |
| Dual BeginFrame coalesced | `pctTicksDeltaGe2=0%` | Approach A rejected |
| Mojo ≪ RasterTask (~23×) | P18 P0.3 | Не IPC bottleneck |
| Class A transforms help | Phase 16 | Style/cost rules работают |
| Eager field packing safe | Phase 18 Fallback | Не вредит SDI health |
| Visual «без разницы» на test1 | P18 P3.3 | Metrics ↔ eye aligned |

### 2.2 Текущий потолок (честно)

```
empty / cheap  → in_fps≈50, d_pairs≈125  → true 50p-as-50i УЖЕ есть
test1 complex  → in_fps≈25, d_pairs≈0–3 → CEF не успевает 2-й unique paint
                за 40 ms output frame (1080i50)
```

### 2.3 Что roadmap НЕ повторяет

- Pump-трюки без снижения frame cost.
- Увеличение raster threads как единственный lever (P17: не снимает DeckLink ceiling).
- Слепое копирование CasparCG GPU mixer.
- Phase 14 microfreeze plan как authoritative (пересматриваем в doc 06).

### 2.4 Связь с Phase 19

Phase 19 (Style Guide + cost model) = **первый исполнимый кусок** workstream 00 + частично 01. Этот roadmap обобщает Phase 19 в многонедельный program с параллельными треками 03/04/06 и поздним 02.

---

## 3. Карта сестринских документов 00–06

| Doc | Файл | Роль в программе | Тип работы |
|---|---|---|---|
| 00 | `00-overview-and-cost-model.md` | Cost model, budgets, feature cost matrix, Style Guide foundation | Measure + policy |
| 01 | `01-blink-raster-cost-reduction.md` | Снижение Blink/Skia cost: beacon, CSS, masks, layers, runtime | Implement + measure |
| 02 | `02-cpu-layer-compositor.md` | Own CPU layered compositor (main architectural bet) | Architecture |
| 03 | `03-zero-copy-memory-pipeline.md` | Fewer copies, FrameRing/weave ownership, BW | Implement |
| 04 | `04-scheduling-os-and-genlock.md` | Pinning, isolcpus, SCHED_FIFO, genlock, topology | Ops + engine |
| 05 | `05-cef-pipeline-and-upgrade.md` | CEF options/upgrade; pull-model ideas; probes | Conditional |
| 06 | `06-microfreeze-elimination.md` | Microfreeze instrumentation + fixes | Parallel quality |
| 07 | `07-execution-roadmap-and-verification.md` | **Этот документ** — порядок, gates, DoD | Governance |

### 3.1 Принцип чтения

1. Читать 00 → понять budgets.
2. Исполнять по §4, сверяя gates §5.
3. Детали реализации — только в sister doc; roadmap не дублирует код-дизайн, только **порядок и пороги**.
4. При конфликте: `architecture.mdc` > этот roadmap > sister doc detail > ad-hoc experiment.

### 3.2 Артефакты на диск

Каждый workstream пишет evidence в:

```
engine/research/results/pi07/<WS>-<YYYYMMDD>/
  baseline.json
  gate.md
  soak-summary.md
  commands.sh
  raw-logs/
```

Naming: `WS` ∈ {`00`,`01`,`03`,`04`,`06`,`05`,`02`,`FV`} (FV = final verification).

---

## 4. Упорядоченный workstream

### 4.0 Диаграмма порядка

```
                    ┌─────────────────┐
                    │ 00 Cost model  │
                    │   baseline     │
                    └────────┬────────┘
                             │ GATE-00
                             ▼
                    ┌─────────────────┐
                    │ 01 Raster cost │
                    │   reduction    │
                    └────────┬────────┘
                             │ GATE-01
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ 03 Memory│  │ 04 Sched │  │ 06 Micro │
       │ zero-copy│  │ OS/genlk │  │ freeze   │
       └────┬─────┘  └────┬─────┘  └────┬─────┘
            │ GATE-03     │ GATE-04     │ GATE-06
            └──────────────┼──────────────┘
                           ▼
              ┌─────────────────────────┐
              │ Decision: headless      │
              │ test1 ≥45–50 ?          │
              └────────────┬────────────┘
                     no / maybe│yes
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌──────────────┐              ┌──────────────────┐
     │ 05 CEF opts  │              │ Skip 05 or light │
     │ if needed    │              │ CEF hygiene only │
     └──────┬───────┘              └────────┬─────────┘
            │ GATE-05                       │
            └───────────────┬───────────────┘
                            ▼
              ┌─────────────────────────┐
              │ Still below gate?       │
              └────────────┬────────────┘
                     yes   │   no
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌──────────────┐         ┌─────────────────┐
     │ 02 Layered   │         │ Final verify FV │
     │ compositor   │────────▶│ DeckLink soak   │
     └──────────────┘         └─────────────────┘
```

### 4.1 WS-00 — Cost model baseline

**Вход:** `main` post-PR#61 (Phase 18).
**Выход:** задокументированный cost model + Style Guide v0 + baseline numbers на `test` / `test1` / empty.
**Sister:** `00-overview-and-cost-model.md`.

Шаги (кратко; детали в 00):

1. Зафиксировать frame budgets: 20 ms/field, 40 ms/frame @1080i50.
2. Снять baseline matrix: empty, `test`, `test1`, synthetic feature scenes.
3. Построить feature cost table (gradients, masks, blur, text, images, filters, 2.5D).
4. Опубликовать Style Guide rules (запреты / дорогие / дешёвые паттерны).
5. Определить «cost unit» и target envelope для complex template.

**Запрещено на WS-00:** менять engine hot path; только measure + docs + template policy.

### 4.2 WS-01 — Raster cost reduction

**Вход:** GATE-00 PASS.
**Выход:** measurable снижение RasterTask / рост headless fps на `test1`.
**Sister:** `01-blink-raster-cost-reduction.md`.

Приоритетный порядок levers (из 01):

1. Template/Style conformance (`test1` → cost-reduced variant `test1-lite` A/B).
2. Damage/beacon strategy (сохранить OSR awake без full-frame tax где возможно).
3. Runtime DOM/CSS reductions (Class A transforms, avoid expensive paint).
4. Layer promotion / contain / will-change discipline (Phase 16 lessons).
5. Mask/path simplification.
6. Text/image atlas hygiene.

**Параллельно запрещено:** начинать 02 compositor до GATE-01 (нужен доказанный delta без архитектуры).

### 4.3 Parallel band: WS-03 + WS-04 + WS-06

После GATE-01 три трека **параллельны** (разные owners / разные PR):

| Track | Focus | Не блокирует |
|---|---|---|
| 03 | zero-copy / fewer-copy memory | 04, 06 |
| 04 | pinning, isolcpus, genlock ops | 03, 06 |
| 06 | microfreeze instrumentation first, then fixes | 03, 04 |

Правило merge: каждый PR независим; интеграционный soak после всех трёх GATE.

### 4.4 Decision node D1 — нужен ли WS-05?

После GATE-03/04/06 и повторного headless measure:

| Условие | Действие |
|---|---|
| Headless `test1` ≥ 45 fps (лучше ≥50) | **Skip heavy 05**; только CEF hygiene checklist |
| 40 ≤ fps < 45 | **Light 05**: flags, upgrade eval, pull-model spike (time-boxed) |
| fps < 40 | **Full 05** по doc; затем re-measure before 02 |
| P0.2 dual BF suddenly works on new CEF | Reopen Approach A under 05 gate only |

### 4.5 WS-02 — Layered compositor (conditional main bet)

**Вход:** D1 resolved; still below A11 or clear that monolithic CEF page cannot hit budget.
**Выход:** static layers cached; dirty-only CEF rasters; CPU blend; gate vs monolithic.
**Sister:** `02-cpu-layer-compositor.md`.

Kill-switch: если spike POC не даёт ≥1.5× unique fps vs best WS-01 template на same HW за time-box 2 недели — stop architecture, escalate.

### 4.6 FV — Final verification

Полный protocol §17: null → single DeckLink → 3ch 15min → 60min → visual → scaling check.

---

## 5. Gate table между этапами

### 5.1 Легенда статусов

| Status | Значение |
|---|---|
| PASS | Все hard rows зелёные; можно next WS |
| PASS-WITH-WAIVER | 1 soft miss, письменный waiver в PR |
| FAIL | Hard miss; stop; rollback or iterate |
| BLOCKED | External (HW, CEF build); не считать FAIL подхода |

### 5.2 GATE-00 (после cost model baseline)

| Metric | Command / method | Pass | Fail |
|---|---|---|---|
| Baseline pack published | `engine/research/results/pi07/00-*/gate.md` exists | file+numbers | missing |
| empty null fps | §6.1 null empty 60s | ≥ 50 | < 48 |
| `test` null fps | §6.1 | ≥ 45 | < 40 |
| `test1` null fps | §6.1 | record (expect ~25–30) | n/a (baseline) |
| Feature cost matrix | doc 00 table filled ≥12 features | yes | incomplete |
| Style Guide v0 | merged docs PR | yes | no |
| No engine hot-path churn | `git diff` scope docs/templates only | yes | engine changes without bench |

### 5.3 GATE-01 (raster cost)

| Metric | Command | Pass | Fail / kill |
|---|---|---|---|
| Headless `test1` fps | §6.1 | **≥ 35** (interim) или +30% vs GATE-00 | < +10% after 2 iterations |
| RasterTask CPU-sum p95 | blink research / frame-log | ≤ 12 ms или −20% | no change |
| Cheap regression | empty null | ≥ 50 | < 48 |
| DeckLink 1ch smoke | §6.3 60s `test1` | late/drop=0; in_fps ≥ baseline | late>0 |
| Visual no regression | operator note | OK | worse than baseline |

**Stretch target внутри 01:** headless ≥45 — тогда D1 может skip 05 early.

### 5.4 GATE-03 (memory)

| Metric | Command | Pass | Fail |
|---|---|---|---|
| Copies/frame documented | doc 03 + counter or estimate | ≤ 2 full-frame equiv | unexplained ≥4 |
| Null fps non-regress | §6.1 `test1` | ≥ GATE-01 −2% | >3% regression |
| 3ch null CPU% | §6.2 | ≤ prior or −5% abs | +10% abs |
| DeckLink late/drop | §6.3 1ch 5min | 0/0 | any |
| AddressSanitizer/smoke | optional local | clean hot path | use-after-free |

### 5.5 GATE-04 (scheduling / genlock)

| Metric | Command | Pass | Fail |
|---|---|---|---|
| Auto topology script | §11 | pins 3ch without overlap | overlap / wrong CCX |
| Genlock locked | DeckLink API / logs | continuous | unlock |
| 3ch soak 15min | §6.4 | late/drop=0; in_fps ≥ prior | late>0 or in_fps−5% |
| SCHED_FIFO soft-fail documented | runbook | yes | silent fail |
| OS noise (optional isolcpus) | before/after | microfreeze↓ or fps↑ | worse jitter |

### 5.6 GATE-06 (microfreeze)

| Metric | Command | Pass | Fail |
|---|---|---|---|
| Instrumentation merged | frame-log markers | yes | no |
| Event rate | 15min soak classify | ≤ 1 unexplained /15min | periodic 5–11s unexplained |
| Hypothesis ranked | doc 06 | top-1 tested | untested |
| SDI health | late/drop | 0/0 | any |

Note: GATE-06 **не** требует complete elimination для перехода к D1, но требует **instrumentation + ranked evidence**. Elimination may continue in parallel with 05/02.

### 5.7 GATE-05 (CEF, conditional)

| Metric | Command | Pass | Fail / kill |
|---|---|---|---|
| Time-box | calendar | ≤ 10 working days heavy spike | overrun without delta |
| Headless delta | §6.1 | ≥ +10% fps or unlock dual-BF evidence | <5% and no new fact |
| P0.2 re-probe if upgrade | `BG_P18_PIPELINE_PROBE=1` | document pctTicksDeltaGe2 | ignore |
| Null/browser path untouched | code review | yes | accidental self-timer change |
| Rollback ready | revert merge | yes | no |

### 5.8 GATE-02 (layered compositor)

| Metric | Command | Pass | Fail / kill |
|---|---|---|---|
| POC fps | null `test1` layered | ≥ 1.5× best monolithic | <1.2× after time-box |
| Correctness | visual A/B stills | pixel tolerance agreed | obvious glitches |
| 3ch DeckLink | §6.4 | A4/A5; in_fps↑ | late/drop |
| CPU-only preserved | flags | no GPU | GPU sneak |
| HTML5 runtime preserved | architecture | yes | alternate renderer primary |

### 5.9 GATE-FV (final)

Все A1–A12. См. §17 checklist.

### 5.10 Сводная gate timeline

| Order | Gate | Typical wall time | Blocking? |
|---|---|---|---|
| 1 | GATE-00 | 3–5 days | yes |
| 2 | GATE-01 | 1–3 weeks | yes |
| 3a | GATE-03 | 1–2 weeks | parallel |
| 3b | GATE-04 | 3–10 days | parallel |
| 3c | GATE-06 | 1–2 weeks instr | parallel |
| 4 | D1 | 1 day | yes |
| 5 | GATE-05 | 0–2 weeks | conditional |
| 6 | GATE-02 | 2–6 weeks | conditional |
| 7 | GATE-FV | 3–5 days | yes |

---

## 6. Команды измерения (канон)

Все gates используют **один набор команд**. Не изобретать one-off scripts без добавления в harness (§7).

### 6.0 Preconditions

```bash
cd /home/requestin/Titulus
git status
pgrep -af 'bg_engine|run-channel|run-engines' || true
# Убедиться, что нет чужих engine; иначе kill supervisor tree (см. RUNBOOK)
test -x engine/build/Release/bg_engine || \
  (cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j)
```

### 6.1 Null / headless single-channel

```bash
# EMPTY
./engine/build/Release/bg_engine \
  --consumer=null --width=1920 --height=1080 --fps=50 \
  --duration=60 --stats-interval=5 \
  --url="file://${PWD}/bench/bench.html?graphics=0" \
  --cache-dir=/tmp/pi07-null-empty --name=pi07-empty \
  | tee /tmp/pi07-empty.log

# TEST1 via channel.html / template URL — adapt to local serve path
# Prefer backend-served template take path when measuring real test1:
# TITULUS_DATA=/tmp/pi07-data PORT=3012 node backend/src/index.js
# then engine --url=http://127.0.0.1:3012/channel.html?...
```

Parse SUMMARY / Progress lines for fps. Record into `baseline.json`:

```json
{
  "ws": "01",
  "scene": "test1",
  "consumer": "null",
  "channels": 1,
  "fps_avg": 0.0,
  "fps_min_window": 0.0,
  "host": "ryzen5-3600",
  "git": "REPLACE_SHA"
}
```

### 6.2 Multi-channel null bench (CI-friendly)

```bash
./bench/run-bench.sh 3 60 5
# Extended scenes (after §7 lands):
# SCENE=bench-test1-cost.html ./bench/run-bench.sh 3 120 1
```

CI acceptance (proposed): drops < 0.1%, fps ≥ configured floor per scene.

### 6.3 Single DeckLink smoke

```bash
./engine/build/Release/bg_engine \
  --consumer=decklink --device-index=1 --display-mode=HD1080i50 \
  --keyer=external --fps=50 --duration=60 \
  --url="URL_TO_TEST1" \
  --cache-dir=/tmp/pi07-dl1 --name=pi07-dl1 \
  | tee /tmp/pi07-dl1.log

# Extract telemetry windows:
rg -n 'telemetry5s|in_fps|d_pairs|d_late|d_dropped|Reference' /tmp/pi07-dl1.log
```

### 6.4 Three-channel DeckLink soak

```bash
# Prefer supervised path:
# ./engine/run-engines.sh  (configured 3 decklink channels)
# Then TAKE test1 on each channel via control plane.
# Duration: 900s (gate) / 3600s (release)

OUT_ROOT=/tmp/pi07-soak ./engine/collect-decklink-evidence.sh
```

Manual parse pattern (per channel log):

```bash
python3 - <<'PY'
import re,sys,statistics as st
# paste or read logs; compute avg in_fps, sum d_late, sum d_dropped, avg d_pairs
print('see engine/research helpers if present')
PY
```

### 6.5 Genlock check

```bash
rg -n 'Reference|genlock|bmdReference|locked|unlocked' /tmp/pi07-dl*.log logs/dev/engines.log
# Expect continuous locked; any unlock = FAIL GATE-04/FV
```

### 6.6 Blink / raster budget

```bash
./engine/run-blink-research.sh
# or engine flags --blink-research=1 --frame-log=/tmp/pi07-frames.csv
```

Compare RasterTask sums vs GATE-00 baseline.

### 6.7 Microfreeze capture

```bash
# Enable frame-log + pump_active_us (doc 06)
BG_FRAME_LOG=/tmp/pi07-mf.csv \
./engine/build/Release/bg_engine --consumer=decklink ...
# Post-process gaps > 40ms between paints / schedule completions
```

### 6.8 Visual protocol (P3.3-style)

1. Warm-up 30s cheap content (confirm smooth true-50p).
2. TAKE `test1` on all 3 channels.
3. Observe 120s on TV Logic; note judder/microfreeze.
4. Blind A/B if possible (operator doesn't know build).
5. Write `visual.md`: PASS/FAIL + one sentence.

---

## 7. Bench harness extensions

### 7.1 Зачем расширять harness

Текущий `bench/run-bench.sh` закрывает MVP 3ch null @ synthetic `bench.html`. Для программы PI07 нужны:

1. Сцены, коррелирующие с `test1` cost (не только graphics=N sprites).
2. CI-friendly null benches без DeckLink.
3. DeckLink soak scripts с парсером A1–A7.
4. Воспроизводимые артефакты JSON для PR.

### 7.2 New scenes (proposed files)

| Scene file | Purpose | Gate usage |
|---|---|---|
| `bench/bench-empty.html` | awake beacon only | A12 / cheap |
| `bench/bench-cheap-motion.html` | simple X/Y loop | true-50p reference |
| `bench/bench-cost-gradients.html` | gradient stress | doc 00 matrix |
| `bench/bench-cost-masks.html` | mask stack | doc 01 |
| `bench/bench-cost-blur.html` | filter blur | kill expensive |
| `bench/bench-cost-text-crawl.html` | text heavy | doc 01 |
| `bench/bench-test1-proxy.html` | static approximation of test1 layer count | GATE-01 CI |
| `bench/bench-layered-poc.html` | layered compositor harness | GATE-02 |
| existing `bench-25d.html`, `bench-mask-stack.html`, `bench-alpha.html` | keep | regression |

### 7.3 CI-friendly null benches

Требования к CI job `pi07-null`:

- No DeckLink dependency.
- Duration ≤ 60s per scene (cost control).
- Matrix: empty, cheap, mask-stack, test1-proxy × 1ch and 3ch.
- Artifacts: SUMMARY lines + `bench-out.json`.
- Fail if fps < scene floor OR drops ≥ 0.1%.

Proposed floors (Ryzen 5 3600 reference; scale in §16):

| Scene | 1ch floor | 3ch per-ch floor |
|---|---:|---:|
| empty | 50 | 50 |
| cheap-motion | 50 | 48 |
| mask-stack | 40 | 35 |
| test1-proxy (pre-01) | 25 | 22 |
| test1-proxy (post-01 target) | 45 | 40 |
| test1-proxy (FV target) | 50 | 48 |

```bash
# Example CI invocation (to be added)
./bench/run-bench.sh 3 60 5
SCENE_URL=file://$PWD/bench/bench-cheap-motion.html ./bench/run-bench-scene.sh 3 60
```

### 7.4 DeckLink soak scripts

Proposed: `bench/run-decklink-soak.sh`

```bash
#!/usr/bin/env bash
# Usage: ./bench/run-decklink-soak.sh <channels> <duration_sec> <template>
# Env: DEVICE_BASE=1 DISPLAY_MODE=HD1080i50 KEYER=external
set -euo pipefail
CHANNELS=${1:-3}
DURATION=${2:-900}
TEMPLATE=${3:-test1}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT_ROOT:-/tmp/pi07-soak-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
echo "[soak] out=$OUT channels=$CHANNELS duration=$DURATION template=$TEMPLATE"
# Launch via run-engines or N× bg_engine pinned — implementation in PR
# Parse logs → $OUT/gate.json with A1–A7 booleans
```

Parser requirements (`bench/parse-telemetry.py`):

- Input: per-channel logs.
- Output JSON: `in_fps_avg`, `in_fps_min`, `d_pairs_avg`, `d_late_sum`, `d_dropped_sum`, `genlock_ok`.
- Exit code 0 iff hard gates pass for selected profile (`smoke|gate|release`).

Profiles:

| Profile | Duration | in_fps | d_pairs | late/drop |
|---|---:|---:|---:|---|
| smoke | 60 | ≥ 24.5 interim / ≥48 post | record | 0/0 |
| gate | 900 | ≥ 50 | ≥ 100 | 0/0 |
| release | 3600 | ≥ 50 | ≥ 100 | 0/0 |
| marathon | 28800 | ≥ 49.5 | ≥ 90 | 0/0 |

### 7.5 Evidence bundle layout

```
engine/research/results/pi07/
  00-20260713/
  01-.../
  ...
  FV-.../
    gate.json
    gate.md
    visual.md
    host.json          # lscpu, meminfo, decklink info
    commands.sh
    raw-logs/
```

### 7.6 Definition of harness DoD

- [ ] New scenes merged
- [ ] `run-bench-scene.sh` or SCENE_URL support
- [ ] `parse-telemetry.py` with profiles
- [ ] `run-decklink-soak.sh` documented in RUNBOOK
- [ ] CI job for null matrix (optional initially: manual)
- [ ] README in `bench/` updated

---

## 8. Definition of Done по workstream

### 8.0 Общий DoD (каждый WS)

1. Sister doc section «Measurement» заполнена актуальными числами.
2. Evidence dir `pi07/<WS>-*/` committed or linked from PR (large logs — summary only).
3. Gate table §5 для WS = PASS (или waiver).
4. PR merged в `main` через `gh pr merge --merge`.
5. Rollback one-liner в PR body.
6. Не сломан cheap true-50p (A12).
7. Не тронут browser/stream path без явного justification.

### 8.1 DoD — WS-00 (ссылка на `00-overview-and-cost-model.md`)

- [ ] Cost model: budgets 20/40 ms объяснены
- [ ] Baseline numbers: empty / test / test1 (null + optional 1ch DL)
- [ ] Feature cost matrix ≥12 rows with relative cost
- [ ] Style Guide v0: do/don't для editors
- [ ] GATE-00 PASS
- [ ] Phase 19 kickoff aligned

### 8.2 DoD — WS-01 (`01-blink-raster-cost-reduction.md`)

- [ ] At least 2 levers landed with before/after
- [ ] Headless `test1` meets GATE-01 interim (≥35 or +30%)
- [ ] RasterTask or equivalent metric improved
- [ ] `test1-lite` or Style-conforming variant documented
- [ ] Beacon/damage strategy decision recorded
- [ ] GATE-01 PASS

### 8.3 DoD — WS-03 (`03-zero-copy-memory-pipeline.md`)

- [ ] Copy-chain inventory before/after
- [ ] At least one fewer full-frame memcpy on hot path OR ownership swap
- [ ] BW math updated for 3×1080p50
- [ ] No late/drop regression
- [ ] GATE-03 PASS

### 8.4 DoD — WS-04 (`04-scheduling-os-and-genlock.md`)

- [ ] Auto topology script for Ryzen 5 3600 + generic
- [ ] Pinning map documented (CCX-aware)
- [ ] Genlock verification steps in RUNBOOK
- [ ] Optional isolcpus evaluated with evidence
- [ ] GATE-04 PASS

### 8.5 DoD — WS-06 (`06-microfreeze-elimination.md`)

- [ ] Instrumentation capable of detecting 5–11s periodic stalls
- [ ] Hypotheses ranked with tests
- [ ] At least top hypothesis accepted or rejected with data
- [ ] Operator-visible freezes reduced or explained
- [ ] GATE-06 PASS (instrumentation minimum)

### 8.6 DoD — WS-05 (`05-cef-pipeline-and-upgrade.md`) — conditional

- [ ] D1 decision recorded
- [ ] If executed: time-box respected
- [ ] Delta ≥ gate OR kill-switch fired with write-up
- [ ] P0.2 re-run if CEF upgraded
- [ ] GATE-05 PASS or SKIP documented

### 8.7 DoD — WS-02 (`02-cpu-layer-compositor.md`) — conditional

- [ ] Architecture spike merged or rejected via kill-switch
- [ ] If merged: 1.5× rule met
- [ ] CPU-only + HTML5 constraints preserved
- [ ] CasparCG: patterns reimplemented, no GPL copy
- [ ] GATE-02 PASS or SKIP

### 8.8 DoD — Final verification

- [ ] A1–A12 all PASS on Ryzen 5 3600
- [ ] Scaling checklist §11/§16 on second host OR paper model signed
- [ ] Program report PR merged
- [ ] development-plan / phase doc updated (Phase 19+ closure)

---

## 9. Risk register и kill-switches

### 9.1 Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner WS |
|---|---|---|---|---|---|
| R1 | `test1` intrinsic cost irreducible under HTML5/CPU | M | H | Style Guide + layered 02 | 00/01/02 |
| R2 | Layered compositor too large / unstable | M | H | time-box + kill-switch K2 | 02 |
| R3 | Zero-copy introduces tearing/UAF | M | H | staged PR, ASan, soak | 03 |
| R4 | isolcpus breaks desktop/dev UX | L | M | optional profile, not default | 04 |
| R5 | CEF upgrade regresses OSR | M | H | pin version, probe matrix | 05 |
| R6 | Microfreeze is driver-only | M | M | evidence vs Blackmagic; workaround | 06 |
| R7 | False claim true-50p from telemetry misread | M | H | d_pairs gate mandatory | FV |
| R8 | Parallel PR conflicts in engine/ | H | M | narrow scopes; merge order 03→04 | all |
| R9 | CI flaky null benches | M | L | longer warm-up; floors with slack | harness |
| R10 | Genlock unlock under load | L | H | cable/ref check; fail gate | 04/FV |
| R11 | Operator visual disagrees with metrics | M | M | blind A/B; trust eye for A8 | FV |
| R12 | Scope creep into GPU | L | H | architecture non-negotiable | governance |
| R13 | Memory BW saturates before raster fixed | M | M | do 03 after 01; measure | 03 |
| R14 | SMT/CCX mis-pinning hides gains | H | M | auto topology | 04 |
| R15 | Template editors ignore Style Guide | H | H | lint/validate in backend | 00 |

### 9.2 Kill-switches (when to stop an approach)

| ID | Approach | Trip condition | Action |
|---|---|---|---|
| K0 | Any pump-only trick | no d_pairs↑ after 1 week | stop; return to cost |
| K1 | WS-01 lever | <5% fps after 2 full iterations | abandon lever; next lever |
| K2 | WS-02 compositor | <1.2× after 2-week POC | archive spike; escalate constraints |
| K3 | WS-03 zero-copy | any late/drop in soak OR UAF | immediate `git revert` merge |
| K4 | WS-04 isolcpus | worse jitter or unlock genlock | disable cmdline; keep pinning only |
| K5 | WS-05 CEF upgrade | OSR paint regression OR browser path break | revert; pin old CEF |
| K6 | WS-05 dual-BF retry | pctTicksDeltaGe2 still 0% | do not merge pump changes |
| K7 | WS-06 THP/GC fix | no change in periodic spectrum | demote hypothesis; next |
| K8 | Program | post-02 headless still <40 | executive review; no silent GPU |

### 9.3 Escalation path

```
Engineer finds trip → write kill.md in evidence dir → stop PR merge
  → notify in weekly cadence (§14)
  → choose: iterate sibling lever | skip WS | executive decision
```

---

## 10. Rollback strategies

### 10.1 Git-workflow rollback (canonical)

Per `.cursor/rules/git-workflow.mdc`:

```bash
# Find merge commit on main
git log --oneline --merges origin/main | head
# Revert merge (keeps history)
git revert -m 1 <merge-commit>
git push origin HEAD
gh pr create --title "revert: <original PR title>" --body "Rollback reason..."
# Merge with merge commit again
gh pr merge --merge
```

**Запрещено:** force push to `main`; squash-as-default for rollback obscuring history.

### 10.2 Per-workstream rollback notes

| WS | Typical rollback surface | Extra steps |
|---|---|---|
| 00 | docs only | none |
| 01 | runtime CSS/JS, channel.html beacon, templates | rebuild runtime `cd runtime && npm run build` |
| 03 | frame_ring, decklink_consumer copy path | rebuild engine; soak smoke |
| 04 | run-engines.sh pinning, sysctl docs | revert scripts; reboot if cmdline |
| 05 | CEF version / flags | restore `third_party/cef` pin; clean caches |
| 06 | GC flags, THP settings | revert env; reboot if THP |
| 02 | new compositor modules | feature flag OFF first; then revert merge |

### 10.3 Feature-flag rollback (preferred before git revert)

Если изменение за флагом:

```bash
export BG_LAYERED_COMPOSITOR=0
export BG_ZERO_COPY_WEAVE=0
export BG_P18_PIPELINE_PROBE=0
```

Flag-off must restore prior telemetry within smoke 60s; else escalate to git revert.

### 10.4 Data / ops rollback

- Templates: keep `test1` immutable; ship `test1-v2` alongside.
- Kernel cmdline: hold previous GRUB entry.
- Do not delete evidence dirs when reverting code.

---

## 11. Hardware portability checklist (auto topology)

### 11.1 Goal

Один скрипт (proposed `engine/scripts/auto-topology.sh`) выдаёт pinning map для N каналов без ручного CCX угадывания.

### 11.2 Inputs

```bash
lscpu -J > host-lscpu.json
lscpu -e
cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list || true
numactl -H || true
nproc
```

### 11.3 Algorithm (normative sketch)

1. Detect physical cores vs SMT siblings.
2. Detect L3 sharing domains (CCX on Zen2).
3. Allocate 2 physical cores (+ SMT siblings) per channel.
4. Prefer packing a channel inside one L3 domain.
5. Leave OS/network IRQs on remaining cores if possible.
6. Emit `taskset -c` lists + `BG_NUM_RASTER_THREADS` suggestion (= phys_cores_per_ch − 1).
7. Fail loud if `N * 2 > phys_cores`.

### 11.4 Ryzen 5 3600 reference map

| Channel | Phys cores | SMT siblings (example) | Notes |
|---|---|---|---|
| ch0 | 0,1 | 6,7 | CCX0 preferred |
| ch1 | 2,3 | 8,9 | balance |
| ch2 | 4,5 | 10,11 | CCX1 |

Exact IDs must come from auto-topology — table is illustrative.

### 11.5 Portability checklist

- [ ] Script runs on Zen2 / Zen3 / Intel without crash
- [ ] Warns on NUMA >1 (pin per node)
- [ ] Scales channels = floor(phys_cores / 2)
- [ ] Documents when 4ch requires ≥8 phys cores
- [ ] DeckLink device-index map separate from CPU map
- [ ] Genlock ref independent of CPU topology
- [ ] Results JSON includes topology hash for reproducibility

### 11.6 Proportional expectation

If host has 2× phys cores vs 3600, expect ~2× channel capacity **at same per-channel complexity**, not 2× fps on already-saturated single channel (fps capped by content/CEF).

---

## 12. Reporting template для milestone PR

### 12.1 Title format

```
[PI07][WSxx] short description
# examples:
[PI07][WS00] cost model baseline + Style Guide v0
[PI07][WS01] reduce test1 raster cost (beacon + masks)
[PI07][FV] true-50p 3ch acceptance on Ryzen 5 3600
```

### 12.2 PR body template (copy-paste)

Использовать как тело `gh pr create --body "$(cat <<'EOF' … EOF)"`.

**Summary**

- 1–3 bullets: what changed and why
- Gate: GATE-XX → PASS|FAIL|WAIVER
- Headless test1 fps: before → after

**Task / Phase**

- Performance Investigation WS-XX
- Sister doc: `docs/performance investigation/XX-....md`
- Related: Phase 19 / PI07 roadmap §Y

**Changes**

- `engine/`: …
- `runtime/`: …
- `bench/`: …
- `docs/`: …

**Metrics**

| Metric | Before | After | Gate |
|---|---:|---:|---|
| null test1 fps | | | |
| RasterTask p95 ms | | | |
| DeckLink in_fps (1ch) | | | |
| d_pairs avg /5s | | | |
| d_late / d_dropped | | | |

**Test plan**

- [ ] §6.1 null empty/cheap/test1
- [ ] §6.2 3ch null bench
- [ ] §6.3 DeckLink 1ch smoke (if HW)
- [ ] §6.4 3ch soak (if claiming gate)
- [ ] Visual note (if UI/motion)
- [ ] Cheap regression A12

**Evidence**

- `engine/research/results/pi07/XX-YYYYMMDD/`

**Risks**

- …
- Kill-switch considered: K?

**Rollback**

    git revert -m 1 <merge-commit>

Flag-off (если есть): `export BG_...=0`

### 12.3 Review checklist for reviewers

- [ ] Constraints respected (CPU-only, HTML5, no CasparCG copy)
- [ ] Browser/stream path untouched unless justified
- [ ] Numbers have commands reproducible
- [ ] Gate thresholds match roadmap §5
- [ ] No force-push / squash-only policy violation
- [ ] Secrets/data paths not committed

---

## 13. Long-term: reopen true-50p DeckLink gate

### 13.1 Почему gate закрыт сейчас

Phase 18 Decision Gate + P3: на `test1` нет headroom; `d_pairs` не растёт; visual без разницы. Повтор pump без cost reduction — wasted motion.

### 13.2 Preconditions to reopen

| Precondition | Threshold | Source |
|---|---|---|
| Headless/null `test1` single | **≥ 45 fps** stable 60s | §6.1 |
| Prefer | **≥ 50 fps** | §6.1 |
| 3ch null `test1-proxy` | ≥ 40 per ch | §6.2 |
| RasterTask CPU-sum p95 | ≤ 10 ms (stretch) | blink research |
| Cheap still true-50p | A12 | DeckLink |
| Instrumentation | frame-log available | doc 06 |

### 13.3 Reopen protocol (when ready)

1. Create branch `bench/pi07-true50p-reopen` or `feature/phase-XX-true-50p-reopen`.
2. Re-run P0.1 raster budget + P0.2 probe (if CEF changed).
3. Single DeckLink `test1` 60s — expect in_fps≥48, d_pairs≥100.
4. 3ch soak 15min — A1–A7.
5. Visual P3.3.
6. Only then claim true 50p in docs/PRODUCT or phase report.

### 13.4 What NOT to reopen

- Dual-BeginFrame Approach A without new CEF evidence.
- Sequential 2-raster-in-20ms Approach B without ≤10 ms proof.
- Any change claiming 50p while d_pairs≈0.

---

## 14. Weekly execution cadence

### 14.1 Week rhythm

| Day | Focus |
|---|---|
| Mon | Pick WS tasks; confirm gates; branch hygiene |
| Tue–Thu | Implement + local measure |
| Fri | Gate attempt / soak / PR |
| Fri EOD | Weekly report (template below) |

### 14.2 Weekly report template

```markdown
## PI07 weekly YYYY-MM-DD
### Progress
- WS-XX: ...
### Metrics snapshot
| Scene | fps | d_pairs | late/drop |
|---|---:|---:|---|
| | | | |
### Gates
- GATE-XX: PASS/FAIL
### Blockers
- ...
### Next week
- ...
### Kill-switches tripped?
- none | K#
```

### 14.3 WIP limits

- Max 2 open engine PRs touching hot path.
- Parallel 03/04/06 OK if file disjoint.
- No uncommitted > 1 logical step (git-workflow).

### 14.4 Meeting agenda (30 min)

1. Gate status (5)
2. Metric deltas (10)
3. Risk/kill (5)
4. Next PR plan (10)

---

## 15. Матрица зависимостей и параллелизм

### 15.1 Hard dependencies

```
00 → 01 → (03 ∥ 04 ∥ 06) → D1 → (05?) → (02?) → FV
```

### 15.2 Soft dependencies

| From | To | Why soft |
|---|---|---|
| 01 | 03 | fewer rasters ⇒ less BW pressure; still OK parallel |
| 04 | FV | pinning helps soak stability |
| 06 | FV | quality; not fps ceiling |
| 00 | 02 | cost model informs layer split |

### 15.3 Forbidden parallelisms

- 02 starting before GATE-01.
- 05 heavy upgrade concurrent with 03 weave ownership (conflict risk).
- Two CEF version bumps at once.

---

## 16. Proportional scaling model

### 16.1 Formula

```
channels_max ≈ floor(phys_cores / cores_per_channel)
cores_per_channel = 2  # baseline Titulus policy
```

Complexity factor `C` (relative to `test` cost unit from doc 00):

```
unique_fps ≈ min(50, k * (CPU_share / C) * efficiency)
```

On 3600, empirically C(test1) too high ⇒ unique_fps≈25. Target: reduce C until unique_fps≥50 at CPU_share for 3ch.

### 16.2 Scaling table (planning)

| CPU | Phys cores | Target ch @test1-cost | Notes |
|---|---:|---:|---|
| Ryzen 5 3600 | 6 | 3 | program baseline |
| Ryzen 7 5700X | 8 | 4 | validate topology |
| Ryzen 9 / 12c | 12 | 6 | NUMA usually 1 |
| Xeon 16c | 16 | 8 | check NUMA domains |

### 16.3 What scales vs what does not

| Scales with CPU | Does not scale |
|---|---|
| Channel count | Per-frame Skia cost of one template |
| Headroom vs OS noise | DeckLink genlock quality |
| Parallel blend in 02 | Single CEF browser process per channel limit |
| Memory BW (more channels) | DDR gen / channels of memory |

---

## 17. Acceptance protocol (финальный)

### 17.1 Sequence

1. **Null matrix** — empty, cheap, test1 (± proxy) 1ch + 3ch.
2. **Raster budget** — confirm ≤ target.
3. **DeckLink 1ch** — 60s + 5min.
4. **DeckLink 3ch gate soak** — 15min, A1–A7.
5. **Visual** — A8.
6. **Release soak** — 60min.
7. **Optional marathon** — 8h (Phase 6.4-style).
8. **Scaling paper or second host**.
9. **Program PR** + update development-plan.

### 17.2 Pass certificate (fill at end)

```
PI07 ACCEPTANCE CERTIFICATE
Date:
Git SHA:
Host:
in_fps ch1/2/3:
d_pairs avg:
late/drop:
genlock:
visual:
Signed:
```

---

## 18. Appendices

### Appendix A — Full checklist (printable)

#### A.1 Program entry
- [ ] Read architecture.mdc constraints
- [ ] Read docs 00–06 index (README)
- [ ] Confirm HW: DeckLink + genlock available for FV
- [ ] Baseline SHA recorded (post Phase 18)

#### A.2 WS-00
- [ ] Budgets documented
- [ ] Baselines measured
- [ ] Matrix filled
- [ ] Style Guide v0 merged
- [ ] GATE-00

#### A.3 WS-01
- [ ] Lever 1 landed
- [ ] Lever 2 landed
- [ ] Headless delta
- [ ] Cheap OK
- [ ] GATE-01

#### A.4 Parallel band
- [ ] WS-03 gate
- [ ] WS-04 gate
- [ ] WS-06 instrumentation gate
- [ ] Integration soak after band

#### A.5 Decision D1
- [ ] fps recorded
- [ ] 05 skip/light/full chosen

#### A.6 Conditional
- [ ] WS-05 done or skipped
- [ ] WS-02 done or skipped

#### A.7 Final
- [ ] A1 in_fps≥50
- [ ] A2 d_pairs high
- [ ] A3 d_singles low
- [ ] A4 late=0
- [ ] A5 drop=0
- [ ] A7 genlock
- [ ] A8 visual
- [ ] A9 3ch complex
- [ ] A10 duration
- [ ] A11 headless precondition history
- [ ] A12 cheap regression

### Appendix B — Sample PR bodies

#### B.1 Sample: WS-00

```markdown
## Summary
- Publish PI07 cost model baseline and Style Guide v0
- Record null fps for empty/test/test1 on Ryzen 5 3600
- Gate: GATE-00 → PASS

## Task / Phase
- Performance Investigation WS-00
- Sister: 00-overview-and-cost-model.md

## Changes
- docs/performance investigation/00-... (already)
- docs/STYLE_GUIDE_BROADCAST.md (new)
- engine/research/results/pi07/00-.../gate.md

## Test plan
- [x] null empty ≥50
- [x] null test recorded
- [x] null test1 recorded (~27)
- [x] no engine hot-path changes

## Rollback
git revert -m 1 <merge-commit>
```

#### B.2 Sample: WS-01

```markdown
## Summary
- Reduce test1 paint cost via mask simplification + Class A transform audit
- Headless test1: 27 → 38 fps
- Gate: GATE-01 → PASS (interim ≥35)

## Metrics
| Metric | Before | After |
|---|---:|---:|
| null test1 fps | 27 | 38 |
| RasterTask p95 ms | 191 sum | 140 sum |
| DL 1ch late/drop | 0/0 | 0/0 |

## Rollback
git revert -m 1 <merge-commit>
```

#### B.3 Sample: WS-03

```markdown
## Summary
- Weave from FrameRing without intermediate full-frame Clone on singles path
- Estimated BW −25% at 3×50fps
- Gate: GATE-03 → PASS

## Test plan
- [x] null non-regress
- [x] DL smoke late/drop 0
- [x] 3ch null CPU% not up

## Rollback
git revert -m 1 <merge-commit>
# or BG_ZERO_COPY_WEAVE=0
```

#### B.4 Sample: Final verification

```markdown
## Summary
- PI07 FV: 3×1080i50 test1 in_fps≥50, d_pairs≥100, late/drop 0, genlock locked
- Visual PASS on TV Logic
- Gate: GATE-FV → PASS

## Evidence
- engine/research/results/pi07/FV-.../

## Rollback
N/A (docs+certificate); code already gated per WS
```

### Appendix C — Sample telemetry dashboards (text)

#### C.1 Live tail dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ PI07 LIVE  host=ryzen3600  sha=abcdef  soak=12m34s         │
├─────────┬─────────┬─────────┬───────┬───────┬──────────────┤
│ ch      │ in_fps  │ d_pairs │ late  │ drop  │ genlock      │
├─────────┼─────────┼─────────┼───────┼───────┼──────────────┤
│ 1       │ 50.1    │ 124     │ 0     │ 0     │ LOCKED       │
│ 2       │ 49.8    │ 121     │ 0     │ 0     │ LOCKED       │
│ 3       │ 50.0    │ 125     │ 0     │ 0     │ LOCKED       │
├─────────┴─────────┴─────────┴───────┴───────┴──────────────┤
│ windows: 151  min_in_fps: 48.7  max_singles: 6             │
│ CPU pinned: 78%  mem BW est: 3.1 GB/s  mf_events: 0        │
└─────────────────────────────────────────────────────────────┘
```

#### C.2 Gate strip (PASS/FAIL)

```
GATE-00 [PASS] GATE-01 [PASS] GATE-03 [PASS] GATE-04 [PASS]
GATE-06 [PASS] D1 [fps=47 → light-05] GATE-05 [SKIP]
GATE-02 [PASS] GATE-FV [ ]
```

#### C.3 Microfreeze spectrum (text)

```
gap_ms histogram (paint-to-paint), 15min:
  0-25mm: ############################  98.2%
 25-40ms: ##                           1.5%
 40-80ms: .                            0.2%
 >100ms:  (none)                       0.0%  ← target
periodic 5-11s peaks: none detected
```

#### C.4 Cost model snapshot

```
feature          rel_cost   used_in_test1   action
gradient fill    5.0        yes             replace
css mask         3.5        yes             simplify
blur(>4px)       4.0        no              ban
class-A x/y      1.2        yes             prefer
plain text       1.5        yes             ok
image RGBA       2.0        yes             atlas
```

### Appendix D — FAQ

**Q1: Почему нельзя сразу делать layered compositor (02)?**  
A: Нужен измеренный baseline и дешёвые wins (01). Иначе невозможно отличить architecture win от template win.

**Q2: Почему Phase 18 не «решение»?**  
A: Phase 18 доказал готовность output path и потолок content-cost. Это вход в PI07, не финиш.

**Q3: Что считать unique fps?**  
A: `in_fps` уникальных progressive bitmaps; true 50p-as-50i требует высокий `d_pairs`.

**Q4: Можно ли GPU «на чуть-чуть»?**  
A: Нет, без отдельного gate-doc. Non-negotiable.

**Q5: CasparCG код копировать?**  
A: Нет. Только reimplement patterns; GPL log если ideas borrowed at design level.

**Q6: Что если headless 50, а DeckLink 25?**  
A: Тогда проблема снова pacing/latency/scheduling — reopen 04/05 carefully; not ignore d_pairs.

**Q7: Microfreezes блокируют FV?**  
A: Hard block если visible ≥100ms stalls remain unexplained at rate >1/15min. Soft if rare.

**Q8: Как масштабировать на 6 каналов?**  
A: ≥12 phys cores + topology script + same per-ch cost envelope.

**Q9: CI без DeckLink достаточен для merge WS-01?**  
A: Для WS-01 — null gate достаточно; DL smoke required before claiming DeckLink metrics.

**Q10: Squash merge OK?**  
A: По умолчанию нет; `gh pr merge --merge`. Rollback через revert merge-commit.

**Q11: Когда reopen true-50p?**  
A: §13 — headless test1 ≥45–50.

**Q12: Что такое kill-switch vs fail gate?**  
A: Fail gate — не прошли числа. Kill-switch — прекращаем подход даже если «ещё чуть-чуть».

### Appendix E — Glossary

| Term | Meaning |
|---|---|
| in_fps | unique progressive frames / sec into consumer path |
| out_fps | scheduled output frames / sec (i50 → 25 frames / 50 fields) |
| d_pairs | count of field-pairs woven from two distinct bitmaps / window |
| d_singles | pairs woven from duplicated bitmap |
| d_late | late scheduled fields |
| d_dropped | dropped fields |
| true 50p-as-50i | 50 unique progressive looks per sec on interlaced output |
| 25p-as-50i | each pair shares one bitmap |
| OSR | off-screen rendering (CEF windowless) |
| BeginFrame | external frame pump into CEF |
| CCX | core complex (shared L3) |
| GATE-XX | numeric pass criteria in §5 |
| WS-XX | workstream |
| FV | final verification |
| PI07 | this performance investigation program |

### Appendix F — Command cheatsheet

```bash
# status
git fetch origin && git status && gh pr list --state open
pgrep -af 'bg_engine|run-channel|run-engines'

# build
cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

# null benches
./bench/run-bench.sh 3 60 5

# blink research
./engine/run-blink-research.sh

# decklink evidence
OUT_ROOT=/tmp/pi07 ./engine/collect-decklink-evidence.sh

# kill listeners correctly
ss -ltnp | rg ':3002|:3011'
```

### Appendix G — Mapping to sister docs (detailed)

| Roadmap § | Sister anchors (expected sections) |
|---|---|
| §1 acceptance | 00 budgets; 18 phase verdict |
| §4.1 WS-00 | 00 entire |
| §4.2 WS-01 | 01 problem→gate sections |
| §4.3 WS-03 | 03 copy-chain + designs |
| §4.3 WS-04 | 04 topology + isolcpus |
| §4.3 WS-06 | 06 symptom + hypotheses |
| §4.4/05 | 05 CEF options + upgrade |
| §4.5/02 | 02 compositor architecture |
| §7 harness | bench/README + new scenes |
| §13 reopen | phase-18 §what next |

### Appendix H — Anti-patterns (stop doing)

1. Claiming 50fps from `out_fps` alone.
2. Tuning sleep/pump without cost model.
3. Raising raster threads as sole DeckLink fix.
4. Editing browser consumer «while at it».
5. Copying CasparCG sources into `engine/`.
6. Enabling GPU silently.
7. Squashing away merge commits needed for revert.
8. Running backend from subshell `( )`.
9. `pkill -f PORT=...`.
10. Declaring victory without A8 visual.

### Appendix I — Milestone calendar (indicative)

| Week | Milestone |
|---|---|
| W0 | Docs 00–07 published; GATE-00 plan |
| W1 | GATE-00 PASS |
| W2–W4 | WS-01 iterations → GATE-01 |
| W3–W5 | Parallel 03/04/06 |
| W5 | D1 decision |
| W6 | 05 optional |
| W6–W10 | 02 if needed |
| W11 | FV gate soak |
| W12 | Report + phase closure |

Dates slide; gates do not.

### Appendix J — Sign-off

Этот roadmap обязателен для всех PR с меткой `[PI07]`. Отклонения — только письменным waiver в PR с ссылкой на kill-switch или executive decision.

**Maintainers:** update §5 numbers when evidence shows floors too low/high; never loosen A4/A5 (late/drop=0).

---

## Document history

| Date | Change |
|---|---|
| 2026-07-13 | Initial master roadmap (PI07) |

---

*End of document 07 — Execution Roadmap and Verification.*

## Appendix K — Detailed gate command recipes

Ниже — полные copy-paste рецепты, чтобы engineer не искал флаги по фазам.

### K.1 GATE-00 recipe

```bash
set -euo pipefail
ROOT=/home/requestin/Titulus
cd "$ROOT"
OUT=engine/research/results/pi07/00-$(date +%Y%m%d)
mkdir -p "$OUT/raw-logs"
ENGINE=./engine/build/Release/bg_engine

run_null() {
  local name="$1" url="$2"
  "$ENGINE" --consumer=null --width=1920 --height=1080 --fps=50 \
    --duration=60 --stats-interval=5 --url="$url" \
    --cache-dir="/tmp/pi07-$name" --name="pi07-$name" \
    > "$OUT/raw-logs/$name.log" 2>&1
  rg -n 'SUMMARY|Progress|fps' "$OUT/raw-logs/$name.log" | tee "$OUT/$name.fps.txt"
}

run_null empty "file://${ROOT}/bench/bench.html?graphics=0"
run_null cheap5 "file://${ROOT}/bench/bench.html?graphics=5"
# test1 URL depends on backend; document actual URL in gate.md
echo "Fill test1 manually; record fps in $OUT/gate.md"
```

### K.2 GATE-01 recipe

```bash
OUT=engine/research/results/pi07/01-$(date +%Y%m%d)
mkdir -p "$OUT"
# 1) measure before on main
# 2) measure after on branch
# 3) compute delta
python3 - <<'PY'
before=27.0  # replace
after=38.0   # replace
delta=(after-before)/before*100
print(f'delta_pct={delta:.1f}')
print('PASS' if after>=35 or delta>=30 else 'FAIL')
PY
```

### K.3 GATE-03 recipe

```bash
# Count memcpy-ish calls via frame-log counters if exposed; else estimate:
python3 - <<'PY'
W,H=1920,1080
frame=W*H*4
fps=50
ch=3
copies_before=4  # CEF→ring→aligned→weave(+clone)
copies_after=2
bw=lambda c: c*frame*fps*ch/1e9
print('GB/s before', round(bw(copies_before),2))
print('GB/s after', round(bw(copies_after),2))
PY
./bench/run-bench.sh 3 60 5 | tee /tmp/pi07-g03-bench.txt
```

### K.4 GATE-04 recipe

```bash
lscpu -e | tee /tmp/pi07-topo.txt
# proposed:
# ./engine/scripts/auto-topology.sh --channels 3 --emit taskset.env
# source taskset.env && ./engine/run-engines.sh
rg -n 'Reference|locked|unlocked' logs/dev/engines.log | tee /tmp/pi07-genlock.txt
```

### K.5 GATE-06 recipe

```bash
# Collect 15min frame log and search periodic gaps
python3 - <<'PY'
import csv,statistics
# pseudocode: read timestamps, diff, find peaks near 5-11s
print('see doc 06 for analyzer script name when landed')
PY
```

### K.6 GATE-05 recipe

```bash
export BG_P18_PIPELINE_PROBE=1
# run null 3x60s; parse pctTicksDeltaGe2
unset BG_P18_PIPELINE_PROBE
```

### K.7 GATE-02 recipe

```bash
export BG_LAYERED_COMPOSITOR=1
# null test1 layered vs monolithic A/B
export BG_LAYERED_COMPOSITOR=0
```

### K.8 GATE-FV recipe

```bash
DURATION=900
# run 3ch test1 soak
# parse A1-A7
# write certificate
```

## Appendix L — RACI

| Activity | Engines | Runtime | Docs | Ops |
|---|---|---|---|---|
| WS-00 | C | C | R/A | I |
| WS-01 | C | R/A | C | I |
| WS-03 | R/A | I | C | I |
| WS-04 | R | I | C | A |
| WS-06 | R/A | C | C | C |
| WS-05 | R/A | C | C | I |
| WS-02 | R/A | C | C | I |
| FV | R | C | A | C |

R=Responsible A=Accountable C=Consulted I=Informed

## Appendix M — Open questions log

| ID | Question | Blocking? | Default until answered |
|---|---|---|---|
| OQ1 | Exact test1 serve URL in headless CI | no | manual take path |
| OQ2 | External vs fill_only keyer for soaks | no | external as prod |
| OQ3 | Whether channel.html beacon can be duty-cycled | yes for 01 | keep always-on until measured |
| OQ4 | THP default on stand images | no | measure first |
| OQ5 | Second host for scaling proof | no | paper model OK for interim |

## Appendix N — Evidence JSON schema

```json
{
  "$schema": "pi07-gate-1.0",
  "ws": "01",
  "git_sha": "",
  "host": {
    "cpu_model": "AMD Ryzen 5 3600",
    "phys_cores": 6,
    "threads": 12
  },
  "metrics": {
    "null_test1_fps_avg": 0,
    "null_test1_fps_min": 0,
    "dl_in_fps_avg": [0,0,0],
    "d_pairs_avg": [0,0,0],
    "d_late_sum": [0,0,0],
    "d_dropped_sum": [0,0,0],
    "genlock_locked": true
  },
  "gate": "GATE-01",
  "result": "PASS",
  "waiver": null,
  "commands": []
}
```

## Appendix O — Relationship to Perf MVP

Architecture Perf MVP: ≥3×1080i50, drops <0.1%, mask/alpha overhead ≤5%.
PI07 **raises** the bar: unique fps ≥50 with complex templates, not merely drop-free 25p-as-50i.
MVP remains a regression floor during early WS; FV requires the raised bar.

## Appendix P — Worked example narrative

Допустим после WS-00: test1 null = 27 fps.
WS-01 убирает heavy gradients → 36 fps (GATE-01 PASS interim).
WS-03 снижает copies → CPU% −7%, fps 37.
WS-04 CCX pinning → 3ch soak стабильнее, late=0.
WS-06 находит THP spikes → disable → microfreezes gone.
D1: fps=37 <40 → Full WS-05 time-box: CEF flags +5% → 39; kill heavy upgrade.
WS-02 layered POC: static BG cached → 52 fps null → GATE-02 PASS.
FV: 3ch DeckLink in_fps 50.2/49.9/50.1, d_pairs 118–125, late/drop 0, visual OK.
Program success.

Альтернатива: WS-01 alone reaches 51 fps headless → skip 05 and 02 → FV earlier.
Roadmap allows both paths; gates decide.

## Appendix Q — File ownership map (merge conflicts)

| Path | Preferred WS owner |
|---|---|
| `engine/src/main.cpp` | 05 (probe), 04 (prio) — serialize |
| `engine/src/frame_ring.*` | 03 |
| `engine/src/consumers/decklink_consumer.cpp` | 03/04 |
| `runtime/` + `channel.html` | 01/06 |
| `engine/run-engines.sh` | 04 |
| `bench/*` | harness parallel OK |
| `docs/performance investigation/*` | docs anytime |

## Appendix R — Communication plan

- PR label: `pi07`
- Weekly note in project board / chat
- FV announcement only after certificate
- Do not market «50fps» in PRODUCT.md until GATE-FV PASS

## Appendix S — Constraints enforcement checklist

- [ ] CPU-only (`--disable-gpu*` still on)
- [ ] HTML5/DOM templates only
- [ ] DeckLink scheduled playback intact
- [ ] Genlock required on HW soaks
- [ ] CasparCG not linked / not subprocess
- [ ] git merge commits
- [ ] scale model documented for new hosts

