# P19 Baseline Report — выполнение doc 00 (G0 + baseline + калибровка cost model)

**Дата:** 2026-07-13
**Оператор:** agent (автоматизированные прогоны)
**Git SHA:** `0deff0c21e642138841c3834b5736270bbbf56e3` (`main` + ветка `bench/phase19-00-baseline`)
**Binary:** `engine/build/Release/bg_engine` (Release, `BG_ENABLE_DECKLINK=ON`, DeckLink SDK 16.0, собран 2026-07-13 16:55)
**Host:** AMD Ryzen 5 3600 (6C/12T, 2×CCX по 3 core / 16 MiB L3), 15 GiB RAM, DeckLink Quad 2, genlock `ref=locked`
**Backend:** изолированный, `PORT=3003 TITULUS_DATA=/tmp/titulus-p19-data`
**Templates:** `tests/templates/test.json` (cheap), `tests/templates/test1.json` (complex, **acceptance target**)
**Raw artifacts:** `engine/research/results/p19/baseline-20260713/`

---

## 1. Gate G0 — методология готова: **PASS**

| Инструмент | Статус | Подтверждение |
|---|---|---|
| `SUMMARY fps` (stats) | OK | все null-прогоны |
| `--frame-log` + `analyze-frame-log.mjs` | OK | percentiles paint_latency/pump_active/paint_seq_delta |
| Chrome trace (`BG_TRACE_SECONDS`) + `parse-chrome-trace.mjs` | OK | `blink-trace.json` 150 MB, 762849 events |
| `telemetry5s` / `stages5s` (DeckLink) | OK | in_fps/d_pairs/d_singles/ref + copy/weave/schedule µs |
| Genlock | OK | `ref=locked` во всех DeckLink-прогонах (первый lock после старта ~5 c: одно окно `d_starved=4`, далее 0) |
| `perf record` | **недоступен** | `perf_event_paranoid=4`, нет root — заменён Chrome trace (см. §4) |

Cheap vs complex A/B воспроизводим (см. §2–§3) → G0 PASS.

## 2. Baseline null (self-timer ~50 Hz, 1ch, cores 0,6,1,7, 75 s, N=3)

| Run | fps | interval p50/p99 µs | late | drops |
|---|---|---|---|---|
| cheap r1 | 49.96 | 19999 / 20541 | 2 | 0.05% |
| cheap r2 | 49.96 | 19999 / 20856 | 2 | 0.05% |
| cheap r3 | 50.00 | 19998 / 20433 | 0 | 0.00% |
| complex r1 | 38.16 | 20131 / 40173 | 885 | 30.98% |
| complex r2 | 39.74 | 20071 / 40138 | 767 | 25.77% |
| complex r3 | 37.95 | 20122 / 40203 | 897 | 31.56% |

**Null complex (test1) = 37.95–39.74 fps (median 38.16).** Профиль bimodal: p50 interval 20 ms, p99 = 40 ms — каждый ~3-й paint пропускает слот.

Мультиканальный якорь `bench/run-bench.sh 3 60 5` (bench.html, graphics=5): ch0=50.00 / ch1=49.07 / ch2=49.97 fps, cpu_used=99.5%.

## 3. Baseline DeckLink (HD1080i50, keyer=fill_only, genlock locked)

Median по 5-секундным окнам (warmup 2 окна отброшено):

| Run | cores | in_fps | d_pairs/5s | d_singles/5s | late/drop | copy avg µs | weave avg µs (max) | paint_lat p50/p95 µs |
|---|---|---|---|---|---|---|---|---|
| cheap 1ch (dev 1) | 0,6,1,7 | **50.0** | 125.5 | 0 | 0/0 | 790 | 723 (955) | 5776 / 5950 |
| complex 1ch (dev 1) | 0,6,1,7 | **41.7** | 82.5 | 43 | 0/0 | 805 | 830 (1534) | 20095 / 21812 |
| complex 3ch A (dev 1) | 0,6,1,7 | **26.2** | 6 | 119 | 0/0 | 1288 | 1118 (5345) | 20075 / 21777 |
| complex 3ch B (dev 2) | 2,8,3,9 | **25.2** | 1 | 124 | 0/0 | 1377 | 1216 (4860) | 20066 / 20175 |
| complex 3ch C (dev 3) | 4,10,5,11 | **26.0** | 5 | 120 | 0/0 | 1320 | 968 (6123) | 20077 / 20657 |

## 4. Chrome trace (complex, null, 15 s, cores 0,6,1,7)

`trace-complex-1ch-summary.txt`; 599 unique drawFrames за 15 s (≈40/s):

| Метрика | Значение |
|---|---|
| raster.task CPU-sum | 17 472 ms (≈**29.2 ms CPU-sum на unique paint**) |
| raster.drawFrame wall | 10 169 ms (≈**17.0 ms на unique paint**) |
| layout.updateLayout | 874 ms total (~1.5 ms/frame) |
| style.recalc | 820 ms total (~1.4 ms/frame) |
| Paint record | 770 ms total |
| Heavy frames (raster > 2×p50) | 62 из 1800 BeginMainFrame, до 232 ms |

**Raster доминирует над style+layout+paint в ~7–20×.** `perf record` недоступен (paranoid=4), но trace даёт ту же атрибуцию.

## 5. Калиброванный cost model (заполнение §8.1 / App P doc 00)

| Stage | Planning (doc 00) | **MEASURED 1ch complex** | **MEASURED 3ch complex** | Multiplier |
|---|---|---|---|---|
| S3 Raster (Skia CPU) | 5000–16000 µs | ≈17000 µs wall (29200 µs CPU-sum) | — (см. in_fps collapse) | — |
| S6 C2 queue copy | 400–2000 µs | 805 µs avg | 1328 µs avg (max 3205) | **×1.65** |
| S7 Weave | 800–4000 µs | 830 µs avg | 1100 µs avg (max 6123) | **×1.33** |
| S8 Schedule | 20–200 µs | 857 µs avg | 700 µs avg | ~×1 |
| paint_latency (tick→delivery) | target p95 ≤16000 | p50 20095 / **p95 21812** | p50 ≈20070 / p95 ≈20900 | clamp у field budget |

Замечания к калибровке:

- `paint_latency_us` в DL-ветке фактически **упирается в field deadline 20 ms** (p50 = 20.1 ms) — измерение clamp'ится дедлайном, реальная стоимость paint видна из trace (~17 ms wall, 29 ms CPU-sum).
- S8 Schedule заметно дороже planning-оценки (700–860 µs vs 20–200) — вероятно, включает driver call под нагрузкой; не критично (≈2% budget), но учесть в doc 03.
- S5 C1 (FrameRing memcpy) отдельно не инструментирован — в doc 03 добавить счётчик.

### Required speedup (App C.2)

```text
c (paint p95, 1ch complex)      = 21.8 ms
copies + slack                  ≈ 4 ms
dual-pack требование            : c' ≤ 16 ms  → speedup ≥ 1.36×
здоровая цель (p95 ≤ 12 ms)     : speedup ≥ 1.82×
плюс 3ch contention (in_fps ×0.62 при 3ch) → реальная цель ближе к ×2 на raster path
```

## 6. Классификация прогонов (App L)

| Run | Classifier |
|---|---|
| dl-cheap-1ch | **TRUE_50P_AS_50I** |
| dl-complex-1ch | MIXED_INVESTIGATE (41.7 in_fps: между 25 и 50, paint у budget) |
| dl-complex-3ch A/B/C | **PAINT_BOUND_25P** |

## 7. Вердикт по decision tree §4.5

1. `ref=locked` — timing валиден.
2. Cheap ≈50 на null и DeckLink → pump/BF/OSR-путь здоров.
3. Complex: `paint_latency p50 > 12000` (фактически ≥20000) → **PRIMARY: reduce frame cost** (H1). Trace подтверждает: bottleneck — raster.task.
4. 3ch: copy ×1.65, weave ×1.33, weave max 6.1 ms → **secondary bandwidth contention реален** (H2, doc 03), включается когда 3 канала растеризуют одновременно.

**Отличие от исторических данных (re-verify выполнен):** 1ch complex теперь даёт **41.7 in_fps** (исторически ~25), null complex **~38.6 fps** (исторически ~27). Потолок «~25» на текущем дереве наблюдается **только при 3ch** — вклад multi-channel contention больше, чем считалось. Вероятная причина улучшения 1ch: Class A composited positions (Phase 16) уже в main + 4 logical cores на прогон.

### Next action

**Doc 01 (Blink/Skia raster cost reduction)** — приоритет: снизить raster wall ~17 ms → ≤12 ms (×1.4–1.8). Параллельно после GATE-01: doc 03 (память: C1-инструментация, fewer-copy — уже видимый ×1.65 рост на 3ch) и doc 04 (pinning/CCX: 3ch B на CCX-границе 2,8,3,9 показал худший in_fps 25.2).

## 8. Ограничения baseline

- `perf record` недоступен без root (`perf_event_paranoid=4`) — компенсирован Chrome trace.
- IDE/agent-сессия шла на том же хосте (не на измеряемых ядрах в 1ch-прогонах; при 3ch заняты все ядра — фон отмечен).
- N=3 только для null; DeckLink-прогоны по одному на конфигурацию (90 s окно для 3ch); для gate-прогонов G1/G2 нужен N=3 и ≥60 s steady + визуальная проверка.
- Chrome trace снят на null consumer (не DeckLink), 15 s window.

## 9. Run sheet (App N)

```text
[x] Date / operator / sha: 2026-07-13 / agent / 0deff0c
[x] Hardware confirmed: Ryzen 5 3600, Quad 2, genlock locked
[x] Engines cleared before runs (pgrep verified)
[x] Binary: engine/build/Release/bg_engine (rebuilt)
[x] Templates: tests/templates/test.json / test1.json
[x] Channels + masks: 1ch 0,6,1,7; 3ch A=0,6,1,7 B=2,8,3,9 C=4,10,5,11
[x] Duration: null 75s ×3; DL 1ch 75s; DL 3ch 90s
[x] Artifacts: engine/research/results/p19/baseline-20260713/
[x] Cheap canary: PASS (50 fps, pairs 125.5, singles 0)
[x] Complex metrics: см. §2–§3
[x] Verdict: PAINT_BOUND (3ch) / MIXED (1ch) — PRIMARY H1, secondary H2
[x] Next action: doc 01; затем 03/04 параллельно
```
