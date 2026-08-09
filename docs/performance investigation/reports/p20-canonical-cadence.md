# P20 canonical cadence — evidence

Дата: 2026-08-09. Цель — отличать доставку 50 Hz от 50 уникальных логических
поз и проверять P20.3 через одну воспроизводимую методику.

## Контракт ячейки

`engine/research/p20/run-p20-cell.sh` — единственный entrypoint для `1ch` и
`3ch`. До запуска он создаёт `manifest.json` и `chN/manifest.json` с
`configDigest`; digest содержит Git/diff, SHA engine/runtime/template, URL,
mode/keyer/fps, CPU/device map, flags и pacing mode. В артефакты не входят PID,
время создания или пути run directory.

Для всех 3ch cells используются только disjoint masks:

- ch1: `0,6,1,7`;
- ch2: `2,8,3,9`;
- ch3: `4,10,5,11`.

Execute-order: preflight без существующих engine → spawn process groups →
все `started` и `reference signal locked` → TAKE marker на все каналы →
60 s warm-up → 60 s measurement → process-group cleanup.

`analyze-p20-cadence.mjs` читает FrameLog v2 после явного
`measurement.startUnixUs`. Он декуплицирует runtime event, считает соседние
`ticks_per_raf`, logical pose rate (`logical_frame_after` delta > 0) и отдельно
CEF/publish rates. Концевую неполную CSV строку после controlled shutdown
помечает и исключает; неполная строка не в EOF либо противоречивая provenance
остаётся ошибкой.

## Hardware evidence

Все runs: 3ch, `HD1080i50`, `fill_only`, `layered=off`, raster threads `3`,
P20 moving marker, 60 s warm-up + 60 s measure. Артефакты лежат локально в
`/tmp/titulus-p20-canonical/`; точные flags, SHA и timestamps записаны в каждом
manifest.

### Matrix

- **A / canonical pins** (`A-20260809T152844Z`): ch1 49.928, ch2 25.320,
  ch3 49.765 logical poses/s; CEF/publish около 50 на всех. Исходная
  асимметрия воспроизведена.
- **B / swap masks** (`B-20260809T153145Z`): ch1 (получил mask ch2) 25.034,
  ch2 (получил mask ch1) 49.915, ch3 49.884. Аттрактор последовал за mask в
  этом контроле.
- **C / swap devices** (`C-20260809T153357Z`): ch1 25.014, ch2 25.115,
  ch3 44.986. Простая перестановка slots не устранила дефект; результат не
  поддерживает единственную device-only причину.
- **D / start stagger 0/5/10 ms** (`D-20260809T153612Z`): ch1 49.925,
  ch2 46.019, ch3 26.182. Start phase меняет выбранный cadence attractor.

Итог matrix: wall-time accumulator способен выбирать `(1,1)` и `(2,0)`
semantic cadence при одинаковой delivery rate; CPU/device/start phase влияют
на выбор. `in_fps≈50` нельзя использовать как visual verdict.

### P20.3 one-tick A/B

- **A accumulator** (`P203-A-20260809T153934Z`): ch1 49.909, ch2 32.676,
  ch3 43.409 poses/s; CEF/publish 49.933–50.000 Hz.
- **B one_tick** (`P203-B-20260809T154146Z`): ch1 49.982, ch2 49.966,
  ch3 49.994 poses/s; `(1,1)=1.0000`, `(2,0)=0.0000`, CEF/publish
  49.982–50.000 Hz.

P20.3 pass: one logical tick per observed BeginFrame removes measured
multi-channel 2/0 semantic cadence in the canonical 60 s cell. Режим
development-only, opt-in через `pacing_mode=one_tick`; default остаётся
`accumulator`, поэтому browser/stream path и существующие URL не изменены.

## Проверка

- RED: отсутствующий `run-p20-cell.sh`, отсутствующий
  `analyze-p20-cadence.mjs`, отсутствующий `fixedPacing.ts`; затем все
  соответствующие tests GREEN.
- `node --test engine/research/p20/tests/*.mjs engine/research/tests/test_analyze_microfreeze.mjs`:
  18 PASS.
- `cd runtime && npm test && npm run typecheck`: 32 PASS, typecheck PASS.
- `cd runtime && npm run build`: PASS, `backend/public/bg-runtime.js` rebuilt.
- `cmake --build engine/build --target bg_engine -j2`: PASS.
- `ctest --test-dir engine/tests/build-p20 --output-on-failure`: 5/5 PASS.

## Remaining uncertainty

Каждая hardware capture получила один обрезанный EOF CSV record при teardown;
полные предыдущие records сохранены, а детектор не скрывает этот факт. В engine
logs также остаётся повторяющийся `*** stack smashing detected ***` от CEF
helper-side process. Canonical artifacts содержат PID/PPID snapshots, но
evidence не устанавливает причинную связь этого сигнала с cadence: one-tick
pass получен при сохранении сигнала. Его нужно расследовать отдельно.
