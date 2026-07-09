# Phase 18 — True 50p Progressive Pipeline

**Дата:** 2026-07-09  
**Ветка:** `feature/phase-18-true-50p`  
**Decision Gate:** [phase-18-decision.md](phase-18-decision.md)  
**Артефакты замеров:** `engine/research/results/p18/`

## Цель

Довести SDI 1080i50 с «25p-as-50i» (оба поля пары из одного bitmap, `d_pairs≈0`) до настоящего временного разрешения 50 (два разных bitmap на пару полей, `in_fps≈50`, плавное движение на мониторе).

## Итог (честный)

| Цель | Результат |
|---|---|
| True 50p на `test1` (3ch) | **Не достигнуто** — steady-state `in_fps≈25`, `d_pairs` avg ~1.6–2.8 / 5с (как Phase 17) |
| Hard SDI health (`d_late`/`d_dropped`) | **OK** — 0/0 на всех каналах soak |
| Empty / cheap content | **True 50p уже работает** — `in_fps≈50`, `d_pairs≈125` / 5с (подтверждено до take `test1`) |
| CEF dual BeginFrame pipeline (Approach A) | **Опровергнуто** — P0.2: 0% тиков с ≥2 уникальными OnPaint |
| Sequential 2-raster в 20 мс поле (Approach B) | **Не обоснован** — P0.1: raster budget не ≤10 мс |

**Вердикт фазы:** Fallback реализован и безопасен (null без регрессии; DeckLink без late/drop). На сложном `test1` потолок остаётся **content/raster-bound ~25 unique fps**, не pump-pacing. True 50p на `test1` требует дальнейшего снижения стоимости кадра (Phase 19 cost model / template work) или иного CEF/OSR пути — не ещё одного pump-трюка.

## P0 — Измерения

### P0.1 Raster budget

См. `engine/research/results/p18/p01-raster-budget.md`.

- Headless `test1` ~27 fps; RasterTask CPU-sum ~13.5 мс/frame; Phase-15 rasterMs p95 ~191 мс (sum).
- Вердикт: **не ≤10 мс** → классический Approach B отвергнут.

### P0.2 CEF in-flight BeginFrame

См. `engine/research/results/p18/p02-inflight-probe.md`.

- Env `BG_P18_PIPELINE_PROBE=1`: два `SendExternalBeginFrame` без wait.
- `pctTicksDeltaGe2 = 0%` на 3×60 с → CEF **коалесцирует** dual BF.
- Approach A отвергнут. Probe поднял null fps ~34→~39 (pacing-эффект без двух paint).

### P0.3 IPC vs raster

См. `engine/research/results/p18/p03-ipc-breakdown.md`.

- Mojo Σ dur ≪ RasterTask (~23×). Bottleneck не Mojo IPC.

## P1 — Decision Gate

**Fallback — eager sequential field packing** (не A, не классический B).

Документ: [phase-18-decision.md](phase-18-decision.md).

## P2 — Реализация

1. **`engine/src/main.cpp` (только `decklink_driven`):** убран post-paint sleep до `tick_deadline` между sub-tick’ами одной пары `WaitForTick`. После доставки paint сразу стартует следующий BeginFrame (последовательный, не in-flight dual). Self-timer / null path не изменён (кроме уже существующего probe за env).
2. **`decklink_consumer.cpp`:** `kMaxQueuedFrames` 2 → 3 (запас под burst двух bitmap).
3. **Null sanity:** fps 38–39 vs control 34 — без регрессии (`p2-null-sanity.md`).

Weave при `fresh==2` уже корректно плёл два bitmap (Phase 10/11) — менять не пришлось.

## P3 — Валидация DeckLink

### P3.1 Single channel (device 1, test1, ~60 с)

`p31-single-decklink.md`: `d_late=0`, `d_dropped=0`, `in_fps` avg 25.3, `d_pairs` avg 1.58 — **как P17**, не lift.

### P3.2 3-channel soak ~18 мин

`p32-soak-3ch.md`:

| Ch | in_fps avg | d_pairs avg | late/drop |
|---|---:|---:|---|
| 1 | 24.93 (dips to 23) | 2.82 | 0/0 |
| 2 | 25.06 | 2.01 | 0/0 |
| 3 | 25.10 | 1.62 | 0/0 |

Ch1 показал поздний dip (не регрессия late/drop). `d_pairs` без заметного роста vs P17.

### P3.3 Визуальная проверка

**2026-07-09, пользователь (TV Logic):** на `test1` 3ch — **«без разницы»** vs до Phase 18. Согласуется с метриками (`d_pairs` как P17, ~25p-as-50i). Empty/cheap true field pairs на глаз в этом прогоне не сравнивались.

## Корневой вывод

```
empty / cheap  → in_fps≈50, d_pairs≈125  → true 50p-as-50i УЖЕ есть
test1 (сложный) → in_fps≈25, d_pairs≈0–3 → CEF не успевает 2-й unique paint за 40 мс output frame
```

Phase 17 был прав: DeckLink path latency-bound на уровне **стоимости кадра**, не «мало raster threads». Phase 18 доказал дополнительно:

1. CEF OSR этой сборки **не** пипелайнит два BeginFrame.
2. Убрать idle sleep между полями **недостаточно**, если один raster уже съедает ~весь field budget.
3. Weave/queue готовы к 50p; блокер — Blink/Skia cost на `test1`.

## Что дальше (не Phase 18)

- Phase 19: Style Guide + cost model — снижать стоимость шаблонов до уровня `test`.
- Повторный true-50p gate, когда headless/`null` `test1` стабильно ≥45–50 fps.
- Не открывать снова dual-BeginFrame pipeline без новой CEF-версии + повтор P0.2.

## Файлы

| Путь | Изменение |
|---|---|
| `engine/src/main.cpp` | Fallback eager packing + P0.2 probe (env) |
| `engine/src/consumers/decklink_consumer.cpp` | `kMaxQueuedFrames=3` |
| `engine/src/frame_log.*` | колонки `inflight_depth`, `paint_seq_delta` (P0.2) |
| `docs/development-phases/phase-18-decision.md` | Decision Gate |
| `docs/development-phases/phase-18-true-50p-pipeline.md` | этот отчёт |
| `engine/research/results/p18/*` | P0–P3 отчёты и JSON |

## Rollback

```bash
git revert <merge-commit>
```

Либо откатить только pump-патч в `main.cpp` (вернуть post-paint sleep) и `kMaxQueuedFrames` → 2.
