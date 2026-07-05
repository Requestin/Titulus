# Фаза 11 — CasparCG-parity perf pass

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #56 |
| **Merge** | 2026-07-02 |
| **Ветка** | `feature/phase-11-casparcg-parity` |

---

## 1. Цель / зачем

Достичь **3 канала 1080i50 без лагов/дёрганий** на домашнем HW-стенде (AMD Ryzen 5 3600, DeckLink Quad 2, genlock), CPU-only, без 100%-копирования CasparCG — reimplement by reference лучших практик.

**Контекст:** Phase 10 устранил tearing/beacon; Phase 11 закрывает clock desync, allocation hot path, OS scheduling и preroll.

---

## 2. Исходное состояние (baseline 11.1)

3 live decklink-канала, 54+ мин uptime:

| Channel | in_fps | pairs:singles | Примечание |
|---|---|---|---|
| Ch1 | ~28 | 1:6 | CPU video decode (content-bound) |
| Ch2 | ~46–48 | ~7:1 | clock desync + alloc pressure |
| Ch3 | ~45–46 | ~4:1 | аналогично Ch2 |

Stage telemetry (11.1): copy+weave+schedule = **17–22%** 40ms budget.

**Важно:** гипотеза «карта держит только 2 SDI» — **опровергнута**; 3 выхода на profile `1dfd` работают.

---

## 3. Scope

| # | Deliverable |
|---|---|
| 11.1 | Stage-time telemetry (`copy_us`, `weave_us`, `schedule_us`, `stages5s`) |
| 11.2 | DeckLink-driven clock — `WaitForTick()` от `ScheduledFrameCompleted` |
| 11.3 | Buffer pooling + 64B align + AVX2 non-temporal weave |
| 11.4 | `SCHED_FIFO` priority 2 (decklink-only); `nice` backend/frontend |
| 11.5 | Low-latency flag + CasparCG preroll formula |
| 11.6 | Chromium background-throttling hardening |
| 11.7 | 28.6-min 3-channel live soak acceptance |

---

## 4. Реализация

### 11.2 Clock model (ключевая развилка)

- `Consumer::HasExternalClock()` / `WaitForTick()` в `engine/src/consumers/consumer.h`
- `main.cpp` — отдельная `decklink_driven` ветка pump loop
- **Browser/OBS/stream/null** — self-timer **без изменений**
- `channel.html` — JS timeline tick с `setInterval` на fixed-step внутри того же rAF, что paint

Первая попытка (2 BeginFrame подряд) дала 25fps cap — исправлено pacing ~20ms на tick.

### 11.3 Memory / SIMD

- `engine/src/aligned_buffer.h` — 64B-aligned pooled buffers
- `engine/src/simd_copy.h` — AVX2 `StreamCopy`, `target("avx2")`
- Убран fresh `aligned_alloc` на каждый `OnFrame()` — доминирующая стоимость
- `kMaxQueuedFrames` 4→2

### 11.4 RT priority

- `MaybeSetRealtimePumpPriority()` — `SCHED_FIFO` prio 2, gated `HasExternalClock()`
- `dev-start.sh` — `nice -n 10` для backend/frontend
- На тестовом хосте: soft-fail (`RLIMIT_RTPRIO=0`) — нужен deployment grant

### 11.5 DeckLink config

- `bmdDeckLinkConfigLowLatencyVideoOutput = true`
- Preroll: `3 + (не low-latency?1:0) + (audio?1:0)` → **preroll=3**

### 11.6 CEF flags

`disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows`, `disable-background-timer-throttling` в `engine_app.cpp`.

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 56 | [Phase 11] CasparCG-parity perf pass — clock, memory, OS | `main.cpp`, `consumer.h`, `decklink_consumer.cpp`, `aligned_buffer.h`, `simd_copy.h`, `engine_app.cpp`, `channel.html`, `dev-start.sh` |

Заимствования: `docs/CASPARRCG_PORTING.md` §2, §3.6–3.7.

---

## 6. Проверка

```bash
# Browser/null regression (обязательно после каждого подэтапа)
./bench/run-bench.sh 3 30 5

# Live soak: 3 decklink channels, genlock locked, telemetry в per-channel logs
# См. run-engines.sh / logs/dev/
```

Перед экспериментами: `pgrep -af "bg_engine|run-channel|run-engines"`.

---

## 7. Результаты

### Метрики Ch2/3 (до → после)

| Метрика | До | После |
|---|---|---|
| pairs:singles | ~4–7:1 | ~8–100:1 |
| copy_us | ~2700–4000 µs | ~1200 µs |
| weave_us | ~2800–3400 µs | ~1500–1900 µs |
| copy+weave+schedule % budget | 17–22% | ~9–11% |
| in_fps Ch2/3 | ~46–48 | ~49–50 |

### Soak 11.7 (28.6 min)

| Channel | in_fps | dropped | flushed | late |
|---|---|---|---|---|
| Ch1 | 29.3 | 0 | 0 | 0 |
| Ch2 | 49.1 | 0 | 0 | 0 |
| Ch3 | 49.6 | 0 | 0 | 0 |

**0 крашей**, browser/null: 49.92 avg fps, ~0.2% drops — без регрессии vs Phase 0.

Channel 1 ~29fps — **CPU video decode**, не engine defect; не улучшается 11.2–11.6.

CCX topology reshuffle — исследовано, **не меняли** (Ch2 straddles CCX, лучший performer).

---

## 8. Ограничения / отложено

- Второй structural copy (`OnPaint` → ring → consumer) — не убран (invasive)
- `SCHED_FIFO` требует systemd/limits grant на production
- Projected-mask hotspot (`template_test_1`) — отложено
- 28.6 min < формальный 8h soak (Phase 6.4)
- `DecklinkConsumer::Stop()` crash на failed-start path — tracked, не blocking

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `engine/src/main.cpp` | decklink_driven loop, SCHED_FIFO |
| `engine/src/consumers/consumer.h` | External clock API |
| `engine/src/consumers/decklink_consumer.cpp` | Telemetry, pool, weave, preroll |
| `engine/src/aligned_buffer.h` | Pooled aligned buffers |
| `engine/src/simd_copy.h` | AVX2 weave |
| `engine/src/engine_app.cpp` | CEF throttling flags |
| `backend/public/channel.html` | Unified rAF tick bridge |
| `dev-start.sh` | nice deprioritization |
| `docs/CASPARRCG_PORTING.md` | Porting decisions §3.6–3.7 |

---

## 10. Baseline telemetry (11.1, до фиксов)

| Channel | copy_avg | weave_avg | schedule_avg | sum % budget |
|---|---|---|---|---|
| Ch1 | 2731 µs | 2842 µs | 1092 µs | 16.7% |
| Ch2 | 4017 µs | 3369 µs | 1377 µs | 21.9% |
| Ch3 | 2695 µs | 2851 µs | 1296 µs | 17.1% |

Доминирующая стоимость — fresh allocation на каждый `OnFrame()`, не bandwidth memcpy.

---

## 11. Операционные заметки

- Перед экспериментами: `pgrep -af "bg_engine|run-channel|run-engines"` — live channels могут быть на эфире
- Остановить supervisor полностью: убить `run-engines.sh` + `run-channel.sh`, не только `bg_engine`
- `renice` необратим без sudo — проверять полный cmdline процесса
- `SCHED_FIFO` на тестовом хосте: soft-fail; production — `LimitRTPRIO` в systemd unit

---

## 12. Рекомендации для formal closure

- 28.6-min soak близок к 30-min target; для production — 8h soak (Phase 6.4)
- Channel 1: при смене rundown content перепроверить CPU video decode diagnosis
- Browser/null regression обязателен после любых engine changes: `./bench/run-bench.sh 3 30 5`

---

## 13. Связанные фазы

| Phase | Связь |
|---|---|
| Phase 10 | Beacon + BeginFrame — prerequisite для 50fps OSR |
| Phase 6.4 | Formal 8h SDI soak closure |
| Phase 12 | Blink research — translate-only follow-up |
| Phase 9 | Projected-mask hotspot отложен в 11.6 |
