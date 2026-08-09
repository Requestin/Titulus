# P20.1 M0 — provenance readiness evidence

Дата: 2026-08-09. Это проверка evidence plane, а не visual acceptance или
доказательство порядка полей на проводе. Все DeckLink прогоны используют
`HD1080i50`, `fill_only`, `layered=off`, P20 moving marker, device index 1–3,
канонические непересекающиеся CPU masks и Reference In.

## Контракт и метод

Единый запуск — `engine/research/p20/run-p20-cell.sh`. Он создаёт manifest с
config digest, не допускает параллельный Titulus engine и завершает процесс
через его собственный `--duration`; это даёт `FrameLog` и
`DecklinkEventLog` нормально сбросить буферы. `TERM` остаётся только аварийным
fallback и не считается evidence.

`--provenance=off` выключает P20 runtime `BGPACING` и DeckLink event CSV. Для
сопоставимого p95 в обоих плечах остаётся общий `FrameLog`; поэтому A/B
изолирует стоимость именно P20 runtime/completion provenance, а не удаляет
сам измерительный прибор.

`analyze-p20-m0.mjs` требует:

- неубывающие `unix_us` и `mono_us` в event CSV;
- один schedule на completion, кроме трёх `schedule_seq=0` preroll completion;
- только непрерывный tail до трёх неполучивших completion schedules при
  контролируемом завершении;
- adjacent source IDs в каждом `pair`;
- нулевые `late`, `dropped`, `flushed`, `event_overflow`;
- точное соответствие telemetry `overwrite` количеству явных
  `input_overwrite` event.

Между двумя соседними pair source IDs нельзя автоматически выводить overwrite:
source sequence отражает render publication и может иметь gap до очереди.
Потеря именно в bounded DeckLink queue теперь записывается отдельным event с
source ID.

## 1ch instrumentation overhead A/B

Артефакты: `/tmp/titulus-p20-m0/overhead-off-20260809T160452Z/` и
`/tmp/titulus-p20-m0/overhead-on-20260809T160916Z/`.

Общее: channel/device `1`, pin `0,6,1,7`, accumulator, 10 s warm-up и 120 s
measure. На момент run engine был
`3e9890792ce56d0f92bffbb5265493f383c9ab90bb8a831d50cb137255207b49`;
каждый manifest сохраняет полный SHA/config digest.

| Вариант | `pump_active_us` p95 | `paint_latency_us` p95 | DeckLink health |
|---|---:|---:|---|
| provenance OFF | 1.255 ms | 6.391 ms | late/drop/flush=0, overflow=0 |
| provenance ON | 1.462 ms | 6.536 ms | late/drop/flush=0, overflow=0 |

Изменение pump p95: `+0.207 ms`. Контракт P20.1 допускает максимум из `5%`
и `0.5 ms`; это `0.5 ms`, следовательно A/B PASS. В OFF telemetry сообщила
два queue overwrite, в ON — один, причём ON event CSV записал ровно один
`input_overwrite`; это наблюдаемая queue policy, не скрытая logger loss.
Ни в одном run не найден `ref=UNLOCKED`.

## 3ch M0

Артефакты: `/tmp/titulus-p20-m0/three-channel-20260809T161420Z/`;
config digest
`4f5e0e9f6953af31408a77b7d93a206e10a427e53a6c69ca4084bd3564224b31`.
Параметры: accumulator (намеренно не `one_tick`), provenance ON, 10 s warm-up,
5 min measure, плюс 60 s graceful flush tail.

| Channel | schedules | completions | preroll / shutdown tail | overwrite events | Verdict |
|---|---:|---:|---:|---:|---|
| ch1 | 9250 | 9247 | 3 / 3 | 0 | PASS |
| ch2 | 9250 | 9247 | 3 / 3 | 2 | PASS |
| ch3 | 9249 | 9246 | 3 / 3 | 1 | PASS |

Все три verifier reports: zero `late/drop/flush`, zero logger overflow,
monotonic event clocks, complete schedule→completion provenance с допустимым
controlled-shutdown tail. `input_overwrite` совпадает с consumer telemetry
для ch2/ch3, поэтому source queue loss измерим и не маскируется.
`ref=UNLOCKED` в logs отсутствует.

Это M0 PASS: provenance и detector готовы к attribution. Это не отменяет
известный systematic accumulator cadence: тот же 3ch run дал 25.002 logical
poses/s на ch1 при CEF/publish 49.971 Hz, тогда как ch2/ch3 дали
49.948/49.797 poses/s. Поэтому `one_tick` остаётся необходимым dev-only
контролем до L1 on-wire проверки.

## Проверка tooling

- `node --test engine/research/p20/tests/*.mjs
  engine/research/tests/test_analyze_microfreeze.mjs`: 22 PASS;
- `cd runtime && npm test && npm run typecheck`: 32 PASS, typecheck PASS;
- `cmake --build engine/tests/build-p20 --target test_pacing -j$(nproc)` и
  `engine/tests/build-p20/test_pacing`: 6 PASS;
- `cmake --build engine/build --target bg_engine -j$(nproc)`: PASS.

## Границы вывода

M0 не захватывает SDI input и не может утверждать TFF/BFF или semantic order
после wire. `FrameLog`/completion health также не являются visual verdict.
Следующий обязательный шаг — безопасный L0 loopback с оператором, затем L1
one-tick capture.
