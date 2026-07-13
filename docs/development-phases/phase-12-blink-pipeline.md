# Фаза 12 — Blink pipeline research

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | research branch (merged в main) |
| **Хост** | Домашний DeckLink-стенд + null consumer benches |

---

## 1. Цель / зачем

Понять **CPU OSR hot path Chromium**: layout/paint/raster, clip-path wipe, image decode, DisplayItemList reuse — для обоснованных perf-решений (Phase 11 follow-up, translate-only position).

Не product feature — **исследование** с trace parsers и bench triplet.

---

## 2. Исходное состояние

- Phase 10/11: SDI stable на Ch2/3, но layout-heavy templates ~25–29fps
- Phase 9: projected masks T3 expensive
- Нет инструментария для Chrome trace анализа в repo

---

## 3. Scope

- Chrome trace на live decklink Ch2 (15s)
- Research flags: `--blink-research`, `--remote-debugging-port`
- Bench triplet: wipe inset / polygon / transform-only
- Beacon on/off A/B, image left vs transform
- Parsers: `engine/research/*.mjs`

---

## 4. Реализация

### Instrumentation

- `trace-startup` + categories blink/cc/invalidationTracking
- `engine/research/lib/parse-chrome-trace.mjs`
- `engine/research/lib/parse-paint-invalidation.mjs`
- `engine/research/lib/parse-trace-internals.mjs`
- Orchestrators: `run-blink-research.sh`, `run-blink-internals-research.sh`

### Bench scenes

| Файл | Назначение |
|---|---|
| `bench-wipe-inset.html` | T1 mask inset |
| `bench-wipe-polygon.html` | T3 polygon |
| `bench-wipe-transform.html` | translateX only |
| `bench-static-beacon.html` | beacon on/off |
| `bench-image-left.html`, `bench-image-transform.html` | Image decode vs compositor |

---

## 5. PR / Git

Research deliverables в main (без отдельного milestone PR #):

| Компонент | Путь |
|---|---|
| Trace parsers | `engine/research/*.mjs` |
| Bench HTML | `bench/bench-wipe-*.html`, etc. |
| Orchestrators | `engine/research/run-blink-*.sh` |

---

## 6. Проверка

```bash
./engine/research/run-blink-research.sh
# Artifacts: /tmp/titulus-blink-research/

bg_engine --consumer=null --url=file://.../bench-wipe-transform.html --duration=20
```

Live trace: 15s Ch2 decklink, ~780 BeginMainFrame.

---

## 7. Результаты — ключевые выводы

### 1. Paint+raster каждый кадр

CPU OSR + damage beacon (1×1px) → полный compositor pass каждый rAF, даже при `styleWrites=0`.

### 2. «Transform» в Titulus = layout

Timeline анимирует `x/y` → `left`/`top` → **layout ~50/s**, не compositor-only translate.

### 3. Wipe cost tiers

| Сцена | Механизм |
|---|---|
| Mask inset | `clip-path: inset` T1 |
| Mask rotation | `polygon` T3 |
| Transform-only bench | `translateX` без clip |

### 4. Images

Production `test` template: 24 DOM nodes, 3 `<img>`. PNG decode **не каждый кадр**; raster ~35/frame.

### 5. DisplayItemList

Нет frozen layer reuse при geometry + beacon. Beacon off → ~0 paint/frame после load.

### Bench (20s, null, blink-research=1)

| Сцена | Layout/f | Paint/f | Raster/f |
|---|---:|---:|---:|
| wipe-inset | 0.33 | 0.17 | 1.67 |
| wipe-polygon | 0.50 | 0.50 | 1.67 |
| wipe-transform | 0.001 | 0.67 | 0.005 |
| static-beacon-on | 0.001 | 0.67 | 0.002 |
| static-beacon-off | 0.001 | 0 | 0.002 |

---

## 8. Отложено

- **Архитектурный fix:** outer/inner split для translate-only position (без left/top)
- Контент-оптимизация projected-mask hotspot (`template_test_1`)

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `/tmp/titulus-blink-research/` | Trace output |
| `engine/research/*.mjs` | Parsers |
| `bench/bench-wipe-*.html` | Controlled scenes |
