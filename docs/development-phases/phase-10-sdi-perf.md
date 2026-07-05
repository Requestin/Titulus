# Фаза 10 — SDI stutter/tearing perf fixes

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #49–#55 |
| **Merge** | 2026-07-02 |
| **Хост** | Домашний Linux, DeckLink Quad 2 + genlock |

---

## 1. Цель / зачем

Устранить **visible tearing, comb и judder** на реальном 1080i50 SDI выходе — первая фаза с живым SDI трафиком на HW-стенде.

**Root cause (10.2):** weave смешивал свежее field A со stale field B при недоборе fps → temporal inversion на interlaced.

---

## 2. Исходное состояние

- Phase 3 decklink code-complete, но без live SDI тестов на dev-сервере
- Phase 9 masks + projected clip-path в production templates
- CEF OSR ~28.7fps на static take без external BeginFrame (damage-only path)

---

## 3. Scope

| # | Deliverable |
|---|---|
| 10.1 | Per-channel telemetry, rolling win_fps, starved counter |
| 10.2 | Weave field-pairing starvation policy |
| 10.3 | SMT-aware core pinning (locale-safe lscpu) |
| 10.4 | Forced per-tick Invalidate — **регресс, откат в 10.5** |
| 10.5 | Damage beacon 1×1px + sliced pump |
| 10.5b | External BeginFrame каждый channel tick |
| 10.6 | Degenerate projected mask guard (black flash) |

---

## 4. Реализация

### 10.1 Telemetry

- Per-channel log files вместо interleaved stdout
- `telemetry5s`: win_fps, completed/late/dropped/flushed
- Счётчик `starved` в decklink consumer

### 10.2 Starvation policy

| Fresh fields | Действие |
|---|---|
| 2 | Weave pair (UFF) |
| 1 | Duplicate single field |
| 0 | Repeat last pair |

Счётчики: `pairs`, `singles`, `starved`.

### 10.3 Core topology

- `lscpu -p=CPU,CORE` — locale-independent
- `run-engines.sh`: pin 2 physical cores + SMT siblings per channel

### 10.5 / 10.5b CEF paint pacing

- Revert Invalidate flood (10.4 вызвал black stripes)
- Damage beacon: 1×1px alpha 1↔2 каждый rAF
- Sliced pump ≤4ms slices
- `SendExternalBeginFrame()` каждый tick → **28.7→50.04 fps** на beacon-тесте

### 10.6 Mask guard

- `maskGeometry.ts`: reject degenerate projection при rotationY→90°
- Hold last valid clip-path (Group 3 black flash fix)

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 49 | [Phase 10.1] decklink telemetry + per-channel logs | `decklink_consumer.cpp`, logging |
| 50 | [Phase 10.2] field pairing fix — no temporal inversion | `decklink_consumer.cpp` weave |
| 51 | [Phase 10.3] SMT-aware engine pinning | `run-engines.sh` |
| 52 | [Phase 10.4] forced per-tick repaint | `engine_app.cpp` (reverted) |
| 53 | [Phase 10.5] revert Invalidate flood — damage beacon | `channel.html`, pump |
| 54 | [Phase 10.5b] external begin-frame pacing | `main.cpp`, `channel.html` |
| 55 | [Phase 10.6] degenerate projected mask guard | `maskGeometry.ts` |

---

## 6. Проверка

Live SDI на домашнем хосте:

- Genlock `ref=locked`
- Визуальная проверка motion smoothness vs до фиксов
- Telemetry: pairs:singles ratio, win_fps ~50

```bash
pgrep -af "bg_engine|run-channel"  # перед экспериментами
```

Beacon regression: `channel.html` с damage beacon + external BeginFrame → SUMMARY ~50fps.

---

## 7. Результаты

| Результат | Детали |
|---|---|
| Первый live SDI тест | Quad 2 + genlock |
| Beacon + BeginFrame | Критичный путь для 50fps OSR |
| Field-pairing | Ключ к smooth interlace |
| 10.4 | Урок: flood Invalidate ломает CEF capturer |
| 10.6 | Black flash на projected mask устранён |

---

## 8. Ограничения / отложено

- Формальный 8h soak — Phase 6.4
- Clock unification — Phase 11.2
- Projected-mask perf hotspot — Phase 12 research

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `engine/src/consumers/decklink_consumer.cpp` | Weave, telemetry |
| `runtime/src/maskGeometry.ts` | Degenerate guard |
| `backend/public/channel.html` | Beacon, rAF bridge |
| `engine/run-engines.sh` | SMT pinning |
| `engine/src/main.cpp` | External BeginFrame (10.5b) |
