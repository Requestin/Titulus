# P21.0 — current-main baseline

**Дата:** 2026-08-23

**Статус:** PASS для короткого P21 baseline; не является soak/on-wire closure

**Scope:** software gates и `p20-test1-visual` на current `main`,
`layered=OFF`, `one_tick`, provenance ON.

## Идентичность baseline

| Объект | Ревизия / SHA-256 |
|---|---|
| Branch base, HEAD, `origin/main` | `91a5563770430b7558c856a92fdf5fc3a4db5c4a` |
| Read-only `origin/sergey-v1` | `7ca8823633b6a47e963f1b3377dcb0758d9734e9` |
| Merge base | `d396ede18d0556320e522433dab5627549311123` |
| Engine binary | `c9056983f6c87235f090216b1d38361d4381424b6a1700ebbfb8045c1f9c537b` |
| Runtime bundle | `28091fbd99d7c978bf8da92b6c2d88f2ca412f340bbbd781074b55f3286367c7` |
| CEF distribution | `151.3.16+gbe1e15d+chromium-151.0.7922.109` (extracted minimal tree; source archive not retained, archive SHA unavailable) |
| `p20-test1-visual` template | `d320fe9a82c37e231387f83eacbff6eef3c66f25ad8f464458332e2a77e6478b` |

## Среда и wiring

- Intel Core i7-14700KF. Null 1ch/3ch и DeckLink 1ch были сняты на kernel
  `7.0.0-28-generic`; финальный DeckLink 3ch после перестановки платы — на
  `7.0.0-30-generic`. Engine/runtime/template hashes не изменились.
- Blackmagic Desktop Video `16.0a14`.
- NVIDIA RTX A4000, driver `610.43.02`.
- CPU masks: ch1 `0-3`, ch2 `4-7`, ch3 `8-11`.
- DeckLink после перестановки: PCIe x4 @ 5 GT/s.
- Connector map: port 1 — reference; port 5 — device 1, loopback в port 6;
  port 7 — device 2 visual; port 9 — device 3 visual.
- Все валидные live cells: warmup 10 s, measurement 225 s, HD1080i50.

## T0 software gates

| Gate | Результат |
|---|---|
| Runtime | 38/38; typecheck PASS; build PASS |
| Frontend | 12/12; typecheck PASS; build PASS |
| Backend | 7/7 |
| Root | 6/6 |
| CPU planner | 6/6 |
| Engine CTest | 5/5 |

## Измеренный baseline

| Cell | Результат |
|---|---|
| Null 1ch | 49.962 poses/s |
| Null 3ch | 49.901 / 49.948 / 49.982 poses/s |
| DeckLink 1ch, device 2 | 49.992 poses/s; zero late/drop/flush; 3 `single`, 2 `input_overwrite`; operator PASS |
| DeckLink 3ch, PCIe x4 | 49.994 / 49.990 / 49.990 poses/s; `(1,1)=100%`, `(2,0)=0`; operator PASS на всех трёх outputs |

В финальном 3ch x4 cell каждый канал дал по 5,625 measured completion и
5,625 schedule rows с `result=0`; late/drop/flush были нулевыми. При старте
каждый endpoint зафиксировал переход reference `0→1` примерно за 13.8 s до
начала measurement; внутри measurement reference transitions отсутствовали,
а periodic telemetry оставалась `ref=locked`. Измеренный residual envelope
не скрывается:

| Channel | Residual events |
|---|---|
| ch1 | 2 `single`, 1 `input_overwrite` |
| ch2 | 2 `single`, 1 `starved`, 2 `input_overwrite` |
| ch3 | 2 `single`, 1 `starved`, 2 `input_overwrite` |

Оператор подтвердил плавное изображение на всех трёх выходах: PASS.

## PCIe diagnosis

Первый 3ch DeckLink запуск в слоте x1 дал примерно 50.0 / 38.8 / 38.8
poses/s и не прошёл baseline. Контрольная ротация устройств подтвердила PCIe
x1 как bottleneck. После переноса платы в x4 @ 5 GT/s все три канала
восстановились до 49.994 / 49.990 / 49.990 poses/s. Поэтому x1 результат
сохранён как диагностическое свидетельство, а принятым hardware baseline
является финальный x4 cell.

## Границы и evidence

Все live measurements короче пяти минут. Этот P21.0 результат фиксирует
повторяемую точку сравнения перед designer changes, но не заявляет длительный
soak или формальный zero-anomaly on-wire verdict. `layered` оставался OFF,
`one_tick` и provenance — ON.

Raw evidence:

```text
/home/requestin/Titulus-evidence/p21-baseline
/home/requestin/Titulus-evidence/p21-baseline/software-t0-20260823
/home/requestin/Titulus-evidence/p21-baseline/operator-verdict.json
```

Operational auth files (`token`, `login.json`) не являются evidence и не
должны копироваться или публиковаться вместе с artifacts.
