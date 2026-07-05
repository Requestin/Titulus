# Фаза 0 — Engine skeleton + bench

## Мета

| Поле | Значение |
|---|---|
| **Статус** | DONE |
| **PR** | #1–#7 |
| **Merge** | июнь 2025 |

---

## 1. Цель / зачем

Доказать, что **render plane Titulus** на CPU-only CEF OSR держит многоканальный 1080p50 без потерь кадров, и заложить clean-room основу `bg_engine` по образцу CasparCG (reimplement by reference, не fork).

**Exit criterion:** render plane proven — bench numbers + harness.

---

## 2. Исходное состояние

Пустой репозиторий. CasparCG `server/` и DeckLink SDK — external reference (gitignored).

---

## 3. Scope

| # | Deliverable |
|---|---|
| 0.1 | Repo skeleton bootstrap |
| 0.2 | CasparCG porting map + GPL notices |
| 0.3 | CEF OSR skeleton + null consumer |
| 0.4 | pipe + preview consumers |
| 0.5 | Bench harness + mask/alpha scenes |
| 0.6 | CasparCG baseline driver (partial) |
| 0.7 | Steady-state soak report |

---

## 4. Реализация

### bg_engine (C++20 + CEF 149)

- `engine_app`, `engine_client` — OSR render host
- CPU-only switches: `--disable-gpu`, `windowless_rendering_enabled`, `enable-begin-frame-scheduling`
- `OnPaint` → BGRA memcpy, `device_scale_factor=1.0`
- `FrameRing` SPSC, `MessagePump`, `Stats` (SUMMARY contract для bench)
- Unique `cache_path` per channel

### Consumers

| Consumer | Назначение |
|---|---|
| `null` | Benchmark (no output) |
| `pipe` | Raw BGRA stdout |
| `preview` | Throttled JPEG (stb_image_write) |

### Bench

- `bench/bench.html` — 5 lower-thirds stress
- `bench/bench-alpha.html` — mask/alpha A/B
- `bench/run-bench.sh` — multi-channel, `taskset` disjoint cores, парсит SUMMARY
- `bench/run-casparcg-baseline.sh` — reference driver

### Porting

- `docs/CASPARRCG_PORTING.md` — file mapping + spec-vs-CasparCG forks
- `engine/THIRD_PARTY_NOTICES.md` — GPL-PORT log

---

## 5. PR / Git

| # | Title | Ключевые файлы |
|---|---|---|
| 1 | [Phase 0] bootstrap product repository skeleton | repo layout, LICENSE |
| 2 | [Phase 0] CasparCG porting map + GPL notices | `CASPARRCG_PORTING.md`, THIRD_PARTY |
| 3 | [Phase 0] CEF OSR skeleton + null consumer | `engine/src/` |
| 4 | [Phase 0] pipe + preview consumers | `consumers/pipe`, `preview_writer` |
| 5 | [Phase 0] bench harness + mask/alpha scenes | `bench/` |
| 6 | [Phase 0] CasparCG baseline driver (partial) | `run-casparcg-baseline.sh` |
| 7 | [Phase 0] steady-state soak report | PHASE0 bench evidence |

---

## 6. Проверка

```bash
./bench/run-bench.sh 3 60 5

# Mask/alpha A/B, 120s
bg_engine --consumer=null --url=file://.../bench-alpha.html?masks=0 --duration=120
bg_engine --consumer=null --url=file://.../bench-alpha.html?masks=1 --duration=120
```

Dev host: Ubuntu 24.04, 16 cores, 31 GiB RAM, CPU-only engine.

---

## 7. Результаты

### Titulus steady-state (3ch × 60s)

| Метрика | Значение |
|---|---|
| avg fps | **47.88** |
| late / drops | **0** / **0%** |
| p99 interval | ~21.4 ms |
| mask/alpha overhead | **0.7%** (цель ≤5%) |

~48 fps vs 50 — tuning pump/BeginFrame, **не** dropped frames.

### CasparCG baseline

- PLAY подтверждён (`202 PLAY OK`, html producer 1920×1080@50)
- Formal fps/drops **отложен** — CEF GPU-subprocess instability на headless + OSC metrics

---

## 8. Ограничения / отложено

- DeckLink/genlock на dev-хосте отсутствовали → SDI Phase 3
- Closing 47.88→50.0 fps — addressed Phase 10.5b / 11.2
- VM jitter ≠ bare-metal SDI acceptance

---

## 9. Артефакты

| Путь | Роль |
|---|---|
| `bench/run-bench.sh` | Multi-channel harness |
| `bench/run-casparcg-baseline.sh` | CasparCG reference |
| `bench/bench.html`, `bench-alpha.html` | Stress scenes |
| `docs/CASPARRCG_PORTING.md` | Porting map |
| `engine/src/stats.cpp` | SUMMARY format contract |
